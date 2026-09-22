import { createClient } from "npm:@supabase/supabase-js@2.95.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
});

class HttpError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

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

function requiredEnv(name: string) {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new HttpError(`Configuração ausente no Supabase: ${name}`, 500);
  return value;
}

function defaultKey(jsonName: string, legacyName: string) {
  const keys = Deno.env.get(jsonName);
  if (keys) {
    const value = JSON.parse(keys)?.default;
    if (value) return String(value);
  }
  return requiredEnv(legacyName);
}

function base64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function encryptionKey() {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(requiredEnv("EMAIL_CREDENTIALS_ENCRYPTION_KEY")),
  );
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function encryptPassword(password: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encryptedWithTag = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, tagLength: 128 },
    await encryptionKey(),
    new TextEncoder().encode(password),
  ));
  const encrypted = encryptedWithTag.slice(0, -16);
  const tag = encryptedWithTag.slice(-16);
  return [iv, tag, encrypted].map(base64Url).join(".");
}

async function decryptPassword(payload: string) {
  const [ivText, tagText, encryptedText] = payload.split(".");
  if (!ivText || !tagText || !encryptedText) throw new Error("Credencial criptografada inválida.");
  const iv = fromBase64Url(ivText);
  const tag = fromBase64Url(tagText);
  const encrypted = fromBase64Url(encryptedText);
  const combined = new Uint8Array(encrypted.length + tag.length);
  combined.set(encrypted);
  combined.set(tag, encrypted.length);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv, tagLength: 128 },
    await encryptionKey(),
    combined,
  );
  return new TextDecoder().decode(plain);
}

function randomIndex(max: number) {
  const limit = 256 - (256 % max);
  let value = 256;
  while (value >= limit) value = crypto.getRandomValues(new Uint8Array(1))[0];
  return value % max;
}

function securePassword() {
  const groups = ["ABCDEFGHJKLMNPQRSTUVWXYZ", "abcdefghijkmnopqrstuvwxyz", "23456789", "!@#$%&*_-" ];
  const chars = groups.map((group) => group[randomIndex(group.length)]);
  const alphabet = groups.join("");
  while (chars.length < 20) chars.push(alphabet[randomIndex(alphabet.length)]);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomIndex(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

async function publicAccount(row: EmailAccountRow) {
  return {
    id: row.id,
    cnpj: row.company_id,
    deliveryId: row.delivery_id,
    client: row.client_name,
    email: row.email,
    password: await decryptPassword(row.password_ciphertext),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function cpanelCall<T>(operation: string, params: Record<string, string>) {
  const url = new URL(requiredEnv("CPANEL_BASE_URL"));
  if (url.protocol !== "https:") throw new HttpError("CPANEL_BASE_URL deve usar HTTPS.", 500);
  url.pathname = `/execute/Email/${operation}`;
  url.search = new URLSearchParams(params).toString();
  const response = await fetch(url, {
    headers: {
      Authorization: `cpanel ${requiredEnv("CPANEL_USERNAME")}:${requiredEnv("CPANEL_API_TOKEN")}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.json().catch(() => null) as CpanelResponse<T> | null;
  if (!response.ok || !body || body.status !== 1) {
    const message = body?.errors?.filter(Boolean).join("; ") || `HostGator respondeu ${response.status}`;
    throw new HttpError(message, 502);
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (!["GET", "POST"].includes(req.method)) return json({ error: "Método não permitido." }, 405);

  try {
    const supabaseUrl = requiredEnv("SUPABASE_URL");
    const anonKey = defaultKey("SUPABASE_PUBLISHABLE_KEYS", "SUPABASE_ANON_KEY");
    const serviceKey = defaultKey("SUPABASE_SECRET_KEYS", "SUPABASE_SERVICE_ROLE_KEY");
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    if (!token) throw new HttpError("Sessão obrigatória.", 401);

    const authClient = createClient(supabaseUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: authData, error: authError } = await authClient.auth.getUser(token);
    if (authError || !authData.user) throw new HttpError("Sessão inválida ou expirada.", 401);

    const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: actor, error: actorError } = await admin.from("profiles")
      .select("id, status").eq("auth_user_id", authData.user.id).maybeSingle();
    if (actorError) throw actorError;
    if (!actor || actor.status !== "active") throw new HttpError("Usuário sem acesso ativo ao CRM.", 403);

    if (req.method === "GET") {
      const { data, error } = await admin.from("client_email_accounts").select("*").order("created_at", { ascending: false });
      if (error) throw error;
      return json({ accounts: await Promise.all((data || []).map((row) => publicAccount(row as EmailAccountRow))) });
    }

    const input = await req.json().catch(() => ({})) as { deliveryId?: string; companyId?: string };
    let delivery: { id: string; company_id: string | null; client_name: string | null } | null = null;
    if (input.deliveryId) {
      const result = await admin.from("deliveries").select("id, company_id, client_name").eq("id", input.deliveryId).maybeSingle();
      if (result.error) throw result.error;
      delivery = result.data;
      if (!delivery) throw new HttpError("Entrega não encontrada.", 404);
    }

    const companyId = String(delivery?.company_id || input.companyId || "").trim();
    const cnpj = companyId.replace(/\D/g, "");
    if (cnpj.length !== 14) throw new HttpError("A empresa da entrega precisa ter um CNPJ válido com 14 dígitos.");

    const companyResult = await admin.from("companies").select("tax_id, trade_name, legal_name").eq("tax_id", companyId).maybeSingle();
    if (companyResult.error) throw companyResult.error;
    if (!companyResult.data) throw new HttpError("Empresa do CNPJ informado não encontrada.", 404);
    const company = companyResult.data;

    const domain = (Deno.env.get("CPANEL_EMAIL_DOMAIN") || "ecommerce365.com.br").trim().toLowerCase();
    const localPart = cnpj.slice(0, 8);
    const email = `${localPart}@${domain}`;
    const existingResult = await admin.from("client_email_accounts").select("*").eq("email", email).maybeSingle();
    if (existingResult.error) throw existingResult.error;
    if (existingResult.data) return json({ status: "existing", account: await publicAccount(existingResult.data as EmailAccountRow) });

    if (await cpanelMailboxExists(localPart, domain)) {
      throw new HttpError(`O e-mail ${email} já existe na HostGator, mas a senha não está registrada no CRM.`, 409);
    }

    const password = securePassword();
    const configuredQuota = Number(Deno.env.get("CPANEL_EMAIL_QUOTA_MB") || 250);
    const quota = String(Number.isInteger(configuredQuota) && configuredQuota >= 0 ? configuredQuota : 250);
    await cpanelCall("add_pop", { domain, email: localPart, password, quota });

    const record = {
      company_id: company.tax_id,
      delivery_id: delivery?.id || null,
      client_name: delivery?.client_name || company.trade_name || company.legal_name || "Cliente",
      email,
      password_ciphertext: await encryptPassword(password),
      created_by: authData.user.id,
    };
    const saved = await admin.from("client_email_accounts").insert(record).select("*").single();
    if (saved.error) {
      await cpanelCall("delete_pop", { domain, email: localPart }).catch(() => undefined);
      throw saved.error;
    }
    return json({ status: "created", account: await publicAccount(saved.data as EmailAccountRow) }, 201);
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    return json({ error: error instanceof Error ? error.message : "Erro interno." }, status);
  }
});
