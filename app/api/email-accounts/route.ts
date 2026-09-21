import { createCipheriv, createDecipheriv, createHash, randomBytes, randomInt } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

import { legacyConfig } from "@/components/legacy-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type EmailAccountRow = {
  id: string;
  company_id: string;
  delivery_id: string | null;
  client_name: string;
  email: string;
  password_ciphertext: string;
  created_at: string;
  updated_at: string;
};

type CpanelResponse<T = unknown> = {
  status?: number;
  data?: T;
  errors?: string[] | null;
};

const json = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

function requiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Configuração ausente no servidor: ${name}`);
  return value;
}

function bearerToken(request: NextRequest) {
  const authorization = request.headers.get("authorization") || "";
  return authorization.match(/^Bearer\s+(.+)$/i)?.[1] || "";
}

async function supabaseRequest<T>(path: string, token: string, init: RequestInit = {}) {
  const response = await fetch(`${legacyConfig.url}${path}`, {
    ...init,
    cache: "no-store",
    headers: {
      apikey: legacyConfig.anonKey,
      Authorization: `Bearer ${token}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers || {}),
    },
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Supabase ${response.status}${detail ? `: ${detail.slice(0, 180)}` : ""}`);
  }
  return (response.status === 204 ? null : await response.json()) as T;
}

async function requireActiveUser(request: NextRequest) {
  const token = bearerToken(request);
  if (!token) throw new Response("Sessão ausente.", { status: 401, statusText: "Sessão ausente." });

  const authResponse = await fetch(`${legacyConfig.url}/auth/v1/user`, {
    cache: "no-store",
    headers: { apikey: legacyConfig.anonKey, Authorization: `Bearer ${token}` },
  });
  if (!authResponse.ok) throw new Response("Sessão inválida ou expirada.", { status: 401, statusText: "Sessão inválida ou expirada." });
  const user = (await authResponse.json()) as { id?: string };
  if (!user.id) throw new Response("Usuário inválido.", { status: 401, statusText: "Usuário inválido." });

  const profiles = await supabaseRequest<Array<{ id: string }>>(
    `/rest/v1/profiles?auth_user_id=eq.${encodeURIComponent(user.id)}&status=eq.active&select=id&limit=1`,
    token,
  );
  if (!profiles.length) throw new Response("Usuário sem acesso ativo ao CRM.", { status: 403, statusText: "Usuário sem acesso ativo ao CRM." });
  return { token, userId: user.id };
}

function encryptionKey() {
  return createHash("sha256").update(requiredEnv("EMAIL_CREDENTIALS_ENCRYPTION_KEY"), "utf8").digest();
}

function encryptPassword(password: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(password, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString("base64url")).join(".");
}

function decryptPassword(payload: string) {
  const [ivText, tagText, encryptedText] = payload.split(".");
  if (!ivText || !tagText || !encryptedText) throw new Error("Credencial criptografada inválida.");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivText, "base64url"));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(encryptedText, "base64url")), decipher.final()]).toString("utf8");
}

function securePassword() {
  const groups = ["ABCDEFGHJKLMNPQRSTUVWXYZ", "abcdefghijkmnopqrstuvwxyz", "23456789", "!@#$%&*_-" ];
  const chars = groups.map((group) => group[randomInt(group.length)]);
  const alphabet = groups.join("");
  while (chars.length < 20) chars.push(alphabet[randomInt(alphabet.length)]);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

function publicAccount(row: EmailAccountRow) {
  return {
    id: row.id,
    cnpj: row.company_id,
    deliveryId: row.delivery_id,
    client: row.client_name,
    email: row.email,
    password: decryptPassword(row.password_ciphertext),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function cpanelCall<T>(operation: string, params: Record<string, string>) {
  const url = new URL(requiredEnv("CPANEL_BASE_URL"));
  if (url.protocol !== "https:") throw new Error("CPANEL_BASE_URL deve usar HTTPS.");
  url.pathname = `/execute/Email/${operation}`;
  url.search = new URLSearchParams(params).toString();
  const response = await fetch(url, {
    cache: "no-store",
    headers: {
      Authorization: `cpanel ${requiredEnv("CPANEL_USERNAME")}:${requiredEnv("CPANEL_API_TOKEN")}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await response.json().catch(() => null)) as CpanelResponse<T> | null;
  if (!response.ok || !body || body.status !== 1) {
    const message = body?.errors?.filter(Boolean).join("; ") || `HostGator respondeu ${response.status}`;
    throw new Error(message);
  }
  return body;
}

async function cpanelMailboxExists(localPart: string, domain: string) {
  const response = await cpanelCall<Array<{ email?: string; user?: string }>>("list_pops", { domain });
  return (response.data || []).some((account) => {
    const address = String(account.email || account.user || "").toLowerCase();
    return address === localPart.toLowerCase() || address === `${localPart}@${domain}`.toLowerCase();
  });
}

function responseFromThrown(error: unknown) {
  if (error instanceof Response) return json({ error: error.statusText || "Acesso negado." }, error.status);
  const message = error instanceof Error ? error.message : "Erro inesperado.";
  return json({ error: message }, 500);
}

export async function GET(request: NextRequest) {
  try {
    const { token } = await requireActiveUser(request);
    const rows = await supabaseRequest<EmailAccountRow[]>("/rest/v1/client_email_accounts?select=*&order=created_at.desc", token);
    return json({ accounts: rows.map(publicAccount) });
  } catch (error) {
    return responseFromThrown(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const { token, userId } = await requireActiveUser(request);
    const input = (await request.json().catch(() => ({}))) as { deliveryId?: string; companyId?: string };

    let delivery: { id: string; company_id: string | null; client_name: string | null } | undefined;
    if (input.deliveryId) {
      const deliveries = await supabaseRequest<Array<typeof delivery>>(
        `/rest/v1/deliveries?id=eq.${encodeURIComponent(input.deliveryId)}&select=id,company_id,client_name&limit=1`, token,
      );
      delivery = deliveries[0];
      if (!delivery) return json({ error: "Entrega não encontrada." }, 404);
    }

    const companyId = String(delivery?.company_id || input.companyId || "").trim();
    const cnpj = companyId.replace(/\D/g, "");
    if (cnpj.length !== 14) return json({ error: "A empresa da entrega precisa ter um CNPJ válido com 14 dígitos." }, 400);

    const companies = await supabaseRequest<Array<{ tax_id: string; trade_name: string | null; legal_name: string | null }>>(
      `/rest/v1/companies?tax_id=eq.${encodeURIComponent(companyId)}&select=tax_id,trade_name,legal_name&limit=1`, token,
    );
    const company = companies[0];
    if (!company) return json({ error: "Empresa do CNPJ informado não encontrada." }, 404);

    const domain = (process.env.CPANEL_EMAIL_DOMAIN || "ecommerce365.com.br").trim().toLowerCase();
    const localPart = cnpj.slice(0, 8);
    const email = `${localPart}@${domain}`;
    const existing = await supabaseRequest<EmailAccountRow[]>(
      `/rest/v1/client_email_accounts?email=eq.${encodeURIComponent(email)}&select=*&limit=1`, token,
    );
    if (existing[0]) return json({ status: "existing", account: publicAccount(existing[0]) });

    if (await cpanelMailboxExists(localPart, domain)) {
      return json({ error: `O e-mail ${email} já existe na HostGator, mas a senha não está registrada no CRM.` }, 409);
    }

    const password = securePassword();
    const quota = String(Number(process.env.CPANEL_EMAIL_QUOTA_MB || 250));
    await cpanelCall("add_pop", { domain, email: localPart, password, quota });

    const record = {
      company_id: company.tax_id,
      delivery_id: delivery?.id || null,
      client_name: delivery?.client_name || company.trade_name || company.legal_name || "Cliente",
      email,
      password_ciphertext: encryptPassword(password),
      created_by: userId,
    };
    try {
      const saved = await supabaseRequest<EmailAccountRow[]>("/rest/v1/client_email_accounts", token, {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify(record),
      });
      return json({ status: "created", account: publicAccount(saved[0]) }, 201);
    } catch (databaseError) {
      await cpanelCall("delete_pop", { domain, email: localPart }).catch(() => undefined);
      throw databaseError;
    }
  } catch (error) {
    return responseFromThrown(error);
  }
}
