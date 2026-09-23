"use strict";

const IS_EXTENSION_CONTEXT = Boolean(globalThis.chrome?.runtime?.id);
const APP_VARIANT = IS_EXTENSION_CONTEXT ? "extension" : "web";

// ---------- Config / conexão (config.js ou salvo nas Configurações) ----------
function getCfg() {
  try {
    const ls = JSON.parse(localStorage.getItem("crm_cfg") || "null");
    if (ls && ls.url && ls.anonKey) return ls;
  } catch (e) {}
  return window.CRM_CONFIG || { url: "", anonKey: "" };
}
const isLive = () => {
  const c = getCfg();
  return Boolean(c.url && c.anonKey);
};

// ---------- Autenticação Supabase ----------
const AUTH_SESSION_KEY = "crm_auth_session";
const PRIVACY_CONSENT_KEY = "erc_privacy_consent_v1";
const PRIVACY_VERSION = "2026-09-19";
let currentProfile = null;
function readPrivacyConsent() {
  return new Promise((resolve) => {
    if (globalThis.chrome?.storage?.local) {
      globalThis.chrome.storage.local.get({ [PRIVACY_CONSENT_KEY]: null }, (data) => resolve(data[PRIVACY_CONSENT_KEY]));
      return;
    }
    try { resolve(JSON.parse(localStorage.getItem(PRIVACY_CONSENT_KEY) || "null")); }
    catch (e) { resolve(null); }
  });
}
function savePrivacyConsent(value) {
  return new Promise((resolve) => {
    if (globalThis.chrome?.storage?.local) {
      globalThis.chrome.storage.local.set({ [PRIVACY_CONSENT_KEY]: value }, resolve);
      return;
    }
    localStorage.setItem(PRIVACY_CONSENT_KEY, JSON.stringify(value));
    resolve();
  });
}
async function ensurePrivacyConsent() {
  const gate = document.getElementById("privacy-gate");
  if (!IS_EXTENSION_CONTEXT) {
    gate.hidden = true;
    return true;
  }
  const current = await readPrivacyConsent();
  if (current?.accepted && current?.version === PRIVACY_VERSION) {
    gate.hidden = true;
    return true;
  }
  gate.hidden = false;
  return new Promise((resolve) => {
    document.getElementById("privacy-accept").onclick = async () => {
      await savePrivacyConsent({ accepted: true, version: PRIVACY_VERSION, accepted_at: new Date().toISOString() });
      gate.hidden = true;
      resolve(true);
    };
    document.getElementById("privacy-decline").onclick = () => {
      document.getElementById("privacy-message").textContent = "O consentimento é necessário para usar a extensão. Nenhuma captura de Reddit ou WhatsApp será ativada sem sua autorização.";
    };
  });
}
function readAuthSession() {
  try { return JSON.parse(localStorage.getItem(AUTH_SESSION_KEY) || "null"); }
  catch (e) { return null; }
}
function storeAuthSession(session) {
  if (!session) { localStorage.removeItem(AUTH_SESSION_KEY); return null; }
  const normalized = {
    ...session,
    expires_at: Number(session.expires_at || Math.floor(Date.now() / 1000) + Number(session.expires_in || 3600))
  };
  localStorage.setItem(AUTH_SESSION_KEY, JSON.stringify(normalized));
  return normalized;
}
async function authRequest(path, body, accessToken = null) {
  const c = getCfg();
  const headers = { apikey: c.anonKey, "Content-Type": "application/json" };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  const res = await fetch(`${c.url}/auth/v1/${path}`, { method: "POST", headers, body: body == null ? undefined : JSON.stringify(body) });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.msg || data?.error_description || data?.message || `Falha de autenticação (${res.status})`);
  }
  return res.status === 204 ? null : res.json();
}
async function getAccessToken() {
  if (!isLive()) return null;
  let session = readAuthSession();
  if (!session?.access_token || !session?.refresh_token) return null;
  if (Number(session.expires_at || 0) > Math.floor(Date.now() / 1000) + 60) return session.access_token;
  try {
    session = storeAuthSession(await authRequest("token?grant_type=refresh_token", { refresh_token: session.refresh_token }));
    return session.access_token;
  } catch (e) {
    storeAuthSession(null);
    return null;
  }
}
function showLogin(message = "") {
  closeModal();
  document.getElementById("boot-gate")?.setAttribute("hidden", "");
  const gate = document.getElementById("auth-gate");
  if (!gate) return;
  gate.hidden = false;
  document.getElementById("login-error").textContent = message;
  document.getElementById("login-password").value = "";
  document.getElementById("login-email").focus();
}
function hideLogin() {
  const gate = document.getElementById("auth-gate");
  if (gate) gate.hidden = true;
}
async function callUserAdmin(action, payload = {}) {
  const c = getCfg();
  const token = await getAccessToken();
  if (!token) throw new Error("Sua sessão expirou. Entre novamente.");
  const res = await fetch(`${c.url}/functions/v1/manage-crm-user`, {
    method: "POST",
    headers: { apikey: c.anonKey, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ action, ...payload })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = data.error || data.message || `Falha ao gerenciar acesso (${res.status})`;
    if (res.status === 403) throw new Error(`${message} Sessão atual: ${currentSessionLabel()}. Saia e entre com o acesso administrador.`);
    throw new Error(message);
  }
  return data;
}
async function signOut() {
  const session = readAuthSession();
  try { if (session?.access_token) await authRequest("logout", null, session.access_token); } catch (e) {}
  storeAuthSession(null);
  currentProfile = null;
  cache = null;
  showLogin("Sessão encerrada.");
}

// ---------- Domínio ----------
// As etapas de negociação não são mais fixas — cada pipeline (tabela
// "pipelines") define sua própria lista de etapas em texto livre, até 5
// pipelines por conta (gerenciado no modal "Pipeline" do rodapé).
const STATUSES = ["open", "won", "lost"];
const STATUS_LABEL = { open: "Aberto", won: "Ganho", lost: "Perdido" };
const PROJECT_STATUSES = ["planned", "in_progress", "done", "canceled"];
const PROJECT_STATUS_LABEL = { planned: "Planejado", in_progress: "Em andamento", done: "Concluído", canceled: "Cancelado" };
const MAX_PIPELINES = 5;
const SOURCES = ["Indicação", "Site", "Anúncio", "Evento", "LinkedIn", "Inbound", "Prospecção", "Outro"];
const RECURRENCE_OPTIONS = [
  ["once", "Única"], ["weekly", "Semanal"], ["biweekly", "Quinzenal"], ["monthly", "Mensal"],
  ["bimonthly", "Bimestral"], ["quarterly", "Trimestral"], ["semiannual", "Semestral"], ["annual", "Anual"]
];
const RECURRENCE_LABEL = Object.fromEntries(RECURRENCE_OPTIONS);
const PRIORITY_OPTIONS = [["low", "Baixa"], ["normal", "Normal"], ["high", "Alta"], ["urgent", "Urgente"]];
const PRIORITY_LABEL = Object.fromEntries(PRIORITY_OPTIONS);
function normalizeIdList(value, fallback = null) {
  let ids = value;
  if (typeof ids === "string") {
    try { ids = JSON.parse(ids); } catch (e) { ids = ids.replace(/^\{|\}$/g, "").split(","); }
  }
  const normalized = Array.isArray(ids) ? [...new Set(ids.map(String).map((id) => id.trim()).filter(Boolean))] : [];
  if (!normalized.length && fallback) normalized.push(String(fallback));
  return normalized;
}
function normalizeTextList(value) {
  let values = value;
  if (typeof values === "string") {
    try { values = JSON.parse(values); } catch (e) { values = values.replace(/^\{|\}$/g, "").split(","); }
  }
  return Array.isArray(values)
    ? [...new Map(values.map((item) => String(item || "").trim()).filter(Boolean).map((item) => [item.toLocaleLowerCase("pt-BR"), item])).values()]
    : [];
}
function priorityBadge(value) {
  const priority = PRIORITY_LABEL[value] ? value : "normal";
  return `<span class="badge priority-badge priority-${priority}">${esc(PRIORITY_LABEL[priority])}</span>`;
}
function normalizeChecklist(value) {
  let rows = value;
  if (typeof rows === "string") {
    try { rows = JSON.parse(rows); } catch (e) { rows = []; }
  }
  if (!Array.isArray(rows)) return [];
  return rows.map((item, index) => {
    if (typeof item === "string") return { id: `legacy-${index}`, text: item.trim(), checked: false };
    return {
      id: item?.id || `legacy-${index}`,
      text: String(item?.text || "").trim(),
      checked: Boolean(item?.checked)
    };
  }).filter((item) => item.text);
}
function mergeTemplateChecklist(templateValue, activityValue) {
  const checkedById = new Map(normalizeChecklist(activityValue).map((item) => [item.id, item.checked]));
  return normalizeChecklist(templateValue).map((item) => ({ ...item, checked: checkedById.get(item.id) || false }));
}
function checklistProgress(value) {
  const items = normalizeChecklist(value);
  return { total: items.length, done: items.filter((item) => item.checked).length };
}
const ENTITY_LABEL = { home: "Home", contacts: "Pessoas", companies: "Empresas", conversations: "Conversas", deals: "Negócios", products: "Produtos", projects: "Entregas", activities: "Tarefas" };
const SINGULAR = { contacts: "pessoa", companies: "empresa", conversations: "conversa", deals: "negócio", products: "produto", projects: "entrega" };
// Abas cujo formulário de cadastro abre em painel lateral (vindo da direita).
const SIDE_PANEL_TABS = new Set(["deals", "products", "projects", "contacts", "companies"]);

// Colunas usadas como chave primária real no banco (Supabase). Tudo que não
// estiver aqui usa "id" como padrão.
const PK_COLUMN = { companies: "tax_id" };
const pk = (tab) => PK_COLUMN[tab] || "id";

// A aba "deals" (Negócios) do app conversa com a tabela "negotiations" no
// Supabase — nome e uma coluna (amount/value) diferem, então a tradução
// fica só aqui, sem espalhar "negotiations" pelo resto do código.
const REMOTE_TABLE = {
  deals: "negotiations",
  users: "profiles",
  projects: "deliveries",
  productActivities: "product_activity_templates",
  productObjectives: "product_objective_templates",
  productGoals: "product_goal_templates",
  deliveryObjectives: "delivery_objectives",
  deliveryGoals: "delivery_goals",
  processes: "training_processes"
};
const remoteTable = (tab) => REMOTE_TABLE[tab] || tab;
const FIELD_REMAP = {
  deals: { amount: "value" },
  activities: { project_id: "delivery_id", group: "group_name", type: "activity_type" },
  deliveryObjectives: { project_id: "delivery_id" },
  deliveryGoals: { project_id: "delivery_id" },
  productActivities: { group: "group_name", type: "activity_type" }
}; // chave local -> chave remota
function toRemoteBody(tab, body) {
  const map = FIELD_REMAP[tab];
  if (!map) return body;
  const out = {};
  for (const [k, v] of Object.entries(body)) out[map[k] || k] = v;
  return out;
}
function fromRemoteRow(tab, row) {
  const map = FIELD_REMAP[tab];
  if (!map || !row) return row;
  const out = { ...row };
  for (const [localKey, remoteKey] of Object.entries(map)) {
    if (remoteKey in out) { out[localKey] = out[remoteKey]; delete out[remoteKey]; }
  }
  return out;
}

// ---------- Dados de exemplo (mutáveis em memória quando offline) ----------
const DEMO = {
  users: [
    { id: "u1", full_name: "Ana Ferreira", email: "ana@upgferreira.com", phone: "", role: "admin", status: "active" },
    { id: "u2", full_name: "Bruno Lima", email: "bruno@upgferreira.com", phone: "", role: "user", status: "active" }
  ],
  pipelines: [
    { id: "pl1", name: "Padrão", stages: ["Lead", "Qualificação", "Diagnóstico", "Proposta", "Negociação"] }
  ],
  companies: [
    { tax_id: "12.345.678/0001-90", legal_name: "REDE ALFA VAREJO LTDA", trade_name: "Rede Alfa", email: "contato@alfa.com", phone: "(12) 3300-1000", headquarters: "Matriz", founded_at: "2026-05-02", registration_status: "Ativa", activities: "47.89-0-99 — Comércio varejista de outros produtos", address: "Avenida Central, 100 - Centro", zip_code: "12300-000", city: "São José dos Campos", state: "SP", notes: "" },
    { tax_id: "98.765.432/0001-10", legal_name: "INDÚSTRIA BETA LTDA", trade_name: "Beta", email: "comercial@beta.com", phone: "(12) 3300-2000", headquarters: "Matriz", founded_at: "2026-05-10", registration_status: "Ativa", activities: "28.29-1-99 — Fabricação de outras máquinas e equipamentos", address: "Rua Ipe, 163 - Vila Industrial", zip_code: "12400-000", city: "Pindamonhangaba", state: "SP", notes: "" },
    { tax_id: "45.111.222/0001-33", legal_name: "CLÍNICA GAMA SERVIÇOS MÉDICOS LTDA", trade_name: "Clínica Gama", email: "atendimento@gama.com", phone: "(12) 3300-3000", headquarters: "Matriz", founded_at: "2026-06-01", registration_status: "Ativa", activities: "86.30-5-03 — Atividade médica ambulatorial restrita a consultas", address: "Rua Saúde, 45 - Jardim Europa", zip_code: "12500-000", city: "Taubaté", state: "SP", notes: "" },
    { tax_id: "22.333.444/0001-55", legal_name: "LOGÍSTICA DELTA LTDA", trade_name: "Delta Log", email: "operacoes@delta.com", phone: "(12) 3300-4000", headquarters: "Filial", founded_at: "2026-06-18", registration_status: "Ativa", activities: "52.11-7-99 — Depósitos de mercadorias para terceiros", address: "Rodovia SP-000, km 12 - Distrito Industrial", zip_code: "12600-000", city: "Jacareí", state: "SP", notes: "" }
  ],
  contacts: [
    { id: "p1", name: "Carla Souza", phone: "(12) 99111-0001", email: "carla@alfa.com", contact_type: "Cliente", channel: "LinkedIn", job_title: "Gerente de RH", company_id: "12.345.678/0001-90", linkedin: "linkedin.com/in/carlasouza", facebook: "", instagram: "@carla.souza", reddit: "", whatsapp: "(12) 99111-0001", youtube: "", groups: "RH Brasil", birth_date: "1988-03-12", cpf: "123.456.789-00" },
    { id: "p2", name: "Diego Alves", phone: "(12) 99111-0002", email: "diego@beta.com", contact_type: "Prospect", channel: "Indicação", job_title: "Diretor Comercial", company_id: "98.765.432/0001-10", linkedin: "linkedin.com/in/diegoalves", facebook: "", instagram: "", reddit: "", whatsapp: "(12) 99111-0002", youtube: "", groups: "B2B Sales", birth_date: "1982-09-21", cpf: "987.654.321-00" },
    { id: "p3", name: "Elaine Costa", phone: "(12) 99111-0003", email: "elaine@gama.com", contact_type: "Parceiro", channel: "Evento", job_title: "Coord. de Treinamento", company_id: "45.111.222/0001-33", linkedin: "", facebook: "facebook.com/elaine.costa", instagram: "@elainecosta", reddit: "", whatsapp: "(12) 99111-0003", youtube: "", groups: "Educação Corporativa", birth_date: "1990-01-05", cpf: "111.222.333-44" },
    { id: "p4", name: "Felipe Rocha", phone: "(12) 99111-0004", email: "felipe@delta.com", contact_type: "Cliente", channel: "WhatsApp", job_title: "Gestor de Operações", company_id: "22.333.444/0001-55", linkedin: "linkedin.com/in/feliperocha", facebook: "", instagram: "", reddit: "u/feliperocha", whatsapp: "(12) 99111-0004", youtube: "", groups: "Operações e Logística", birth_date: "1985-07-17", cpf: "222.333.444-55" }
  ],
  products: [
    { id: "pr1", category: "Treinamentos", name: "Formação em Liderança", description: "Programa 40h in-company", price: 18000, price_installment: 19800, sales_page: "https://upgferreira.com/lideranca", status: "Ativo", duration_days: 45 },
    { id: "pr2", category: "Cursos", name: "Excel Avançado", description: "Turma fechada 20h", price: 7500, price_installment: 8200, sales_page: "https://upgferreira.com/excel", status: "Ativo", duration_days: 18 },
    { id: "pr3", category: "Onboarding", name: "Onboarding Comercial", description: "Trilha de vendas 16h", price: 9800, price_installment: 10600, sales_page: "https://upgferreira.com/onboarding", status: "Ativo", duration_days: 18 }
  ],
  deals: [
    { id: "d1", title: "Liderança 2 turmas", company_id: "12.345.678/0001-90", contact_id: "p1", product_id: "pr1", owner_id: "u1", pipeline_id: "pl1", stage: "Proposta", status: "open", amount: 36000, lead_source: "Indicação", expected_close_date: "2026-07-20" },
    { id: "d2", title: "Excel RH", company_id: "98.765.432/0001-10", contact_id: "p2", product_id: "pr2", owner_id: "u2", pipeline_id: "pl1", stage: "Diagnóstico", status: "open", amount: 7500, lead_source: "Site", expected_close_date: "2026-07-30" },
    { id: "d3", title: "Trilha vendas Q3", company_id: "45.111.222/0001-33", contact_id: "p3", product_id: "pr3", owner_id: "u1", pipeline_id: "pl1", stage: "Negociação", status: "open", amount: 19600, lead_source: "Evento", expected_close_date: "2026-07-15" },
    { id: "d4", title: "Liderança piloto", company_id: "22.333.444/0001-55", contact_id: "p4", product_id: "pr1", owner_id: "u2", pipeline_id: "pl1", stage: "Lead", status: "open", amount: 18000, lead_source: "LinkedIn", expected_close_date: "2026-08-10" },
    { id: "d5", title: "Excel fechado", company_id: "12.345.678/0001-90", contact_id: "p1", product_id: "pr2", owner_id: "u1", pipeline_id: "pl1", stage: "Qualificação", status: "open", amount: 7500, lead_source: "Inbound", expected_close_date: "2026-08-01" },
    { id: "d6", title: "Onboarding Delta", company_id: "22.333.444/0001-55", contact_id: "p4", product_id: "pr3", owner_id: "u2", pipeline_id: "pl1", stage: "Negociação", status: "won", amount: 9800, lead_source: "Indicação", expected_close_date: "2026-06-28" }
  ],
  projects: [
    { id: "pj1", name: "EC365 | Rede Alfa | Formação em Liderança", group_name: "", client_name: "Rede Alfa", company_id: "12.345.678/0001-90", product_id: "pr1", owner_id: "u1", negotiation_id: null, status: "in_progress", substatus: "", source: "manual", start_date: "2026-07-01", end_date: "2026-08-15" },
    { id: "pj2", name: "EC365 | Beta | Excel Avançado", group_name: "", client_name: "Beta", company_id: "98.765.432/0001-10", product_id: "pr2", owner_id: "u2", negotiation_id: null, status: "planned", substatus: "", source: "manual", start_date: "2026-07-18", end_date: "2026-08-05" },
    { id: "pj3", name: "EC365 | Delta Log | Onboarding Comercial", group_name: "", client_name: "Delta Log", company_id: "22.333.444/0001-55", product_id: "pr3", owner_id: "u2", negotiation_id: "d6", status: "done", substatus: "", source: "negotiation", start_date: "2026-06-10", end_date: "2026-06-28" }
  ],
  conversations: [],
  activities: [],
  productActivities: [],
  productObjectives: [],
  productGoals: [],
  deliveryObjectives: [],
  deliveryGoals: [],
  processes: []
};

// ---------- REST Supabase ----------
async function api(path, opts = {}) {
  const c = getCfg();
  const token = await getAccessToken();
  if (isLive() && !token) {
    showLogin("Sua sessão expirou. Entre novamente.");
    throw new Error("Sessão expirada");
  }
  const headers = { apikey: c.anonKey, Authorization: `Bearer ${token || c.anonKey}`, ...(opts.headers || {}) };
  const res = await fetch(`${c.url}/rest/v1/${path}`, { ...opts, headers });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    if (res.status === 401) {
      storeAuthSession(null);
      showLogin("Sua sessão expirou. Entre novamente.");
    }
    throw new Error(`${res.status} ${res.statusText}${txt ? " · " + txt.slice(0, 120) : ""}`);
  }
  return res.status === 204 ? null : res.json();
}

async function fetchTable(name) {
  if (!isLive()) return DEMO[name] || [];
  const rows = await api(`${remoteTable(name)}?select=*`);
  return Array.isArray(rows) ? rows.map((r) => fromRemoteRow(name, r)) : rows;
}
async function createRow(table, body) {
  if (!isLive()) {
    const row = PK_COLUMN[table] ? { ...body } : { id: crypto.randomUUID(), ...body };
    DEMO[table].push(row);
    return row;
  }
  const j = { "Content-Type": "application/json", Prefer: "return=representation" };
  const r = await api(remoteTable(table), { method: "POST", headers: j, body: JSON.stringify(toRemoteBody(table, body)) });
  const row = Array.isArray(r) ? r[0] : r;
  return fromRemoteRow(table, row);
}
async function updateRow(table, id, body) {
  const k = pk(table);
  if (!isLive()) { const r = DEMO[table].find((x) => x[k] === id); Object.assign(r, body); return r; }
  const j = { "Content-Type": "application/json", Prefer: "return=representation" };
  const r = await api(`${remoteTable(table)}?${k}=eq.${encodeURIComponent(id)}`, { method: "PATCH", headers: j, body: JSON.stringify(toRemoteBody(table, body)) });
  const row = Array.isArray(r) ? r[0] : r;
  return fromRemoteRow(table, row);
}
async function deleteRow(table, id) {
  const k = pk(table);
  if (!isLive()) { DEMO[table] = DEMO[table].filter((x) => x[k] !== id); return; }
  return api(`${remoteTable(table)}?${k}=eq.${encodeURIComponent(id)}`, { method: "DELETE" });
}

async function emailAccountsRequest(method = "GET", body = null) {
  if (APP_VARIANT !== "web" || !isLive()) throw new Error("A criação automática de e-mail está disponível na versão web conectada.");
  const c = getCfg();
  const token = await getAccessToken();
  if (!token) throw new Error("Sua sessão expirou. Entre novamente.");
  const response = await fetch(`${c.url}/functions/v1/provision-client-email`, {
    method,
    headers: { apikey: c.anonKey, Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Falha ao acessar os e-mails (${response.status})`);
  return data;
}

async function provisionDeliveryEmail(project, { notify = true } = {}) {
  if (APP_VARIANT !== "web" || !isLive() || !project?.id) return null;
  try {
    const result = await emailAccountsRequest("POST", { deliveryId: project.id });
    remoteToolEmailsLoaded = true;
    if (result.account) {
      const index = remoteToolEmails.findIndex((account) => account.id === result.account.id);
      if (index >= 0) remoteToolEmails[index] = result.account;
      else remoteToolEmails.unshift(result.account);
    }
    if (notify) {
      const message = result.status === "created"
        ? `E-mail ${result.account.email} criado na HostGator.`
        : result.status === "existing_unmanaged"
          ? `E-mail ${result.account.email} já existe na HostGator. A senha anterior não pode ser recuperada.`
          : `E-mail ${result.account.email} já estava criado.`;
      toast(message);
    }
    return result.account;
  } catch (err) {
    if (notify) toast("Entrega salva, mas o e-mail não foi criado · " + err.message, true);
    return null;
  }
}

// ---------- Cache ----------
let cache = null;
function loadConversations() {
  try {
    const rows = JSON.parse(localStorage.getItem("crm_conversations") || "null");
    if (Array.isArray(rows)) return rows;
  } catch (e) {}
  try {
    const legacy = JSON.parse(localStorage.getItem("crm_imports") || "[]");
    if (Array.isArray(legacy) && legacy.length) {
      localStorage.setItem("crm_conversations", JSON.stringify(legacy));
      return legacy;
    }
  } catch (e) {}
  return [];
}
function saveConversations(rows) {
  localStorage.setItem("crm_conversations", JSON.stringify(rows));
  if (cache) cache.conversations = rows;
}
function loadProjectTasks() {
  if (isLive() && cache?.activityRecords) return cache.activityRecords;
  try {
    const rows = JSON.parse(localStorage.getItem("crm_project_tasks") || "[]");
    return Array.isArray(rows) ? rows : [];
  }
  catch (e) { return []; }
}
function saveProjectTasks(rows) {
  localStorage.setItem("crm_project_tasks", JSON.stringify(rows));
  if (cache && !isLive()) cache.activityRecords = rows;
}
function loadProductActivities() {
  if (isLive() && cache?.productActivities) return cache.productActivities;
  try {
    const rows = JSON.parse(localStorage.getItem("crm_product_activities") || "[]");
    return Array.isArray(rows) ? rows : [];
  } catch (e) { return []; }
}
function saveProductActivities(rows) {
  localStorage.setItem("crm_product_activities", JSON.stringify(rows));
  if (cache && !isLive()) cache.productActivities = rows;
}
function loadProductObjectives() {
  if (isLive() && cache?.productObjectives) return cache.productObjectives;
  try {
    const rows = JSON.parse(localStorage.getItem("crm_product_objectives") || "[]");
    return Array.isArray(rows) ? rows : [];
  } catch (e) { return []; }
}
function saveProductObjectives(rows) {
  localStorage.setItem("crm_product_objectives", JSON.stringify(rows));
  if (cache && !isLive()) cache.productObjectives = rows;
}
function loadProductGoals() {
  if (isLive() && cache?.productGoals) return cache.productGoals;
  try {
    const rows = JSON.parse(localStorage.getItem("crm_product_goals") || "[]");
    return Array.isArray(rows) ? rows : [];
  } catch (e) { return []; }
}
function saveProductGoals(rows) {
  localStorage.setItem("crm_product_goals", JSON.stringify(rows));
  if (cache && !isLive()) cache.productGoals = rows;
}
function loadDeliveryObjectives() {
  if (isLive() && cache?.deliveryObjectives) return cache.deliveryObjectives;
  try {
    const rows = JSON.parse(localStorage.getItem("crm_delivery_objectives") || "[]");
    return Array.isArray(rows) ? rows : [];
  } catch (e) { return []; }
}
function saveDeliveryObjectives(rows) {
  localStorage.setItem("crm_delivery_objectives", JSON.stringify(rows));
  if (cache && !isLive()) cache.deliveryObjectives = rows;
}
function loadDeliveryGoals() {
  if (isLive() && cache?.deliveryGoals) return cache.deliveryGoals;
  try {
    const rows = JSON.parse(localStorage.getItem("crm_delivery_goals") || "[]");
    return Array.isArray(rows) ? rows : [];
  } catch (e) { return []; }
}
function saveDeliveryGoals(rows) {
  localStorage.setItem("crm_delivery_goals", JSON.stringify(rows));
  if (cache && !isLive()) cache.deliveryGoals = rows;
}
function activityRemoteBody(task) {
  return {
    id: task.id,
    project_id: task.project_id,
    source_template_id: task.source_template_id || null,
    occurrence_index: Number(task.occurrence_index || 0),
    depends_on_activity_id: task.depends_on_activity_id || null,
    dependency_ids: normalizeIdList(task.dependency_ids, task.depends_on_activity_id),
    objective_id: task.objective_id || null,
    title: task.title,
    information: task.information || null,
    sort_order: Number(task.sort_order || 0),
    group: task.group || null,
    sector: task.sector || null,
    channel: task.channel || null,
    type: task.type || null,
    recurrence: task.recurrence || "once",
    checklist: normalizeChecklist(task.checklist),
    owner_id: task.owner_id || null,
    assignee_ids: normalizeIdList(task.assignee_ids, task.owner_id),
    assignee_job_titles: normalizeTextList(task.assignee_job_titles),
    priority: task.priority || "normal",
    due_date: task.due_date || null,
    notes: task.notes || null,
    status: task.status || "todo",
    created_at: task.created_at || new Date().toISOString(),
    updated_at: task.updated_at || new Date().toISOString()
  };
}
function productActivityRemoteBody(template) {
  return {
    id: template.id,
    product_id: template.product_id,
    depends_on_template_id: template.depends_on_template_id || null,
    dependency_template_ids: normalizeIdList(template.dependency_template_ids, template.depends_on_template_id),
    group: template.group || null,
    sector: template.sector || null,
    channel: template.channel || null,
    type: template.type || null,
    activity: template.activity,
    information: template.information || null,
    default_owner_id: template.default_owner_id || null,
    default_assignee_ids: normalizeIdList(template.default_assignee_ids, template.default_owner_id),
    default_assignee_job_titles: normalizeTextList(template.default_assignee_job_titles),
    template_group_id: template.template_group_id || crypto.randomUUID(),
    priority: template.priority || "normal",
    objective_template_id: template.objective_template_id || null,
    recurrence: template.recurrence || "once",
    checklist: normalizeChecklist(template.checklist).map((item) => ({ ...item, checked: false })),
    sort_order: Number(template.sort_order || 0),
    created_at: template.created_at || new Date().toISOString(),
    updated_at: template.updated_at || new Date().toISOString()
  };
}
async function migrateLocalOperationalData() {
  if (!isLive()) return;
  const localTemplates = (() => { try { return JSON.parse(localStorage.getItem("crm_product_activities") || "[]"); } catch (e) { return []; } })();
  const localTasks = (() => { try { return JSON.parse(localStorage.getItem("crm_project_tasks") || "[]"); } catch (e) { return []; } })();
  const remainingTemplates = [];
  for (const template of Array.isArray(localTemplates) ? localTemplates : []) {
    if (cache.productActivities.some((row) => row.id === template.id)) continue;
    if (!cache.productById[template.product_id]) { remainingTemplates.push(template); continue; }
    try {
      const saved = await createRow("productActivities", productActivityRemoteBody(template));
      cache.productActivities.push(saved);
    } catch (e) { remainingTemplates.push(template); }
  }
  const remainingTasks = [];
  for (const task of Array.isArray(localTasks) ? localTasks : []) {
    const already = cache.activityRecords.some((row) => row.id === task.id ||
      (task.source_template_id && row.project_id === task.project_id && row.source_template_id === task.source_template_id
        && Number(row.occurrence_index || 0) === Number(task.occurrence_index || 0)));
    if (already) continue;
    if (!cache.projectById[task.project_id]) { remainingTasks.push(task); continue; }
    const compatible = { ...task };
    if (compatible.source_template_id && !cache.productActivities.some((row) => row.id === compatible.source_template_id)) {
      compatible.source_template_id = null;
    }
    try {
      const saved = await createRow("activities", activityRemoteBody(compatible));
      cache.activityRecords.push(saved);
    } catch (e) { remainingTasks.push(task); }
  }
  if (remainingTemplates.length) localStorage.setItem("crm_product_activities", JSON.stringify(remainingTemplates));
  else if (localTemplates?.length) localStorage.removeItem("crm_product_activities");
  if (remainingTasks.length) localStorage.setItem("crm_project_tasks", JSON.stringify(remainingTasks));
  else if (localTasks?.length) localStorage.removeItem("crm_project_tasks");
}
async function syncProductObjectives() {
  if (!cache) return;
  const templates = loadProductObjectives();
  const objectives = loadDeliveryObjectives();
  let changed = false;
  for (const project of cache.projects || []) {
    for (const template of templates.filter((item) => item.product_id === project.product_id)) {
      const current = objectives.find((item) => item.project_id === project.id && item.source_template_id === template.id);
      const structural = {
        name: template.name,
        completion_criteria: template.completion_criteria || "",
        sort_order: Number(template.sort_order || 0)
      };
      const suggestedDue = project.start_date && template.target_days != null
        ? addDays(project.start_date, template.target_days)
        : null;
      if (current) {
        const updates = { ...structural };
        if (!current.owner_id && template.default_owner_id) updates.owner_id = template.default_owner_id;
        if (!current.due_date && suggestedDue) updates.due_date = suggestedDue;
        if (Object.entries(updates).some(([key, value]) => current[key] !== value)) {
          Object.assign(current, updates, { updated_at: new Date().toISOString() });
          if (isLive()) await updateRow("deliveryObjectives", current.id, updates);
          changed = true;
        }
        continue;
      }
      const now = new Date().toISOString();
      const body = {
        id: crypto.randomUUID(), project_id: project.id, source_template_id: template.id,
        ...structural, owner_id: template.default_owner_id || null, due_date: suggestedDue,
        status: "todo", created_at: now, updated_at: now
      };
      const saved = isLive() ? await createRow("deliveryObjectives", body) : body;
      objectives.push(saved);
      changed = true;
    }
  }
  if (changed) {
    if (isLive()) cache.deliveryObjectives = objectives;
    else saveDeliveryObjectives(objectives);
  }
}
async function syncDeliveryObjectiveDependencies() {
  if (!cache) return;
  const templates = loadProductObjectives();
  const objectives = loadDeliveryObjectives();
  const tasks = loadProjectTasks();
  let changed = false;
  for (const objective of objectives) {
    const template = templates.find((item) => item.id === objective.source_template_id);
    if (!template) continue;
    const dependencyObjectiveIds = normalizeIdList(template.dependency_objective_template_ids)
      .map((templateId) => objectives.find((item) => item.project_id === objective.project_id && item.source_template_id === templateId)?.id)
      .filter(Boolean);
    const dependencyActivityIds = normalizeIdList(template.dependency_activity_template_ids)
      .flatMap((templateId) => tasks
        .filter((item) => item.project_id === objective.project_id && item.source_template_id === templateId)
        .sort(activityOccurrenceSort)
        .map((item) => item.id));
    const sameObjectives = JSON.stringify(normalizeIdList(objective.dependency_objective_ids)) === JSON.stringify(dependencyObjectiveIds);
    const sameActivities = JSON.stringify(normalizeIdList(objective.dependency_activity_ids)) === JSON.stringify(dependencyActivityIds);
    if (sameObjectives && sameActivities) continue;
    const updates = { dependency_objective_ids: dependencyObjectiveIds, dependency_activity_ids: dependencyActivityIds };
    Object.assign(objective, updates, { updated_at: new Date().toISOString() });
    if (isLive()) await updateRow("deliveryObjectives", objective.id, updates);
    changed = true;
  }
  if (changed) {
    if (isLive()) cache.deliveryObjectives = objectives;
    else saveDeliveryObjectives(objectives);
  }
}
async function syncProductGoals() {
  if (!cache) return;
  const templates = loadProductGoals();
  const goals = loadDeliveryGoals();
  let changed = false;
  for (const project of cache.projects || []) {
    for (const template of templates.filter((item) => item.product_id === project.product_id)) {
      const current = goals.find((item) => item.project_id === project.id && item.source_template_id === template.id);
      const structural = {
        name: template.name,
        metric: template.metric,
        comparison: template.comparison || "at_least",
        target_value: Number(template.target_value || 0),
        unit: template.unit || "",
        sort_order: Number(template.sort_order || 0)
      };
      const suggestedDue = project.start_date && template.target_days != null
        ? addDays(project.start_date, template.target_days)
        : null;
      if (current) {
        const updates = { ...structural };
        if (!current.owner_id && template.default_owner_id) updates.owner_id = template.default_owner_id;
        if (!current.due_date && suggestedDue) updates.due_date = suggestedDue;
        if (Object.entries(updates).some(([key, value]) => current[key] !== value)) {
          Object.assign(current, updates, { updated_at: new Date().toISOString() });
          if (isLive()) await updateRow("deliveryGoals", current.id, updates);
          changed = true;
        }
        continue;
      }
      const now = new Date().toISOString();
      const body = {
        id: crypto.randomUUID(), project_id: project.id, source_template_id: template.id,
        ...structural, current_value: 0, owner_id: template.default_owner_id || null,
        due_date: suggestedDue, status: "todo", created_at: now, updated_at: now
      };
      const saved = isLive() ? await createRow("deliveryGoals", body) : body;
      goals.push(saved);
      changed = true;
    }
  }
  if (changed) {
    if (isLive()) cache.deliveryGoals = goals;
    else saveDeliveryGoals(goals);
  }
}
async function syncDeliveryGoalDependencies() {
  if (!cache) return;
  const templates = loadProductGoals();
  const goals = loadDeliveryGoals();
  const tasks = loadProjectTasks();
  let changed = false;
  for (const goal of goals) {
    const template = templates.find((item) => item.id === goal.source_template_id);
    if (!template) continue;
    const dependencyGoalIds = normalizeIdList(template.dependency_goal_template_ids)
      .map((templateId) => goals.find((item) => item.project_id === goal.project_id && item.source_template_id === templateId)?.id)
      .filter(Boolean);
    const dependencyActivityIds = normalizeIdList(template.dependency_activity_template_ids)
      .flatMap((templateId) => tasks
        .filter((item) => item.project_id === goal.project_id && item.source_template_id === templateId)
        .sort(activityOccurrenceSort)
        .map((item) => item.id));
    const sameGoals = JSON.stringify(normalizeIdList(goal.dependency_goal_ids)) === JSON.stringify(dependencyGoalIds);
    const sameActivities = JSON.stringify(normalizeIdList(goal.dependency_activity_ids)) === JSON.stringify(dependencyActivityIds);
    if (sameGoals && sameActivities) continue;
    const updates = { dependency_goal_ids: dependencyGoalIds, dependency_activity_ids: dependencyActivityIds };
    Object.assign(goal, updates, { updated_at: new Date().toISOString() });
    if (isLive()) await updateRow("deliveryGoals", goal.id, updates);
    changed = true;
  }
  if (changed) {
    if (isLive()) cache.deliveryGoals = goals;
    else saveDeliveryGoals(goals);
  }
}
async function syncProductActivities() {
  if (!cache) return;
  const templates = loadProductActivities();
  const tasks = loadProjectTasks();
  let changed = false;
  for (const project of cache.projects || []) {
    for (const template of templates.filter((item) => item.product_id === project.product_id)) {
      const objective = template.objective_template_id
        ? loadDeliveryObjectives().find((item) => item.project_id === project.id && item.source_template_id === template.objective_template_id)
        : null;
      const dates = activityOccurrenceDates(project, template.recurrence || "once");
      const existing = tasks
        .filter((task) => task.project_id === project.id && task.source_template_id === template.id)
        .sort(activityOccurrenceSort);
      for (let occurrenceIndex = 0; occurrenceIndex < dates.length; occurrenceIndex += 1) {
        const current = existing.find((task) => Number(task.occurrence_index || 0) === occurrenceIndex);
        const dueDate = dates[occurrenceIndex];
        const structural = {
          title: template.activity,
          information: template.information || "",
          priority: template.priority || "normal",
          sort_order: Number(template.sort_order || 0) * 1000 + occurrenceIndex,
          group: template.group || "",
          sector: template.sector || "",
          channel: template.channel || "",
          type: template.type || "",
          recurrence: template.recurrence || "once",
          occurrence_index: occurrenceIndex,
          objective_id: objective?.id || null
        };
        if (current) {
          const recurrenceChanged = (current.recurrence || "once") !== structural.recurrence;
          const updates = { ...structural, checklist: mergeTemplateChecklist(template.checklist, current.checklist) };
          const defaultAssignees = normalizeIdList(template.default_assignee_ids, template.default_owner_id);
          if (!normalizeIdList(current.assignee_ids, current.owner_id).length && defaultAssignees.length) {
            updates.assignee_ids = defaultAssignees;
            updates.owner_id = defaultAssignees[0];
          }
          const defaultJobTitles = normalizeTextList(template.default_assignee_job_titles);
          if (!normalizeTextList(current.assignee_job_titles).length && defaultJobTitles.length) {
            updates.assignee_job_titles = defaultJobTitles;
          }
          if (dueDate && (!current.due_date || recurrenceChanged)) updates.due_date = dueDate;
          if (Object.entries(updates).some(([key, value]) => key === "checklist"
            ? JSON.stringify(normalizeChecklist(current[key])) !== JSON.stringify(value)
            : current[key] !== value)) {
            Object.assign(current, updates, { updated_at: new Date().toISOString() });
            if (isLive()) await updateRow("activities", current.id, updates);
            changed = true;
          }
          continue;
        }
        const now = new Date().toISOString();
        const body = {
          id: crypto.randomUUID(), project_id: project.id, source_template_id: template.id,
          ...structural, checklist: mergeTemplateChecklist(template.checklist, []),
          owner_id: normalizeIdList(template.default_assignee_ids, template.default_owner_id)[0] || null,
          assignee_ids: normalizeIdList(template.default_assignee_ids, template.default_owner_id),
          assignee_job_titles: normalizeTextList(template.default_assignee_job_titles),
          due_date: dueDate, notes: "", status: "todo",
          created_at: now, updated_at: now
        };
        const saved = isLive() ? await createRow("activities", body) : body;
        tasks.push(saved);
        existing.push(saved);
        changed = true;
      }
    }
  }
  for (const project of cache.projects || []) {
    const projectTemplates = templates.filter((item) => item.product_id === project.product_id);
    for (const template of projectTemplates) {
      const occurrences = tasks.filter((task) => task.project_id === project.id && task.source_template_id === template.id).sort(activityOccurrenceSort);
      const dependencyTemplateIds = normalizeIdList(template.dependency_template_ids, template.depends_on_template_id);
      for (let index = 0; index < occurrences.length; index += 1) {
        const current = occurrences[index];
        const occurrenceIndex = Number(current.occurrence_index || 0);
        const dependencyIds = dependencyTemplateIds.map((templateId) => {
          const dependencyOccurrences = tasks.filter((task) => task.project_id === project.id && task.source_template_id === templateId).sort(activityOccurrenceSort);
          return dependencyOccurrences.find((task) => Number(task.occurrence_index || 0) === occurrenceIndex)?.id
            || dependencyOccurrences[Math.min(index, dependencyOccurrences.length - 1)]?.id;
        }).filter(Boolean);
        const dependencyId = dependencyIds[0] || null;
        if ((current.depends_on_activity_id || null) === dependencyId
          && JSON.stringify(normalizeIdList(current.dependency_ids, current.depends_on_activity_id)) === JSON.stringify(dependencyIds)) continue;
        current.depends_on_activity_id = dependencyId;
        current.dependency_ids = dependencyIds;
        current.updated_at = new Date().toISOString();
        if (isLive()) await updateRow("activities", current.id, { depends_on_activity_id: dependencyId, dependency_ids: dependencyIds });
        changed = true;
      }
    }
  }
  if (changed) {
    if (isLive()) cache.activityRecords = tasks;
    else saveProjectTasks(tasks);
  }
  await syncDeliveryObjectiveDependencies();
  await syncDeliveryGoalDependencies();
}
function activityOccurrenceSort(a, b) {
  return String(a.due_date || "9999-12-31").localeCompare(String(b.due_date || "9999-12-31"))
    || Number(a.sort_order || 0) - Number(b.sort_order || 0)
    || String(a.created_at || "").localeCompare(String(b.created_at || ""));
}
function addMonthsClamped(isoDate, months) {
  const source = new Date(`${isoDate}T00:00:00`);
  const day = source.getDate();
  const target = new Date(source.getFullYear(), source.getMonth() + Number(months), 1);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}
function activityOccurrenceDates(project, recurrence) {
  if (!recurrence || recurrence === "once") return [null];
  const start = project.start_date;
  const end = project.end_date;
  if (!start) return [null];
  if (!end || end <= start) return [start];
  const dates = [];
  let cursor = start;
  const monthStep = { monthly: 1, bimonthly: 2, quarterly: 3, semiannual: 6, annual: 12 }[recurrence];
  const dayStep = recurrence === "weekly" ? 7 : recurrence === "biweekly" ? 14 : null;
  for (let guard = 0; guard < 520 && cursor < end; guard += 1) {
    dates.push(cursor);
    cursor = monthStep ? addMonthsClamped(cursor, monthStep) : addDays(cursor, dayStep || 1);
  }
  return dates.length ? dates : [start];
}
function projectTasks(projectId) {
  return loadProjectTasks()
    .filter((task) => task.project_id === projectId)
    .sort((a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0) || String(a.created_at || "").localeCompare(String(b.created_at || "")));
}
function findConversation(id) {
  return loadConversations().find((row) => row.id === id);
}
function selectedConversationRows() {
  return [...state.selectedConversations].map(findConversation).filter(Boolean);
}
function contactForConversation(row) {
  if (!row) return "";
  return row.contact || "";
}
function redditUserFromSender(sender) {
  const m = String(sender || "").match(/^@([^:]+):/);
  return m ? m[1] : sender || "";
}
function redditProfileUrl(username) {
  return username ? `https://www.reddit.com/user/${username}/` : "";
}
// Participante "principal" da sala = quem não é você. Se você não configurou
// myRedditUsername em config.js, cai no primeiro username visto (funciona
// bem pra DM 1:1; em sala com mais gente, ajuste o config).
function primaryRedditParticipant(row) {
  const me = String(getCfg().myRedditUsername || "").toLowerCase();
  const counts = row.participants || {};
  const candidates = Object.keys(counts).filter((u) => u.toLowerCase() !== me);
  if (!candidates.length) return null;
  return candidates.sort((a, b) => counts[b] - counts[a])[0];
}

function syncRedditQueue() {
  if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) return;
  chrome.storage.local.get({
    erc_reddit_events_queue: [],
    erc_reddit_rooms: {},
    erc_reddit_profiles: {},
    erc_reddit_room_urls: {}
  }, (data) => {
    const events = data.erc_reddit_events_queue || [];
    const roomNames = data.erc_reddit_rooms || {};
    const profiles = data.erc_reddit_profiles || {};
    const roomUrls = data.erc_reddit_room_urls || {};
    const conversations = loadConversations();
    let changed = false;

    if (events.length) {
      const byRoom = {};
      events.forEach((ev) => {
        if (!ev.room_id) return;
        (byRoom[ev.room_id] = byRoom[ev.room_id] || []).push(ev);
      });

      Object.entries(byRoom).forEach(([roomId, evs]) => {
        evs.sort((a, b) => (a.origin_server_ts || 0) - (b.origin_server_ts || 0));
        let row = conversations.find((r) => r.source === "Reddit" && r.external_room_id === roomId);
        const existingIds = new Set(row?.event_ids || []);
        const newEvs = evs.filter((ev) => ev.event_id && !existingIds.has(ev.event_id));
        if (!newEvs.length) return;

        const mapped = newEvs.map((ev) => ({
          at: ev.origin_server_ts ? new Date(ev.origin_server_ts).toLocaleString("pt-BR") : "",
          author: redditUserFromSender(ev.sender),
          text: ev.content?.body || ""
        }));

        if (!row) {
          row = {
            id: crypto.randomUUID(), source: "Reddit", origin: "Scrap", external_room_id: roomId,
            contact_name: "", contact: "", username: "", profile_url: "", chat_url: roomUrls[roomId] || "",
            participants: {}, message_count: 0, first_at: "", last_at: "",
            title: roomNames[roomId] ? `Reddit - ${roomNames[roomId]}` : "Reddit",
            summary: "", messages: [], event_ids: [],
            imported_at: new Date().toLocaleString("pt-BR"), status: "imported"
          };
          conversations.unshift(row);
        }

        row.messages = (row.messages || []).concat(mapped);
        row.event_ids = (row.event_ids || []).concat(newEvs.map((ev) => ev.event_id));
        row.message_count = row.messages.length;
        row.first_at = row.first_at || mapped[0].at;
        row.last_at = mapped[mapped.length - 1].at || row.last_at;
        row.summary = row.messages.filter((m) => m.author).slice(-8)
          .map((m) => `${m.author}: ${m.text}`).join(" / ").slice(0, 360);
        row.participants = row.participants || {};
        mapped.forEach((m) => { if (m.author) row.participants[m.author] = (row.participants[m.author] || 0) + 1; });
        changed = true;
      });
    }

    // Resolve username / URL perfil / contato (nome) pra toda sala do Reddit,
    // usando o que já foi capturado até agora (não depende de novas mensagens).
    conversations.forEach((row) => {
      if (row.source !== "Reddit") return;
      if (!row.chat_url && roomUrls[row.external_room_id]) { row.chat_url = roomUrls[row.external_room_id]; changed = true; }
      const primary = primaryRedditParticipant(row);
      if (primary && row.username !== primary) {
        row.username = primary;
        row.profile_url = redditProfileUrl(primary);
        changed = true;
      }
      const profile = row.username ? profiles[row.username] : null;
      if (profile && profile.displayName && row.contact !== profile.displayName) {
        row.contact = profile.displayName;
        if (profile.url) row.profile_url = profile.url;
        changed = true;
      }
    });

    if (changed) {
      saveConversations(conversations);
      if (state.tab === "conversations") render();
      if (events.length) toast("Conversas do Reddit atualizadas.");
    }
    if (events.length) chrome.storage.local.set({ erc_reddit_events_queue: [] });
  });
}

function syncWhatsAppQueue() {
  if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) return;
  chrome.storage.local.get({
    erc_whatsapp_events_queue: [],
    erc_whatsapp_rooms: {},
    erc_whatsapp_contacts: {}
  }, (data) => {
    const events = data.erc_whatsapp_events_queue || [];
    const roomNames = data.erc_whatsapp_rooms || {};
    const contacts = data.erc_whatsapp_contacts || {};
    const conversations = loadConversations();
    let changed = false;

    if (events.length) {
      const byRoom = {};
      events.forEach((ev) => {
        if (!ev.room_id) return;
        (byRoom[ev.room_id] = byRoom[ev.room_id] || []).push(ev);
      });

      Object.entries(byRoom).forEach(([roomId, evs]) => {
        evs.sort((a, b) => (a.at_ts || 0) - (b.at_ts || 0));
        let row = conversations.find((r) => r.source === "WhatsApp" && r.external_room_id === roomId);
        const existingIds = new Set(row?.event_ids || []);
        const newEvs = evs.filter((ev) => ev.msg_id && !existingIds.has(ev.msg_id));
        if (!newEvs.length) return;

        // Guardamos o timestamp de cada mensagem porque a rolagem pra cima
        // (carregar histórico) chega DEPOIS das mensagens recentes — sem o
        // ts não dá pra saber qual é realmente a primeira da conversa nem
        // reordenar o chat corretamente.
        const mapped = newEvs.map((ev) => ({ at: ev.at_label || "", at_ts: ev.at_ts || null, author: ev.author || "", text: ev.text || "" }));
        const title = roomNames[roomId] || row?.contact_name || "WhatsApp";

        if (!row) {
          row = {
            id: crypto.randomUUID(), source: "WhatsApp", origin: "Scrap", external_room_id: roomId,
            contact_name: title, contact: contacts[roomId] || "", username: "", profile_url: "", chat_url: "",
            participants: {}, message_count: 0, first_at: "", last_at: "",
            title: `WhatsApp - ${title}`,
            summary: "", messages: [], event_ids: [],
            imported_at: new Date().toLocaleString("pt-BR"), status: "imported"
          };
          conversations.unshift(row);
        } else if (title) {
          row.contact_name = title;
          row.title = `WhatsApp - ${title}`;
        }

        row.messages = (row.messages || []).concat(mapped).sort((a, b) => (a.at_ts || 0) - (b.at_ts || 0));
        row.event_ids = (row.event_ids || []).concat(newEvs.map((ev) => ev.msg_id));
        row.message_count = row.messages.length;
        const timed = row.messages.filter((m) => m.at_ts);
        if (timed.length) {
          row.first_at = timed[0].at;
          row.last_at = timed[timed.length - 1].at;
        } else {
          row.first_at = row.first_at || mapped[0].at;
          row.last_at = mapped[mapped.length - 1].at || row.last_at;
        }
        row.summary = row.messages.filter((m) => m.author).slice(-8)
          .map((m) => `${m.author}: ${m.text}`).join(" / ").slice(0, 360);
        row.participants = row.participants || {};
        mapped.forEach((m) => { if (m.author) row.participants[m.author] = (row.participants[m.author] || 0) + 1; });
        changed = true;
      });
    }

    // Telefone capturado no perfil do contato — independente de mensagem
    // nova, pra funcionar mesmo só abrindo o perfil na conversa já existente.
    conversations.forEach((row) => {
      if (row.source !== "WhatsApp") return;
      const phone = contacts[row.external_room_id];
      if (phone && row.contact !== phone) { row.contact = phone; changed = true; }
    });

    if (changed) {
      saveConversations(conversations);
      if (state.tab === "conversations") render();
      toast("Conversas do WhatsApp atualizadas.");
    }
    if (events.length) chrome.storage.local.set({ erc_whatsapp_events_queue: [] });
  });
}

async function loadAll() {
  // Cada tabela é buscada de forma independente: se uma ainda não existir ou
  // tiver nome diferente no banco, o módulo dela fica vazio em vez de
  // derrubar o carregamento inteiro (ex.: "companies" continua funcionando
  // mesmo que "deals"/"users" ainda não tenham sido migradas).
  const [users, companies, contacts, products, deals, projects, pipelines, activityRecords, productActivities, productObjectives, productGoals, deliveryObjectives, deliveryGoals] = await Promise.all([
    fetchTable("users").catch(() => []),
    fetchTable("companies"),
    fetchTable("contacts").catch(() => []),
    fetchTable("products").catch(() => []),
    fetchTable("deals").catch(() => []),
    fetchTable("projects").catch(() => []),
    fetchTable("pipelines").catch(() => []),
    fetchTable("activities").catch(() => []),
    fetchTable("productActivities").catch(() => []),
    fetchTable("productObjectives").catch(() => []),
    fetchTable("productGoals").catch(() => []),
    fetchTable("deliveryObjectives").catch(() => []),
    fetchTable("deliveryGoals").catch(() => [])
  ]);
  const byId = (arr, key = "id") => Object.fromEntries(arr.map((r) => [r[key], r]));
  const conversations = loadConversations();
  const projectById = byId(projects);
  cache = { users, companies, contacts, products, deals, projects, pipelines, conversations,
    activities: [], activityRecords, productActivities, productObjectives, productGoals, deliveryObjectives, deliveryGoals,
    companyById: byId(companies, pk("companies")), contactById: byId(contacts), productById: byId(products),
    userById: byId(users), pipelineById: byId(pipelines), projectById };
  await migrateLocalOperationalData();
  await syncProductObjectives();
  await syncProductGoals();
  await syncProductActivities();
  refreshActivityCache();
  return cache;
}

// ---------- Utils ----------
const brl = (n) => (n == null || n === "" ? "—" : new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(n));
const dt = (s) => (s ? new Date(s).toLocaleDateString("pt-BR") : "—");
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function safeHttpUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return ["http:", "https:"].includes(url.protocol) ? url.href : "";
  } catch (e) {
    return "";
  }
}
const badge = (v, label) => `<span class="badge b-${v}">${esc(label || v)}</span>`;
function splitMultiValues(value) {
  return String(value || "").split(/[;,\n]+/).map((item) => item.trim()).filter(Boolean);
}
function normalizePhoneNumber(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  let digits = raw.replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.length === 10 || digits.length === 11) digits = `55${digits}`;
  if (digits.startsWith("55") && (digits.length === 12 || digits.length === 13)) {
    const ddd = digits.slice(2, 4);
    const number = digits.slice(4);
    const prefixLength = number.length - 4;
    return `+55 (${ddd}) ${number.slice(0, prefixLength)}-${number.slice(prefixLength)}`;
  }
  if (digits.length > 11) return `+${digits}`;
  return raw;
}
function normalizePhoneList(value) {
  const seen = new Set();
  return splitMultiValues(value).map(normalizePhoneNumber).filter((item) => {
    const key = item.replace(/\D/g, "");
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).join("; ");
}
function normalizeEmailList(value) {
  const seen = new Set();
  return splitMultiValues(value).filter((item) => {
    const key = item.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).join("; ");
}
function multiLineCell(value, formatter = (item) => item) {
  const values = splitMultiValues(value).map(formatter).filter(Boolean);
  return values.length ? `<div class="multi-value">${values.map((item) => `<span>${esc(item)}</span>`).join("")}</div>` : "—";
}
const activityDisplayName = (item) => {
  if (!item) return "—";
  const parts = [item.group, item.sector, item.channel, item.type, item.activity || item.title]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  return parts.length ? parts.join(" | ") : "—";
};
const addDays = (isoDate, days) => {
  const d = new Date(`${isoDate}T00:00:00`);
  d.setDate(d.getDate() + Number(days || 0));
  return d.toISOString().slice(0, 10);
};
function deliveryTypeForProduct(product) {
  const text = `${product?.category || ""} ${product?.name || ""}`.toLowerCase();
  if (text.includes("imers")) return "Imersão";
  if (text.includes("trein") || text.includes("curso") || text.includes("formaç")) return "Treinamento";
  if (text.includes("consult")) return "Consultoria";
  if (text.includes("evento")) return "Evento";
  return "Projeto";
}
function deliveryGeneratedName(clientName, productId) {
  const product = cache?.productById?.[productId];
  return `EC365 | ${String(clientName || "Sem cliente").trim() || "Sem cliente"} | ${product?.name || "Sem produto"}`;
}

// Quando um negócio entra em "Ganho", um projeto nasce sozinho — carrega
// cliente/produto do negócio e calcula o fim pela duração cadastrada no
// produto. Idempotente: se já existe projeto pra esse negócio, não duplica.
async function createProjectFromDeal(deal) {
  if (!cache || !deal?.id) return;
  const already = (cache.projects || []).some((p) => p.negotiation_id === deal.id);
  if (already) return;
  const product = deal.product_id ? cache.productById[deal.product_id] : null;
  const company = deal.company_id ? cache.companyById[deal.company_id] : null;
  const contact = deal.contact_id ? cache.contactById?.[deal.contact_id] : null;
  const start = new Date().toISOString().slice(0, 10);
  const end = product?.duration_days ? addDays(start, product.duration_days) : null;
  const clientName = contact?.name || company?.trade_name || company?.legal_name || "Sem cliente";
  const name = deliveryGeneratedName(clientName, deal.product_id);
  try {
    const savedProject = await createRow("projects", {
      name: name || deal.title || "Entrega",
      delivery_type: deliveryTypeForProduct(product),
      group_name: null,
      client_name: clientName,
      company_id: deal.company_id || null,
      product_id: deal.product_id || null,
      negotiation_id: deal.id,
      status: "planned",
      substatus: null,
      source: "negotiation",
      start_date: start,
      end_date: end
    });
    toast("Entrega criada automaticamente a partir do negócio ganho.");
    await provisionDeliveryEmail(savedProject);
  } catch (err) {
    toast("Erro ao criar entrega automática · " + err.message, true);
  }
}

function toast(msg, isErr) {
  const el = document.createElement("div");
  el.className = "toast" + (isErr ? " err" : "");
  el.textContent = msg;
  document.getElementById("toast").appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

// ---------- Colunas e campos ----------
function columns(tab, c) {
  switch (tab) {
    case "companies": return [
      { k: "tax_id", h: "CNPJ", cls: "muted" },
      { k: "legal_name", h: "NOME EMPRESARIAL" },
      { k: "trade_name", h: "NOME FANTASIA" },
      { k: "email", h: "E-MAIL", cls: "muted" },
      { k: "phone", h: "TELEFONE", cls: "muted" },
      { k: "headquarters", h: "SEDE" },
      { k: "founded_at", h: "DATA DE ABERTURA", fmt: dt },
      { k: "registration_status", h: "SITUAÇÃO CADASTRAL" },
      { k: "activities", h: "ATIVIDADES" },
      { k: "address", h: "ENDEREÇO" },
      { k: "zip_code", h: "CEP", cls: "muted" },
      { k: "city", h: "CIDADE" },
      { k: "state", h: "UF", cls: "muted" },
      { k: "notes", h: "OBSERVAÇÕES", cls: "muted" }];
    case "contacts": return [
      { k: "name", h: "NOME COMPLETO" },
      { k: "phone", h: "TELEFONE/CELULAR", cls: "muted", fmt: (v) => multiLineCell(v, normalizePhoneNumber) },
      { k: "email", h: "EMAIL(S)", cls: "muted", fmt: (v) => multiLineCell(v) },
      { k: "contact_type", h: "TIPO DE CONTATO" },
      { k: "channel", h: "CANAL" },
      { k: "job_title", h: "CARGO" },
      { k: "company_id", h: "EMPRESA(S)", fmt: (v) => c.companyById[v]?.legal_name || c.companyById[v]?.name || "—" },
      { k: "linkedin", h: "LINKEDIN", cls: "muted" },
      { k: "facebook", h: "FACEBOOK", cls: "muted" },
      { k: "instagram", h: "INSTAGRAM", cls: "muted" },
      { k: "reddit", h: "REDDIT", cls: "muted" },
      { k: "whatsapp", h: "WHATSAPP", cls: "muted" },
      { k: "youtube", h: "YOUTUBE", cls: "muted" },
      { k: "groups", h: "GRUPOS/COMUNIDADES" },
      { k: "birth_date", h: "DATA DE NASCIMENTO", fmt: dt },
      { k: "cpf", h: "CPF", cls: "muted" }];
    case "products": return [
      { k: "category", h: "CATEGORIA" },
      { k: "name", h: "PRODUTO" },
      { k: "description", h: "DESCRIÇÃO", cls: "muted" },
      { k: "price", h: "PREÇO A VISTA", num: true, fmt: brl, cls: "pos" },
      { k: "price_installment", h: "PREÇO PARCELADO", num: true, fmt: brl, cls: "pos" },
      { k: "sales_page", h: "PÁGINA DE VENDAS", fmt: (v) => safeHttpUrl(v) ? `<a href="${esc(safeHttpUrl(v))}" target="_blank" rel="noopener">Abrir</a>` : "—", csv: (v) => v || "" },
      { k: "duration_days", h: "DURAÇÃO (DIAS)", num: true, cls: "muted" },
      { k: "status", h: "STATUS", fmt: (v) => badge(v === "Ativo" ? "open" : v === "Pausado" ? "lead" : "lost", v) }];
    case "deals": return [
      { k: "title", h: "Negócio" },
      { k: "company_id", h: "Empresa", fmt: (v) => c.companyById[v]?.legal_name || c.companyById[v]?.name || "—" },
      { k: "pipeline_id", h: "Pipeline", fmt: (v) => c.pipelineById?.[v]?.name || "—", cls: "muted" },
      { k: "stage", h: "Etapa", fmt: (v) => v ? badge("lead", v) : "—" },
      { k: "status", h: "Status", fmt: (v) => badge(v, STATUS_LABEL[v]) },
      { k: "lead_source", h: "Origem", cls: "muted" },
      { k: "amount", h: "Valor", num: true, fmt: brl, cls: "pos" },
      { k: "owner_id", h: "Responsável", fmt: (v) => c.userById[v]?.full_name || c.userById[v]?.name || "—", cls: "muted" },
      { k: "expected_close_date", h: "Previsão", fmt: dt }];
    case "projects": return [
      { k: "delivery_type", h: "TIPO" },
      { k: "group_name", h: "GRUPO" },
      { k: "name", h: "ENTREGA" },
      { k: "company_id", h: "EMPRESA", fmt: (v) => c.companyById[v]?.legal_name || "—" },
      { k: "client_name", h: "CLIENTE" },
      { k: "product_id", h: "PRODUTO", fmt: (v) => c.productById[v]?.name || "—" },
      { k: "start_date", h: "INÍCIO", fmt: dt },
      { k: "end_date", h: "FIM", fmt: dt },
      { k: "status", h: "STATUS", fmt: (v) => badge(v === "done" ? "won" : v === "canceled" ? "lost" : v === "in_progress" ? "negotiation" : "lead", PROJECT_STATUS_LABEL[v] || v) },
      { k: "substatus", h: "SUBSTATUS", cls: "muted" }];
    case "activities": return [
      { k: "client_name", h: "CLIENTE", cls: "sticky-col sticky-col-1", thCls: "sticky-col sticky-col-1" },
      { k: "product_name", h: "PRODUTO", cls: "sticky-col sticky-col-2", thCls: "sticky-col sticky-col-2" },
      { k: "activity_origin", h: "ORIGEM", fmt: (v) => badge(v === "product" ? "qualification" : "proposal", v === "product" ? "Produto" : "Dia a dia") },
      { k: "title", h: "TAREFA", fmt: (_v, row) => esc(activityDisplayName(row)) },
      { k: "priority", h: "PRIORIDADE", fmt: (v) => priorityBadge(v) },
      { k: "dependency_ids", h: "DEPENDE DE", fmt: (v, row) => esc(dependencyNames(v, row.depends_on_activity_id, c.activityRecords)) },
      { k: "information", h: "INFORMAÇÃO", cls: "muted" },
      { k: "group", h: "GRUPO" },
      { k: "sector", h: "SETOR" },
      { k: "channel", h: "CANAL" },
      { k: "type", h: "TIPO" },
      { k: "recurrence", h: "RECORRÊNCIA", fmt: (v) => RECURRENCE_LABEL[v] || "Única" },
      { k: "checklist", h: "CHECKLIST", fmt: (v, row) => {
        const progress = checklistProgress(v);
        const complete = progress.total > 0 && progress.done === progress.total;
        return `<button class="btn checklist-open${complete ? " complete" : ""}" data-id="${esc(row.id)}" title="Abrir checklist">${progress.done}/${progress.total}</button>`;
      } },
      { k: "objective_name", h: "OBJETIVO" },
      { k: "assignee_ids", h: "RESPONSÁVEIS", fmt: (v, row) => esc(responsibilityNames(v, row.owner_id, row.assignee_job_titles)) },
      { k: "due_date", h: "PRAZO", fmt: (v, row) => `<input class="inline-due-date" type="date" data-id="${esc(row.id)}" value="${esc(v || "")}" title="Alterar prazo">` },
      { k: "status", h: "STATUS", fmt: (v) => badge(v === "done" ? "won" : v === "doing" ? "negotiation" : "lead", TASK_STATUS.find((s) => s.id === v)?.label || "A fazer") },
      { k: "notes", h: "NOTAS", cls: "muted" }];
    case "conversations": return [
      { k: "contact_name", h: "NOME", fmt: (v, row, c) => (row.contact_id && c.contactById[row.contact_id]?.name) || v || "—" },
      { k: "contact", h: "CONTATO", fmt: (_v, row) => contactForConversation(row) || "—" },
      { k: "username", h: "USUÁRIO", fmt: (v, row) => v ? (row.source === "Reddit" ? `u/${v}` : v) : "—" },
      { k: "profile_url", h: "URL PERFIL", fmt: (v) => safeHttpUrl(v) ? `<a href="${esc(safeHttpUrl(v))}" target="_blank" rel="noopener">Perfil</a>` : "—", csv: (v) => v || "" },
      { k: "source", h: "CANAL" },
      { k: "first_at", h: "PRIMEIRO CONTATO" },
      { k: "last_at", h: "ÚLTIMO CONTATO" },
      { k: "imported_at", h: "DATA REGISTRO" },
      { k: "chat_url", h: "URL CHAT", fmt: (v) => safeHttpUrl(v) ? `<a href="${esc(safeHttpUrl(v))}" target="_blank" rel="noopener">Abrir</a>` : "—", csv: (v) => v || "" },
      { k: "origin", h: "DADO" },
      { k: "conversation", h: "", fmt: (_v, row) => `<button class="rowbtn open-chat" data-id="${esc(row.id)}" title="Ver mensagens no CRM">Ver</button>` }];
  }
}

function refOptions(ref, c) {
  return (c[ref] || []).map((r) => ({ value: r[pk(ref)], label: r.name || r.legal_name || r.full_name || r.title || r[pk(ref)] }));
}
// Etapas do pipeline selecionado (ou o primeiro cadastrado, na falta de um).
// Como agora são texto livre por pipeline, valor e rótulo da opção são o
// próprio texto da etapa.
function pipelineStageOptions(c, pipelineId) {
  const pipeline = (c.pipelineById && c.pipelineById[pipelineId]) || (c.pipelines || [])[0];
  return (pipeline?.stages || []).map((s) => ({ value: s, label: s }));
}
function fields(tab, c) {
  switch (tab) {
    case "companies": return [
      { k: "tax_id", label: "CNPJ", req: true, full: true, lookup: "cnpj" },
      { k: "legal_name", label: "Nome empresarial", full: true },
      { k: "trade_name", label: "Nome fantasia" },
      { k: "email", label: "E-mail" },
      { k: "phone", label: "Telefone" },
      { k: "headquarters", label: "Sede" },
      { k: "founded_at", label: "Data de abertura", type: "date" },
      { k: "registration_status", label: "Situação cadastral" },
      { k: "activities", label: "Atividades", full: true },
      { k: "address", label: "Endereço", full: true },
      { k: "zip_code", label: "CEP" },
      { k: "city", label: "Cidade" },
      { k: "state", label: "UF" },
      { k: "notes", label: "Observações", full: true }];
    case "contacts": return [
      { k: "name", label: "Nome completo", req: true, full: true },
      { k: "phone", label: "Telefone/celular" },
      { k: "email", label: "Email(s)" },
      { k: "contact_type", label: "Tipo de contato" },
      { k: "channel", label: "Canal" },
      { k: "job_title", label: "Cargo" },
      { k: "company_id", label: "Empresa(s)", searchableRef: "companies", options: refOptions("companies", c), full: true },
      { k: "linkedin", label: "LinkedIn" },
      { k: "facebook", label: "Facebook" },
      { k: "instagram", label: "Instagram" },
      { k: "reddit", label: "Reddit" },
      { k: "whatsapp", label: "WhatsApp" },
      { k: "youtube", label: "YouTube" },
      { k: "groups", label: "Grupos/comunidades", full: true },
      { k: "birth_date", label: "Data de nascimento", type: "date" },
      { k: "cpf", label: "CPF" }];
    case "products": return [
      { k: "category", label: "Categoria" },
      { k: "name", label: "Produto", req: true },
      { k: "description", label: "Descrição", full: true },
      { k: "price", label: "Preço à vista (R$)", type: "number" },
      { k: "price_installment", label: "Preço parcelado (R$)", type: "number" },
      { k: "sales_page", label: "Página de vendas", full: true },
      { k: "duration_days", label: "Duração da entrega (dias)", type: "number" },
      { k: "status", label: "Status", type: "select", options: [{ value: "Ativo", label: "Ativo" }, { value: "Pausado", label: "Pausado" }, { value: "Inativo", label: "Inativo" }], def: "Ativo" }];
    case "deals": return [
      { k: "title", label: "Título", req: true, full: true },
      { k: "company_id", label: "Empresa", type: "select", options: refOptions("companies", c), req: true },
      { k: "contact_id", label: "Contato", type: "select", options: refOptions("contacts", c) },
      { k: "product_id", label: "Produto", type: "select", options: refOptions("products", c) },
      { k: "owner_id", label: "Responsável", type: "select", options: refOptions("users", c) },
      { k: "pipeline_id", label: "Pipeline", type: "select", options: (c.pipelines || []).map((p) => ({ value: p.id, label: p.name })), req: true },
      { k: "stage", label: "Etapa", type: "select", options: pipelineStageOptions(c, null) },
      { k: "status", label: "Status", type: "select", options: STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s] })), def: "open" },
      { k: "lead_source", label: "Origem do lead", type: "select", options: SOURCES.map((s) => ({ value: s, label: s })) },
      { k: "amount", label: "Valor (R$)", type: "number" },
      { k: "expected_close_date", label: "Previsão", type: "date" }];
    case "projects": return [
      { k: "name", label: "Entrega", full: true, generated: true },
      { k: "group_name", label: "Grupo" },
      { k: "delivery_type", label: "Tipo", type: "select", options: ["Projeto", "Imersão", "Treinamento", "Consultoria", "Evento", "Serviço recorrente", "Outro"].map((value) => ({ value, label: value })), def: "Projeto" },
      { k: "company_id", label: "Empresa", type: "select", options: refOptions("companies", c), req: true },
      { k: "client_name", label: "Cliente", req: true },
      { k: "product_id", label: "Produto", type: "select", options: refOptions("products", c), req: true },
      { k: "status", label: "Status", type: "select", options: PROJECT_STATUSES.map((s) => ({ value: s, label: PROJECT_STATUS_LABEL[s] })), def: "planned" },
      { k: "substatus", label: "Substatus" },
      { k: "start_date", label: "Início", type: "date" },
      { k: "end_date", label: "Fim", type: "date" }];
  }
}

// ---------- Estado ----------
function loadColPrefs() {
  try { return JSON.parse(localStorage.getItem("crm_cols_v2") || "{}"); }
  catch (e) { return {}; }
}
function saveColPrefs() {
  localStorage.setItem("crm_cols_v2", JSON.stringify(colPrefs));
}
let colPrefs = loadColPrefs();
let state = {
  tab: "home", view: "dashboard", sortK: null, sortDir: 1, q: "", filters: {},
  selectedConversations: new Set(),
  bulkSelections: {
    contacts: new Set(), companies: new Set(), deals: new Set(), products: new Set(),
    projects: new Set(), activities: new Set()
  },
  pages: { contacts: 1, companies: 1, conversations: 1, deals: 1, products: 1, projects: 1, activities: 1 },
  pageSize: 50, kanbanPipelineId: null, calendarCursor: null
};
const secondaryTableSelections = new Map();

function secondaryTableSelection(scope) {
  if (!secondaryTableSelections.has(scope)) secondaryTableSelections.set(scope, new Set());
  return secondaryTableSelections.get(scope);
}

function wireSecondaryTableSelection(table, scope) {
  if (!table || table.querySelector("thead .secondary-select-all")) return;
  const rows = [...table.querySelectorAll("tbody tr")].filter((row) => row.children.length > 1 && !row.querySelector(".empty"));
  const selected = secondaryTableSelection(scope);
  const headRow = table.tHead?.rows?.[0];
  if (!headRow) return;
  const head = document.createElement("th");
  head.className = "select-head noclick";
  head.innerHTML = '<input type="checkbox" class="secondary-select-all" aria-label="Selecionar linhas visíveis">';
  headRow.insertBefore(head, headRow.firstChild);
  rows.forEach((row, index) => {
    const rowId = String(row.dataset.rowId || row.dataset.id || row.dataset.objectiveId || row.dataset.goalId
      || row.querySelector("[data-id]")?.dataset.id || `${scope}:${index}`);
    row.dataset.selectionId = rowId;
    const cell = document.createElement("td");
    cell.className = "select-cell";
    cell.innerHTML = `<input type="checkbox" class="secondary-row-select" aria-label="Selecionar linha"${selected.has(rowId) ? " checked" : ""}>`;
    row.insertBefore(cell, row.firstChild);
  });
  table.querySelectorAll("tbody tr .empty").forEach((cell) => {
    cell.colSpan = Number(cell.colSpan || headRow.cells.length - 1) + 1;
  });
  const host = table.closest("#registrations-root, #project-board-root, #tools-root, #product-activities-root") || table.parentElement;
  const toolbar = host?.querySelector(".registration-toolbar-left, .project-data-toolbar .registration-toolbar-left, .tools-toolbar .registration-toolbar-left, .modal-toolbar");
  let count = toolbar?.querySelector(".table-selection-count");
  if (toolbar && !count) {
    count = document.createElement("span");
    count.className = "muted table-selection-count";
    toolbar.appendChild(count);
  }
  const refresh = () => {
    const visibleRows = rows.filter((row) => !row.hidden);
    const visibleSelected = visibleRows.filter((row) => selected.has(row.dataset.selectionId));
    const all = head.querySelector("input");
    all.checked = Boolean(visibleRows.length && visibleSelected.length === visibleRows.length);
    all.indeterminate = Boolean(visibleSelected.length && visibleSelected.length < visibleRows.length);
    rows.forEach((row) => row.classList.toggle("selected", selected.has(row.dataset.selectionId)));
    if (count) {
      count.textContent = selected.size ? `${selected.size} selecionado(s)` : "";
      count.hidden = !selected.size;
    }
  };
  table._refreshSecondarySelection = refresh;
  table.querySelectorAll(".secondary-row-select").forEach((box) => box.addEventListener("change", () => {
    const row = box.closest("tr");
    if (box.checked) selected.add(row.dataset.selectionId); else selected.delete(row.dataset.selectionId);
    refresh();
  }));
  head.querySelector("input").addEventListener("change", (event) => {
    rows.filter((row) => !row.hidden).forEach((row) => {
      if (event.target.checked) selected.add(row.dataset.selectionId); else selected.delete(row.dataset.selectionId);
      row.querySelector(".secondary-row-select").checked = event.target.checked;
    });
    refresh();
  });
  refresh();
}

function tabFilters(tab = state.tab) {
  if (!state.filters[tab]) state.filters[tab] = {};
  return state.filters[tab];
}
function orderedColumns(tab, c) {
  const prefs = colPrefs[tab] || {};
  const cols = columns(tab, c);
  const savedOrder = Array.isArray(prefs.__order) ? prefs.__order : [];
  const byKey = Object.fromEntries(cols.map((col) => [col.k, col]));
  return [
    ...savedOrder.map((key) => byKey[key]).filter(Boolean),
    ...cols.filter((col) => !savedOrder.includes(col.k))
  ];
}
function visibleColumns(tab, c) {
  const prefs = colPrefs[tab] || {};
  return orderedColumns(tab, c).filter((col) => prefs[col.k] !== false);
}
function displayValue(row, col, c) {
  const val = col.fmt ? col.fmt(row[col.k], row, c) : esc(row[col.k] ?? "—");
  return String(val ?? "").replace(/<[^>]+>/g, "");
}

function rowsFor(tab, c) {
  let rows = c[tab] || [];
  if (state.q) {
    const q = state.q.toLowerCase();
    const cols = columns(tab, c);
    rows = rows.filter((r) => cols.some((col) => displayValue(r, col, c).toLowerCase().includes(q)));
  }
  const filters = tabFilters(tab);
  for (const [k, vals] of Object.entries(filters)) {
    if (!vals || vals.size === 0) continue;
    rows = rows.filter((r) => vals.has(String(r[k] ?? "")));
  }
  if (state.sortK) {
    rows = [...rows].sort((a, b) => {
      const av = a[state.sortK], bv = b[state.sortK];
      if (av == null) return 1; if (bv == null) return -1;
      return (av > bv ? 1 : av < bv ? -1 : 0) * state.sortDir;
    });
  }
  return rows;
}

// ---------- Render tabela ----------
function renderTable(c) {
  const cols = visibleColumns(state.tab, c);
  const allRows = rowsFor(state.tab, c);
  const paginated = true;
  const totalPages = paginated ? Math.max(1, Math.ceil(allRows.length / state.pageSize)) : 1;
  if (paginated) state.pages[state.tab] = Math.min(Math.max(1, state.pages[state.tab] || 1), totalPages);
  const currentPage = paginated ? state.pages[state.tab] : 1;
  const rows = paginated ? allRows.slice((currentPage - 1) * state.pageSize, currentPage * state.pageSize) : allRows;
  const filters = tabFilters();
  const selectable = ["conversations", "contacts", "companies", "deals", "products", "projects", "activities"].includes(state.tab);
  const selectedSet = state.tab === "conversations" ? state.selectedConversations : state.bulkSelections[state.tab];
  const rowKey = pk(state.tab);
  const selectedVisible = selectable ? rows.filter((r) => selectedSet.has(String(r[rowKey]))) : [];
  const selectHead = selectable
    ? `<th class="select-head noclick"><input type="checkbox" id="select-all-rows"${rows.length && selectedVisible.length === rows.length ? " checked" : ""}></th>`
    : "";
  const actionHead = state.tab === "activities" ? "" : `<th class="noclick action-col">AÇÕES</th>`;
  const head = selectHead + cols.map((col) => {
    const isFiltered = filters[col.k]?.size > 0;
    const arr = isFiltered ? `<span class="arrow">▼</span>` : state.sortK === col.k ? `<span class="arrow">${state.sortDir > 0 ? "▲" : "▼"}</span>` : "";
    const cls = [isFiltered ? "filtered" : "", col.thCls || ""].filter(Boolean).join(" ");
    return `<th data-k="${col.k}" class="${cls}" title="Clique para ordenar. Ctrl+clique para filtrar.">${col.h}${arr}</th>`;
  }).join("") + actionHead;

  const editSvg = `<svg viewBox="0 0 20 20"><path d="M13 4l3 3-8 8H5v-3z"/></svg>`;
  const delSvg = `<svg viewBox="0 0 20 20"><path d="M4 6h12M8 6V4h4v2M6 6l1 10h6l1-10"/></svg>`;

  const body = rows.map((r) => {
    const rid = r[rowKey];
    const selectTd = selectable
      ? `<td class="select-cell"><input type="checkbox" class="row-select" data-id="${esc(String(rid))}"${selectedSet.has(String(rid)) ? " checked" : ""}></td>`
      : "";
    const tds = cols.map((col) => {
      const val = col.fmt ? col.fmt(r[col.k], r, c) : esc(r[col.k] ?? "—");
      const cls = [col.num ? "num" : "", col.cls || ""].filter(Boolean).join(" ");
      return `<td class="${cls}" data-k="${esc(col.k)}">${val}</td>`;
    }).join("");
    if (state.tab === "conversations") {
      return `<tr>${selectTd}${tds}<td class="act action-col">
        <button class="rowbtn convert" data-id="${esc(rid)}" title="Transformar em negociação">+</button>
        <button class="rowbtn del-import" data-id="${esc(rid)}" title="Excluir">${delSvg}</button></td></tr>`;
    }
    if (state.tab === "projects") {
      return `<tr>${selectTd}${tds}<td class="act action-col">
        <button class="rowbtn project-board-btn" data-id="${esc(rid)}" title="Abrir tarefas">☷</button>
        <button class="rowbtn edit" data-id="${esc(rid)}" title="Editar">${editSvg}</button>
        <button class="rowbtn del" data-id="${esc(rid)}" title="Excluir">${delSvg}</button></td></tr>`;
    }
    if (state.tab === "activities") return `<tr>${selectTd}${tds}</tr>`;
    if (state.tab === "products") {
      return `<tr>${selectTd}${tds}<td class="act action-col">
        <button class="rowbtn product-activities-btn" data-id="${esc(rid)}" title="Tarefas, metas e objetivos do produto">☷</button>
        <button class="rowbtn edit" data-id="${esc(rid)}" title="Editar">${editSvg}</button>
        <button class="rowbtn del" data-id="${esc(rid)}" title="Excluir">${delSvg}</button></td></tr>`;
    }
    return `<tr>${selectTd}${tds}<td class="act action-col">
      <button class="rowbtn edit" data-id="${esc(rid)}" title="Editar">${editSvg}</button>
      <button class="rowbtn del" data-id="${esc(rid)}" title="Excluir">${delSvg}</button></td></tr>`;
  }).join("");

  const pagination = paginated ? `<div class="table-pagination">
    <span>${allRows.length ? `${(currentPage - 1) * state.pageSize + 1}-${Math.min(currentPage * state.pageSize, allRows.length)} de ${allRows.length}` : "0 registros"}</span>
    <div><button class="btn" id="page-prev"${currentPage <= 1 ? " disabled" : ""}>‹</button><span>Página ${currentPage} de ${totalPages}</span><button class="btn" id="page-next"${currentPage >= totalPages ? " disabled" : ""}>›</button></div>
  </div>` : "";
  const emptyColspan = cols.length + (selectable ? 1 : 0) + (state.tab === "activities" ? 0 : 1);
  const tableBody = body || `<tr><td colspan="${emptyColspan}" class="empty">Nenhum registro. Clique em <b>+</b> para criar.</td></tr>`;
  document.getElementById("main").innerHTML = `<div class="data-table-wrap"><div class="table-scroll"><table class="data-table" data-tab="${esc(state.tab)}"><thead><tr>${head}</tr></thead><tbody>${tableBody}</tbody></table></div>${pagination}</div>`;

  document.querySelectorAll("thead th[data-k]").forEach((th) =>
    th.addEventListener("click", (e) => {
      const k = th.dataset.k;
      if (e.ctrlKey || e.metaKey) { openColumnFilter(th, k); return; }
      if (state.sortK === k) state.sortDir *= -1; else { state.sortK = k; state.sortDir = 1; }
      if (state.pages[state.tab]) state.pages[state.tab] = 1;
      render();
    }));
  document.querySelectorAll(".rowbtn.edit").forEach((b) =>
    b.addEventListener("click", () => openForm(state.tab, b.dataset.id)));
  document.querySelectorAll(".rowbtn.del").forEach((b) =>
    b.addEventListener("click", () => confirmDelete(state.tab, b.dataset.id)));
  document.querySelectorAll(".rowbtn.convert").forEach((b) =>
    b.addEventListener("click", () => convertImportToDeal(b.dataset.id)));
  document.querySelectorAll(".rowbtn.del-import").forEach((b) =>
    b.addEventListener("click", () => deleteImport(b.dataset.id)));
  document.querySelectorAll(".rowbtn.open-chat").forEach((b) =>
    b.addEventListener("click", () => openConversationPopup(b.dataset.id)));
  document.querySelectorAll(".rowbtn.project-board-btn").forEach((b) =>
    b.addEventListener("click", () => openProjectBoard(b.dataset.id)));
  document.querySelectorAll(".rowbtn.product-activities-btn").forEach((b) =>
    b.addEventListener("click", () => openProductActivities(b.dataset.id)));
  document.querySelectorAll(".inline-due-date").forEach((input) => input.addEventListener("change", async () => {
    try {
      await updateProjectTask(input.dataset.id, { due_date: input.value || null });
      toast("Prazo atualizado.");
    } catch (err) { toast("Erro ao atualizar prazo · " + err.message, true); }
  }));
  document.querySelectorAll(".checklist-open").forEach((button) =>
    button.addEventListener("click", () => openActivityChecklist(button.dataset.id)));
  document.querySelectorAll(".row-select").forEach((box) =>
    box.addEventListener("change", () => {
      if (box.checked) selectedSet.add(box.dataset.id);
      else selectedSet.delete(box.dataset.id);
      render();
    }));
  document.getElementById("select-all-rows")?.addEventListener("change", (e) => {
    rows.forEach((r) => {
      const id = String(r[rowKey]);
      if (e.target.checked) selectedSet.add(id);
      else selectedSet.delete(id);
    });
    render();
  });
  document.getElementById("page-prev")?.addEventListener("click", () => { state.pages[state.tab] -= 1; render(); });
  document.getElementById("page-next")?.addEventListener("click", () => { state.pages[state.tab] += 1; render(); });
}

function dealCardHtml(d, c) {
  return `<div class="card" data-id="${esc(d.id)}">
      <div class="t">${esc(d.title)}</div>
      <div class="m">${esc(c.companyById[d.company_id]?.legal_name || c.companyById[d.company_id]?.name || "—")}</div>
      <div class="v">${brl(d.amount)}</div></div>`;
}
function dealColumnHtml(label, items, c, opts = {}) {
  const cards = items.map((d) => dealCardHtml(d, c)).join("");
  const stageAttr = opts.stage ? ` data-stage="${esc(opts.stage)}"` : "";
  const fixedCls = opts.won ? " won" : opts.lost ? " lost" : "";
  return `<div class="col${fixedCls}"${stageAttr}><h4>${esc(label)} <span>${items.length}</span></h4>
      <div class="cards">${cards || '<div class="m" style="padding:6px">—</div>'}</div></div>`;
}
// Matriz de Negócios = quadro por pipeline. Cada conta pode ter até 5
// pipelines (gerenciados em Cadastros); as etapas de cada
// um são configuráveis, mas "Ganho" e "Perdido" são fixos — não entram na
// lista de etapas do pipeline, sempre aparecem como as duas últimas colunas.
// Arrastar um card pra lá muda o status (e "Ganho" cria o projeto sozinho).
function renderKanban(c) {
  const pipelines = c.pipelines || [];
  if (!pipelines.length) {
    document.getElementById("main").innerHTML =
      `<div class="empty">Nenhum pipeline criado ainda.<br>Acesse <b>Cadastros → Pipeline</b> para criar um (até ${MAX_PIPELINES}).</div>`;
    return;
  }
  if (!state.kanbanPipelineId || !pipelines.some((p) => p.id === state.kanbanPipelineId)) {
    state.kanbanPipelineId = pipelines[0].id;
  }
  const activeId = state.kanbanPipelineId;
  const pipeline = c.pipelineById[activeId];
  const tabs = pipelines.map((p) =>
    `<button class="pipeline-tab${p.id === activeId ? " active" : ""}" data-id="${esc(p.id)}">${esc(p.name)}</button>`).join("");
  const rows = rowsFor("deals", c).filter((d) => d.pipeline_id === activeId);
  const stageCols = (pipeline?.stages || []).map((st) =>
    dealColumnHtml(st, rows.filter((d) => d.stage === st && d.status === "open"), c, { stage: st })).join("");
  const won = dealColumnHtml("Ganho", rows.filter((d) => d.status === "won"), c, { won: true });
  const lost = dealColumnHtml("Perdido", rows.filter((d) => d.status === "lost"), c, { lost: true });
  document.getElementById("main").innerHTML = `<div class="pipeline-tabs">${tabs}</div><div class="kanban">${stageCols}${won}${lost}</div>`;

  document.querySelectorAll(".pipeline-tab").forEach((btn) =>
    btn.addEventListener("click", () => { state.kanbanPipelineId = btn.dataset.id; render(); }));
  document.querySelectorAll(".card").forEach((el) =>
    el.addEventListener("click", () => openForm("deals", el.dataset.id)));
  wireKanbanDnD(activeId);
}
function renderActivityKanban(c) {
  const tasks = rowsFor("activities", c);
  const columnsHtml = TASK_STATUS.map((status) => {
    const items = tasks.filter((task) => (task.status || "todo") === status.id);
    const cards = items.map((task) => {
      const owner = c.userById[task.owner_id]?.full_name || c.userById[task.owner_id]?.name || "Sem responsável";
      const blocked = taskIsBlocked(task);
      return `<div class="card${blocked ? " blocked" : ""}" data-id="${esc(task.id)}">
        <div class="t">${esc(activityDisplayName(task))}</div>
        <div class="m">${esc(task.client_name)} · ${esc(task.project_name)}</div>
        <div class="m">${esc(owner)}${task.due_date ? ` · ${esc(dt(task.due_date))}` : ""}</div>
        ${blocked ? '<div class="task-dependency blocked">Aguardando tarefa anterior</div>' : ""}
      </div>`;
    }).join("");
    return `<div class="col" data-status="${status.id}"><h4>${status.label} <span>${items.length}</span></h4>
      <div class="cards">${cards || '<div class="m" style="padding:6px">—</div>'}</div></div>`;
  }).join("");
  document.getElementById("main").innerHTML = `<div class="kanban">${columnsHtml}</div>`;
  document.querySelectorAll("#main .card").forEach((card) => {
    card.draggable = true;
    card.addEventListener("dragstart", (event) => {
      event.dataTransfer.setData("text/plain", card.dataset.id);
      card.classList.add("dragging");
    });
    card.addEventListener("dragend", () => card.classList.remove("dragging"));
  });
  document.querySelectorAll("#main .col").forEach((column) => {
    column.addEventListener("dragover", (event) => { event.preventDefault(); column.classList.add("drag-over"); });
    column.addEventListener("dragleave", () => column.classList.remove("drag-over"));
    column.addEventListener("drop", async (event) => {
      event.preventDefault();
      column.classList.remove("drag-over");
      const taskId = event.dataTransfer.getData("text/plain");
      if (!taskId) return;
      try {
        await updateProjectTask(taskId, { status: column.dataset.status });
        render();
      } catch (err) { toast("Erro ao mover tarefa · " + err.message, true); }
    });
  });
}

function dateOnly(value) {
  if (!value) return null;
  const date = new Date(`${String(value).slice(0, 10)}T12:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isoDay(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function timelineItem(tab, row, c) {
  if (tab === "deals") return {
    id: row.id, title: row.title, detail: c.companyById[row.company_id]?.legal_name || c.companyById[row.company_id]?.name || "Sem empresa",
    start: row.expected_close_date, end: row.expected_close_date
  };
  if (tab === "projects") return {
    id: row.id, title: c.productById[row.product_id]?.name || row.name || "Entrega",
    detail: c.companyById[row.company_id]?.legal_name || "Sem cliente", start: row.start_date, end: row.end_date || row.start_date
  };
  if (tab === "activities") return {
    id: row.id, title: activityDisplayName(row), detail: `${row.client_name || "Sem cliente"} · ${row.product_name || "Sem produto"}`,
    start: row.due_date, end: row.due_date
  };
  return null;
}

function openTimelineRecord(tab, id) {
  if (tab === "deals") openForm("deals", id);
  else if (tab === "projects") openProjectBoard(id);
  else if (tab === "activities") openActivityChecklist(id);
}

function renderCalendar(c) {
  const cursor = state.calendarCursor ? dateOnly(`${state.calendarCursor}-01`) : new Date();
  const monthStart = new Date(cursor.getFullYear(), cursor.getMonth(), 1, 12);
  state.calendarCursor = `${monthStart.getFullYear()}-${String(monthStart.getMonth() + 1).padStart(2, "0")}`;
  const gridStart = new Date(monthStart);
  gridStart.setDate(gridStart.getDate() - gridStart.getDay());
  const items = rowsFor(state.tab, c).map((row) => timelineItem(state.tab, row, c)).filter((item) => item && dateOnly(item.start));
  const byDay = new Map();
  items.forEach((item) => {
    const key = String(item.start).slice(0, 10);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(item);
  });
  const weekdays = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"]
    .map((day) => `<div class="calendar-weekday">${day}</div>`).join("");
  const today = isoDay(new Date());
  const days = Array.from({ length: 42 }, (_, index) => {
    const date = new Date(gridStart);
    date.setDate(gridStart.getDate() + index);
    const key = isoDay(date);
    const dayItems = byDay.get(key) || [];
    return `<div class="calendar-day${date.getMonth() !== monthStart.getMonth() ? " outside" : ""}${key === today ? " today" : ""}">
      <span class="calendar-date">${date.getDate()}</span>
      ${dayItems.map((item) => `<button class="calendar-item" data-id="${esc(item.id)}" title="${esc(item.detail)}">${esc(item.title)}</button>`).join("")}
    </div>`;
  }).join("");
  document.getElementById("main").innerHTML = `<div class="calendar-view">
    <div class="calendar-toolbar"><strong>${monthStart.toLocaleDateString("pt-BR", { month: "long", year: "numeric" })}</strong>
      <div class="calendar-nav"><button class="btn" id="calendar-prev" title="Mês anterior">‹</button><button class="btn" id="calendar-today">Hoje</button><button class="btn" id="calendar-next" title="Próximo mês">›</button></div>
    </div><div class="calendar-grid">${weekdays}${days}</div></div>`;
  const move = (months) => {
    monthStart.setMonth(monthStart.getMonth() + months);
    state.calendarCursor = `${monthStart.getFullYear()}-${String(monthStart.getMonth() + 1).padStart(2, "0")}`;
    render();
  };
  document.getElementById("calendar-prev").addEventListener("click", () => move(-1));
  document.getElementById("calendar-next").addEventListener("click", () => move(1));
  document.getElementById("calendar-today").addEventListener("click", () => { state.calendarCursor = null; render(); });
  document.querySelectorAll(".calendar-item").forEach((button) =>
    button.addEventListener("click", () => openTimelineRecord(state.tab, button.dataset.id)));
}

function renderGantt(c) {
  const items = rowsFor(state.tab, c).map((row) => timelineItem(state.tab, row, c)).filter((item) => item && dateOnly(item.start));
  if (!items.length) {
    document.getElementById("main").innerHTML = '<div class="empty">Nenhum registro com data para exibir no Gantt.</div>';
    return;
  }
  const starts = items.map((item) => dateOnly(item.start).getTime());
  const ends = items.map((item) => (dateOnly(item.end) || dateOnly(item.start)).getTime());
  const min = Math.min(...starts);
  const max = Math.max(...ends, min + 86400000);
  const span = Math.max(86400000, max - min);
  const rows = items.sort((a, b) => dateOnly(a.start) - dateOnly(b.start)).map((item) => {
    const start = dateOnly(item.start).getTime();
    const end = (dateOnly(item.end) || dateOnly(item.start)).getTime();
    const left = Math.max(0, (start - min) / span * 100);
    const width = Math.max(1.5, (Math.max(end, start + 86400000) - start) / span * 100);
    return `<div class="gantt-row"><div class="gantt-label"><strong>${esc(item.title)}</strong><small>${esc(item.detail)}</small></div>
      <div class="gantt-track"><button class="gantt-bar" data-id="${esc(item.id)}" style="left:${left}%;width:${Math.min(width, 100 - left)}%" title="${esc(dt(item.start))} a ${esc(dt(item.end || item.start))}">${esc(item.title)}</button></div></div>`;
  }).join("");
  document.getElementById("main").innerHTML = `<div class="gantt-view"><div class="gantt-board">
    <div class="gantt-head"><div>Registro</div><div>${esc(dt(isoDay(new Date(min))))} a ${esc(dt(isoDay(new Date(max))))}</div></div>${rows}
  </div></div>`;
  document.querySelectorAll(".gantt-bar").forEach((button) =>
    button.addEventListener("click", () => openTimelineRecord(state.tab, button.dataset.id)));
}

function wireKanbanDnD(pipelineId) {
  document.querySelectorAll(".card").forEach((card) => {
    card.draggable = true;
    card.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/plain", card.dataset.id);
      card.classList.add("dragging");
    });
    card.addEventListener("dragend", () => card.classList.remove("dragging"));
  });
  document.querySelectorAll(".col").forEach((col) => {
    col.addEventListener("dragover", (e) => { e.preventDefault(); col.classList.add("drag-over"); });
    col.addEventListener("dragleave", () => col.classList.remove("drag-over"));
    col.addEventListener("drop", async (e) => {
      e.preventDefault();
      col.classList.remove("drag-over");
      const id = e.dataTransfer.getData("text/plain");
      if (!id) return;
      const isWon = col.classList.contains("won");
      const isLost = col.classList.contains("lost");
      await moveDealCard(id, { pipelineId, stage: col.dataset.stage || null, isWon, isLost });
    });
  });
}
async function moveDealCard(id, { pipelineId, stage, isWon, isLost }) {
  const deal = cache.deals.find((d) => d.id === id);
  if (!deal) return;
  const body = isWon ? { status: "won" } : isLost ? { status: "lost" } : { stage, status: "open" };
  try {
    await updateRow("deals", id, body);
    if (isWon) await createProjectFromDeal({ ...deal, ...body });
    await init();
  } catch (err) {
    toast("Erro ao mover negócio · " + err.message, true);
  }
}

function renderDashboard(c) {
  const deals = c.deals || [];
  const openDeals = deals.filter((d) => d.status === "open");
  const wonDeals = deals.filter((d) => d.status === "won");
  const totalOpen = openDeals.reduce((sum, d) => sum + Number(d.amount || 0), 0);
  const metrics = [
    ["Pessoas", c.contacts.length],
    ["Empresas", c.companies.length],
    ["Negócios abertos", openDeals.length],
    ["Pipeline", brl(totalOpen)],
    ["Produtos", c.products.length],
    ["Entregas", c.projects.length],
    ["Negócios ganhos", wonDeals.length],
    ["Receita ganha", brl(wonDeals.reduce((sum, d) => sum + Number(d.amount || 0), 0))]
  ].map(([k, v]) => `<div class="metric"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`).join("");
  document.getElementById("main").innerHTML = `<div class="dashboard">${metrics}</div>`;
}

function refreshActivityCache() {
  if (!cache) return;
  const tasks = loadProjectTasks();
  const objectives = loadDeliveryObjectives();
  cache.deliveryObjectiveById = Object.fromEntries(objectives.map((objective) => [objective.id, objective]));
  cache.activityById = Object.fromEntries(tasks.map((task) => [task.id, task]));
  cache.activities = tasks.map((task) => {
    const project = cache.projectById[task.project_id];
    const company = project ? cache.companyById[project.company_id] : null;
    const objective = cache.deliveryObjectiveById[task.objective_id];
    return {
      ...task,
      project_name: project?.name || "Entrega não encontrada",
      product_name: project ? cache.productById[project.product_id]?.name || "Sem produto" : "Sem produto",
      company_id: project?.company_id || null,
      client_name: project?.client_name || company?.legal_name || company?.trade_name || "Sem cliente",
      activity_origin: task.source_template_id ? "product" : "daily",
      objective_name: objective?.name || "—"
    };
  });
}

function renderHome(c) {
  refreshActivityCache();
  const today = new Date().toISOString().slice(0, 10);
  const activities = c.activities || [];
  const pending = activities.filter((task) => task.status !== "done");
  const overdue = pending.filter((task) => task.due_date && task.due_date < today);
  const openDeals = (c.deals || []).filter((deal) => deal.status === "open");
  const activeProjects = (c.projects || []).filter((project) => project.status === "in_progress" || project.status === "planned");
  const revenue = (c.deals || []).filter((deal) => deal.status === "won").reduce((sum, deal) => sum + Number(deal.amount || 0), 0);
  const metrics = [
    ["Pessoas", c.contacts.length],
    ["Empresas", c.companies.length],
    ["Negócios abertos", openDeals.length],
    ["Entregas ativas", activeProjects.length],
    ["Tarefas pendentes", pending.length],
    ["Receita ganha", brl(revenue)]
  ].map(([label, value]) => `<div class="metric"><div class="k">${esc(label)}</div><div class="v">${esc(value)}</div></div>`).join("");

  const upcoming = [...pending]
    .sort((a, b) => (a.due_date || "9999-12-31").localeCompare(b.due_date || "9999-12-31"))
    .slice(0, 8);
  const activityRows = upcoming.map((task) => `<tr>
    <td>${esc(activityDisplayName(task))}</td>
    <td>${esc(task.client_name)}</td>
    <td>${esc(task.project_name)}</td>
    <td>${esc(task.due_date ? dt(task.due_date) : "—")}</td>
    <td>${badge(task.status === "doing" ? "negotiation" : "lead", TASK_STATUS.find((s) => s.id === task.status)?.label || "A fazer")}</td>
    <td class="act"><button class="rowbtn home-project-btn" data-project-id="${esc(task.project_id)}" title="Abrir entrega">☷</button></td>
  </tr>`).join("");
  const projectStatuses = PROJECT_STATUSES.map((status) => {
    const count = (c.projects || []).filter((project) => project.status === status).length;
    return `<div class="home-status-row"><span>${esc(PROJECT_STATUS_LABEL[status])}</span><strong>${count}</strong></div>`;
  }).join("");

  document.getElementById("main").innerHTML = `<div class="home">
    <div class="home-metrics">${metrics}</div>
    <div class="home-grid">
      <section class="home-panel">
        <h3>Próximas tarefas</h3>
        <div class="task-table-wrap"><table><thead><tr><th>Tarefa</th><th>Cliente</th><th>Entrega</th><th>Prazo</th><th>Status</th><th></th></tr></thead>
        <tbody>${activityRows || '<tr><td colspan="6" class="empty">Nenhuma tarefa pendente.</td></tr>'}</tbody></table></div>
      </section>
      <section class="home-panel">
        <h3>Entregas por status</h3>
        <div class="home-status-list">${projectStatuses}<div class="home-status-row"><span>Tarefas atrasadas</span><strong class="neg">${overdue.length}</strong></div></div>
      </section>
    </div>
  </div>`;
  document.querySelectorAll(".home-project-btn").forEach((button) =>
    button.addEventListener("click", () => openProjectBoard(button.dataset.projectId)));
}

function renderMatrix(c) {
  if (state.tab === "deals") { renderKanban(c); return; }
  const rows = rowsFor(state.tab, c);
  const cols = columns(state.tab, c).slice(0, 4);
  const cards = rows.map((r) => {
    const lines = cols.map((col) => {
      const val = col.fmt ? col.fmt(r[col.k], r, c) : esc(r[col.k] ?? "—");
      return `<div class="line"><span class="muted">${esc(col.h)}</span><strong>${val}</strong></div>`;
    }).join("");
    return `<div class="matrix-card"><h4>${esc(r.name || r.legal_name || r.title || r[pk(state.tab)])}</h4>${lines}</div>`;
  }).join("");
  document.getElementById("main").innerHTML = cards ? `<div class="matrix">${cards}</div>` : `<div class="empty">Nenhum registro.</div>`;
}

let productActivityState = { productId: null, editId: null, objectiveEditId: null, goalEditId: null, tab: "activities" };
let productActivityChecklistDraft = [];
let productActivityRelatedIds = [];
let productActivityDraftGroupId = null;

function productActivityIdentity(item) {
  return [item?.group, item?.sector, item?.channel, item?.type, item?.activity, item?.recurrence || "once"]
    .map((value) => String(value || "").trim().toLocaleLowerCase("pt-BR"))
    .join("|");
}

function renderProductActivityChecklistEditor() {
  const root = document.getElementById("pa-checklist");
  if (!root) return;
  root.innerHTML = productActivityChecklistDraft.map((item) => `<div class="checklist-edit-row" data-id="${esc(item.id)}">
    <input type="text" value="${esc(item.text)}" placeholder="Item do checklist">
    <button class="rowbtn checklist-draft-remove" type="button" title="Remover item">✕</button>
  </div>`).join("") || '<span class="muted">Nenhum item cadastrado.</span>';
  root.querySelectorAll(".checklist-edit-row").forEach((row) => {
    row.querySelector("input").addEventListener("input", (event) => {
      const item = productActivityChecklistDraft.find((candidate) => candidate.id === row.dataset.id);
      if (item) item.text = event.target.value;
    });
    row.querySelector(".checklist-draft-remove").addEventListener("click", () => {
      productActivityChecklistDraft = productActivityChecklistDraft.filter((item) => item.id !== row.dataset.id);
      renderProductActivityChecklistEditor();
    });
  });
}

function openProductActivities(productId, opts = {}) {
  const product = cache.productById[productId];
  if (!product) return;
  productActivityState = { productId, editId: null, objectiveEditId: null, goalEditId: null, tab: "activities" };
  const headerCenter = `<div class="modal-header-tabs" role="tablist" aria-label="Configuração do produto">
    <button class="modal-header-tab active" data-product-tab="activities" role="tab">Tarefas</button>
    <button class="modal-header-tab" data-product-tab="objectives" role="tab">Objetivos</button>
    <button class="modal-header-tab" data-product-tab="goals" role="tab">Metas</button>
  </div>`;
  const returnSection = opts.returnToRegistrations || null;
  shell(`Produto · ${product.name}`, `<div id="product-activities-root"></div>`, {
    cls: "full",
    headerCenter,
    onClose: returnSection ? () => openRegistrationsModal(returnSection) : null
  });
  document.querySelectorAll("[data-product-tab]").forEach((button) => button.addEventListener("click", () => {
    closeProductActivityDrawer();
    productActivityState.tab = button.dataset.productTab;
    document.querySelectorAll("[data-product-tab]").forEach((tab) => tab.classList.toggle("active", tab === button));
    renderProductWorkspace();
  }));
  renderProductWorkspace();
}

function renderProductWorkspace() {
  if (productActivityState.tab === "objectives") renderProductObjectives();
  else if (productActivityState.tab === "goals") renderProductGoals();
  else renderProductActivities();
  wireSecondaryTableSelection(
    document.querySelector("#product-activities-root table"),
    `product:${productActivityState.productId}:${productActivityState.tab}`
  );
}

function renderProductActivities() {
  const root = document.getElementById("product-activities-root");
  if (!root) return;
  const templates = loadProductActivities()
    .filter((item) => item.product_id === productActivityState.productId)
    .sort((a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0) || String(a.created_at || "").localeCompare(String(b.created_at || "")));
  const rows = templates.map((item) => `<tr class="pa-row" data-id="${esc(item.id)}" draggable="true">
    <td class="pa-drag" title="Arraste para mudar a ordem">⠿</td>
    <td>${esc(item.group || "—")}</td><td>${esc(item.sector || "—")}</td>
    <td>${esc(item.channel || "—")}</td><td>${esc(item.type || "—")}</td><td>${esc(RECURRENCE_LABEL[item.recurrence] || "Única")}</td>
    <td>${esc(activityDisplayName(item))}</td><td>${esc(item.information || "—")}</td>
    <td>${normalizeChecklist(item.checklist).length} item(ns)</td>
    <td>${esc(loadProductObjectives().find((objective) => objective.id === item.objective_template_id)?.name || "—")}</td>
    <td>${priorityBadge(item.priority)}</td>
    <td>${esc(responsibilityNames(item.default_assignee_ids, item.default_owner_id, item.default_assignee_job_titles))}</td>
    <td>${esc(dependencyNames(item.dependency_template_ids, item.depends_on_template_id, templates))}</td>
    <td class="act">
      <button class="rowbtn pa-delete" data-id="${esc(item.id)}" title="Desvincular do produto">✕</button>
    </td></tr>`).join("");
  root.innerHTML = `<div class="modal-toolbar"><span class="muted">${templates.length} tarefa(s) vinculada(s)</span><div class="modal-toolbar-actions"><button class="btn primary" id="pa-ready">Vincular tarefas</button></div></div>
    <div class="product-activity-list"><table><thead><tr>
      <th class="noclick"></th><th>Grupo</th><th>Setor</th><th>Canal</th><th>Tipo</th><th>Recorrência</th><th>Tarefa</th><th>Informação</th><th>Checklist</th><th>Objetivo</th><th>Prioridade</th><th>Responsáveis padrão</th><th>Depende de</th><th>Ações</th>
    </tr></thead><tbody id="pa-tbody">${rows || '<tr><td colspan="14" class="empty">Nenhuma tarefa cadastrada para este produto.</td></tr>'}</tbody></table></div>`;
  document.getElementById("pa-ready").addEventListener("click", openReadyActivityPicker);
  document.querySelectorAll(".pa-delete").forEach((button) => button.addEventListener("click", async () => {
    if (!window.confirm("Desvincular esta tarefa do produto? Entregas que já receberam a tarefa manterão a cópia existente.")) return;
    try {
       if (isLive()) {
         const dependents = cache.productActivities.filter((item) => normalizeIdList(item.dependency_template_ids, item.depends_on_template_id).includes(button.dataset.id));
         for (const item of dependents) {
           item.dependency_template_ids = normalizeIdList(item.dependency_template_ids, item.depends_on_template_id).filter((id) => id !== button.dataset.id);
           item.depends_on_template_id = item.dependency_template_ids[0] || null;
           await updateRow("productActivities", item.id, { dependency_template_ids: item.dependency_template_ids, depends_on_template_id: item.depends_on_template_id });
         }
         await deleteRow("productActivities", button.dataset.id);
         cache.productActivities = cache.productActivities.filter((item) => item.id !== button.dataset.id);
       } else {
         const remaining = loadProductActivities().filter((item) => item.id !== button.dataset.id);
         remaining.forEach((item) => {
           item.dependency_template_ids = normalizeIdList(item.dependency_template_ids, item.depends_on_template_id).filter((id) => id !== button.dataset.id);
           item.depends_on_template_id = item.dependency_template_ids[0] || null;
         });
         saveProductActivities(remaining);
      }
      const tasks = loadProjectTasks();
      tasks.forEach((task) => {
        if (task.source_template_id === button.dataset.id) task.source_template_id = null;
      });
      if (isLive()) cache.activityRecords = tasks;
      else saveProjectTasks(tasks);
      refreshActivityCache();
      renderProductActivities();
      toast("Tarefa desvinculada do produto.");
    } catch (err) { toast("Erro ao excluir tarefa · " + err.message, true); }
  }));
  wireProductActivityDragAndDrop();
}

function renderProductObjectives() {
  const root = document.getElementById("product-activities-root");
  if (!root) return;
  const objectives = loadProductObjectives()
    .filter((item) => item.product_id === productActivityState.productId)
    .sort((a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0) || String(a.created_at || "").localeCompare(String(b.created_at || "")));
  const activities = loadProductActivities().filter((item) => item.product_id === productActivityState.productId);
  const rows = objectives.map((item) => {
    const owner = cache.userById[item.default_owner_id]?.full_name || cache.userById[item.default_owner_id]?.name || "—";
    const activityCount = activities.filter((activity) => activity.objective_template_id === item.id).length;
    const dependencyObjectives = normalizeIdList(item.dependency_objective_template_ids)
      .map((id) => objectives.find((objective) => objective.id === id)?.name).filter(Boolean);
    const dependencyActivities = normalizeIdList(item.dependency_activity_template_ids)
      .map((id) => activities.find((activity) => activity.id === id)).filter(Boolean).map(activityDisplayName);
    const dependencies = [...dependencyObjectives, ...dependencyActivities].join(", ") || "—";
    return `<tr>
      <td><strong>${esc(item.name)}</strong></td>
      <td>${esc(item.completion_criteria || "—")}</td>
      <td>${esc(dependencies)}</td>
      <td>${esc(owner)}</td>
      <td>${item.target_days == null || item.target_days === "" ? "—" : `${esc(item.target_days)} dia(s)`}</td>
      <td>${activityCount}</td>
      <td class="act">
        <button class="rowbtn po-edit" data-id="${esc(item.id)}" title="Editar">✎</button>
        <button class="rowbtn po-delete" data-id="${esc(item.id)}" title="Excluir">✕</button>
      </td>
    </tr>`;
  }).join("");
  root.innerHTML = `<div class="modal-toolbar"><span class="muted">${objectives.length} objetivo(s) do produto</span><button class="btn primary" id="po-new">+ Objetivo</button></div>
    <div class="product-activity-list"><table><thead><tr>
      <th>Objetivo</th><th>Critério de conclusão</th><th>Depende de</th><th>Responsável padrão</th><th>Prazo sugerido</th><th>Tarefas</th><th></th>
    </tr></thead><tbody>${rows || '<tr><td colspan="7" class="empty">Nenhum objetivo cadastrado para este produto.</td></tr>'}</tbody></table></div>`;
  document.getElementById("po-new").addEventListener("click", () => openProductObjectiveDrawer());
  document.querySelectorAll(".po-edit").forEach((button) => button.addEventListener("click", () => openProductObjectiveDrawer(button.dataset.id)));
  document.querySelectorAll(".po-delete").forEach((button) => button.addEventListener("click", () => deleteProductObjective(button.dataset.id)));
}

function openProductObjectiveDrawer(editId = null) {
  closeProductActivityDrawer();
  productActivityState.objectiveEditId = editId;
  const objectives = loadProductObjectives().filter((item) => item.product_id === productActivityState.productId);
  const current = objectives.find((item) => item.id === editId) || {};
  const objectiveDependencyOptions = objectives
    .filter((item) => item.id !== editId)
    .map((item) => ({ value: item.id, label: item.name }));
  const activityDependencyOptions = loadProductActivities()
    .filter((item) => item.product_id === productActivityState.productId)
    .map((item) => ({ value: item.id, label: activityDisplayName(item) }));
  const overlay = document.createElement("div");
  overlay.id = "product-activity-drawer-overlay";
  overlay.className = "activity-form-overlay";
  overlay.innerHTML = `<aside class="activity-form-drawer">
    <h3>${current.id ? "Editar objetivo" : "Novo objetivo"}<button class="modal-close-x" id="po-close" title="Fechar">✕</button></h3>
    <div class="form product-activity-form">
      <div class="field"><label>Objetivo *</label><input id="po-name" value="${esc(current.name || "")}" placeholder="Ex.: Entrar no Full do Mercado Livre"></div>
      <div class="field"><label>Critério de conclusão</label><textarea id="po-criteria" rows="5" placeholder="Como saberemos que este objetivo foi alcançado?">${esc(current.completion_criteria || "")}</textarea></div>
      <div class="field"><label>Responsável padrão</label><select id="po-owner">${userOptions(current.default_owner_id || "")}</select></div>
      <div class="field"><label>Prazo sugerido (dias)</label><input id="po-target-days" type="number" min="0" step="1" value="${esc(current.target_days ?? "")}" placeholder="Ex.: 30"></div>
      <div class="field"><label>Depende de objetivos</label>${multiPickerHtml("po-objective-dependencies", objectiveDependencyOptions, new Set(normalizeIdList(current.dependency_objective_template_ids)), "Selecionar objetivos")}</div>
      <div class="field"><label>Depende de tarefas</label>${multiPickerHtml("po-activity-dependencies", activityDependencyOptions, new Set(normalizeIdList(current.dependency_activity_template_ids)), "Selecionar tarefas")}</div>
    </div>
    <div class="modal-foot"><button class="btn" id="po-cancel">Cancelar</button><button class="btn primary" id="po-save">${current.id ? "Salvar" : "Criar"}</button></div>
  </aside>`;
  document.querySelector("#ov .modal.full")?.appendChild(overlay);
  overlay.addEventListener("click", (event) => { if (event.target === overlay) closeProductActivityDrawer(); });
  document.getElementById("po-close").addEventListener("click", closeProductActivityDrawer);
  document.getElementById("po-cancel").addEventListener("click", closeProductActivityDrawer);
  document.getElementById("po-save").addEventListener("click", saveProductObjective);
  wireMultiPicker("po-objective-dependencies");
  wireMultiPicker("po-activity-dependencies");
  document.getElementById("po-name")?.focus();
}

function createsObjectiveDependencyCycle(rows, currentId, dependencyIds) {
  const reachesCurrent = (candidateId, path = new Set()) => {
    if (!candidateId) return false;
    if (candidateId === currentId) return true;
    if (path.has(candidateId)) return false;
    const candidate = rows.find((item) => item.id === candidateId);
    const nextPath = new Set(path).add(candidateId);
    return normalizeIdList(candidate?.dependency_objective_template_ids)
      .some((nextId) => reachesCurrent(nextId, nextPath));
  };
  return dependencyIds.some((dependencyId) => reachesCurrent(dependencyId));
}

async function saveProductObjective() {
  const name = document.getElementById("po-name").value.trim();
  if (!name) { toast("Informe o objetivo.", true); return; }
  const rows = loadProductObjectives();
  const current = rows.find((item) => item.id === productActivityState.objectiveEditId);
  const recordId = current?.id || crypto.randomUUID();
  const dependencyObjectiveIds = multiPickerValues("po-objective-dependencies");
  const dependencyActivityIds = multiPickerValues("po-activity-dependencies");
  if (createsObjectiveDependencyCycle(rows, recordId, dependencyObjectiveIds)) {
    toast("Essa dependência criaria um ciclo entre os objetivos.", true);
    return;
  }
  const productRows = rows.filter((item) => item.product_id === productActivityState.productId);
  const targetValue = document.getElementById("po-target-days").value;
  const body = {
    product_id: productActivityState.productId,
    name,
    completion_criteria: document.getElementById("po-criteria").value.trim(),
    default_owner_id: document.getElementById("po-owner").value || null,
    dependency_objective_template_ids: dependencyObjectiveIds,
    dependency_activity_template_ids: dependencyActivityIds,
    target_days: targetValue === "" ? null : Number(targetValue),
    sort_order: current?.sort_order ?? (Math.max(-1, ...productRows.map((item) => Number(item.sort_order || 0))) + 1),
    updated_at: new Date().toISOString()
  };
  try {
    if (current) {
      const saved = isLive() ? await updateRow("productObjectives", current.id, body) : { ...current, ...body };
      Object.assign(current, saved);
    } else {
      const draft = { id: recordId, ...body, created_at: new Date().toISOString() };
      rows.push(isLive() ? await createRow("productObjectives", draft) : draft);
    }
    if (isLive()) cache.productObjectives = rows;
    else saveProductObjectives(rows);
    await syncProductObjectives();
    await syncProductActivities();
    refreshActivityCache();
    closeProductActivityDrawer();
    if (document.getElementById("registrations-root")) renderRegistrationsSection();
    else renderProductObjectives();
    toast("Objetivo do produto salvo.");
  } catch (err) { toast("Erro ao salvar objetivo · " + err.message, true); }
}

async function deleteProductObjective(objectiveId) {
  const linked = loadProductActivities().filter((item) => item.objective_template_id === objectiveId).length;
  const detail = linked ? ` ${linked} tarefa(s) ficarão sem objetivo.` : "";
  if (!window.confirm(`Excluir este objetivo?${detail}`)) return;
  try {
    if (isLive()) await deleteRow("productObjectives", objectiveId);
    const objectives = loadProductObjectives().filter((item) => item.id !== objectiveId);
    const activities = loadProductActivities();
    activities.forEach((item) => { if (item.objective_template_id === objectiveId) item.objective_template_id = null; });
    if (isLive()) {
      cache.productObjectives = objectives;
      cache.productActivities = activities;
    } else {
      saveProductObjectives(objectives);
      saveProductActivities(activities);
    }
    renderProductObjectives();
    toast("Objetivo removido.");
  } catch (err) { toast("Erro ao excluir objetivo · " + err.message, true); }
}

const GOAL_COMPARISON_LABEL = { at_least: "No mínimo", at_most: "No máximo", exactly: "Igual a" };

function renderProductGoals() {
  const root = document.getElementById("product-activities-root");
  if (!root) return;
  const goals = loadProductGoals()
    .filter((item) => item.product_id === productActivityState.productId)
    .sort((a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0));
  const rows = goals.map((item) => {
    const owner = cache.userById[item.default_owner_id]?.full_name || cache.userById[item.default_owner_id]?.name || "—";
    const target = `${GOAL_COMPARISON_LABEL[item.comparison] || "No mínimo"} ${Number(item.target_value).toLocaleString("pt-BR")} ${item.unit || ""}`.trim();
    const dependencyGoals = normalizeIdList(item.dependency_goal_template_ids)
      .map((id) => goals.find((goal) => goal.id === id)?.name).filter(Boolean);
    const dependencyActivities = normalizeIdList(item.dependency_activity_template_ids)
      .map((id) => loadProductActivities().find((activity) => activity.id === id)).filter(Boolean).map(activityDisplayName);
    const dependencies = [...dependencyGoals, ...dependencyActivities].join(", ") || "—";
    return `<tr>
      <td><strong>${esc(item.name)}</strong></td>
      <td>${esc(item.metric)}</td>
      <td>${esc(target)}</td>
      <td>${esc(dependencies)}</td>
      <td>${item.target_days == null ? "—" : `${esc(item.target_days)} dia(s)`}</td>
      <td>${esc(owner)}</td>
      <td class="act"><button class="rowbtn pg-edit" data-id="${esc(item.id)}" title="Editar">✎</button><button class="rowbtn pg-delete" data-id="${esc(item.id)}" title="Excluir">✕</button></td>
    </tr>`;
  }).join("");
  root.innerHTML = `<div class="modal-toolbar"><span class="muted">${goals.length} meta(s) do produto</span><button class="btn primary" id="pg-new">+ Meta</button></div>
    <div class="product-activity-list"><table><thead><tr>
    <th>Meta</th><th>Indicador</th><th>Valor-alvo</th><th>Depende de</th><th>Prazo sugerido</th><th>Responsável padrão</th><th></th>
  </tr></thead><tbody>${rows || '<tr><td colspan="7" class="empty">Nenhuma meta cadastrada para este produto.</td></tr>'}</tbody></table></div>`;
  document.getElementById("pg-new").addEventListener("click", () => openProductGoalDrawer());
  document.querySelectorAll(".pg-edit").forEach((button) => button.addEventListener("click", () => openProductGoalDrawer(button.dataset.id)));
  document.querySelectorAll(".pg-delete").forEach((button) => button.addEventListener("click", () => deleteProductGoal(button.dataset.id)));
}

function openProductGoalDrawer(editId = null) {
  closeProductActivityDrawer();
  productActivityState.goalEditId = editId;
  const current = loadProductGoals().find((item) => item.id === editId) || {};
  const comparisonOptions = Object.entries(GOAL_COMPARISON_LABEL).map(([value, label]) =>
    `<option value="${value}"${value === (current.comparison || "at_least") ? " selected" : ""}>${label}</option>`).join("");
  const goalDependencyOptions = loadProductGoals()
    .filter((item) => item.product_id === productActivityState.productId && item.id !== editId)
    .map((item) => ({ value: item.id, label: item.name }));
  const activityDependencyOptions = loadProductActivities()
    .filter((item) => item.product_id === productActivityState.productId)
    .map((item) => ({ value: item.id, label: activityDisplayName(item) }));
  const overlay = document.createElement("div");
  overlay.id = "product-activity-drawer-overlay";
  overlay.className = "activity-form-overlay";
  overlay.innerHTML = `<aside class="activity-form-drawer">
    <h3>${current.id ? "Editar meta" : "Nova meta"}<button class="modal-close-x" id="pg-close" title="Fechar">✕</button></h3>
    <div class="form product-activity-form">
      <div class="field"><label>Meta *</label><input id="pg-name" value="${esc(current.name || "")}" placeholder="Ex.: Atingir 500 pedidos mensais"></div>
      <div class="field"><label>Indicador *</label><input id="pg-metric" value="${esc(current.metric || "")}" placeholder="Ex.: Pedidos por mês"></div>
      <div class="field"><label>Condição</label><select id="pg-comparison">${comparisonOptions}</select></div>
      <div class="field"><label>Valor-alvo *</label><input id="pg-target" type="number" step="any" value="${esc(current.target_value ?? "")}" placeholder="Ex.: 500"></div>
      <div class="field"><label>Unidade</label><input id="pg-unit" value="${esc(current.unit || "")}" placeholder="Ex.: pedidos/mês, %, R$"></div>
      <div class="field"><label>Prazo sugerido (dias)</label><input id="pg-target-days" type="number" min="0" step="1" value="${esc(current.target_days ?? "")}" placeholder="Ex.: 90"></div>
      <div class="field"><label>Responsável padrão</label><select id="pg-owner">${userOptions(current.default_owner_id || "")}</select></div>
      <div class="field"><label>Depende de metas</label>${multiPickerHtml("pg-goal-dependencies", goalDependencyOptions, new Set(normalizeIdList(current.dependency_goal_template_ids)), "Selecionar metas")}</div>
      <div class="field"><label>Depende de tarefas</label>${multiPickerHtml("pg-activity-dependencies", activityDependencyOptions, new Set(normalizeIdList(current.dependency_activity_template_ids)), "Selecionar tarefas")}</div>
    </div>
    <div class="modal-foot"><button class="btn" id="pg-cancel">Cancelar</button><button class="btn primary" id="pg-save">${current.id ? "Salvar" : "Criar"}</button></div>
  </aside>`;
  document.querySelector("#ov .modal.full")?.appendChild(overlay);
  overlay.addEventListener("click", (event) => { if (event.target === overlay) closeProductActivityDrawer(); });
  document.getElementById("pg-close").addEventListener("click", closeProductActivityDrawer);
  document.getElementById("pg-cancel").addEventListener("click", closeProductActivityDrawer);
  document.getElementById("pg-save").addEventListener("click", saveProductGoal);
  wireMultiPicker("pg-goal-dependencies");
  wireMultiPicker("pg-activity-dependencies");
  document.getElementById("pg-name")?.focus();
}

function createsGoalDependencyCycle(rows, currentId, dependencyIds) {
  const reachesCurrent = (candidateId, path = new Set()) => {
    if (!candidateId) return false;
    if (candidateId === currentId) return true;
    if (path.has(candidateId)) return false;
    const candidate = rows.find((item) => item.id === candidateId);
    const nextPath = new Set(path).add(candidateId);
    return normalizeIdList(candidate?.dependency_goal_template_ids)
      .some((nextId) => reachesCurrent(nextId, nextPath));
  };
  return dependencyIds.some((dependencyId) => reachesCurrent(dependencyId));
}

async function saveProductGoal() {
  const name = document.getElementById("pg-name").value.trim();
  const metric = document.getElementById("pg-metric").value.trim();
  const targetValue = document.getElementById("pg-target").value;
  if (!name || !metric || targetValue === "") { toast("Informe a meta, o indicador e o valor-alvo.", true); return; }
  const rows = loadProductGoals();
  const current = rows.find((item) => item.id === productActivityState.goalEditId);
  const recordId = current?.id || crypto.randomUUID();
  const dependencyGoalIds = multiPickerValues("pg-goal-dependencies");
  const dependencyActivityIds = multiPickerValues("pg-activity-dependencies");
  if (createsGoalDependencyCycle(rows, recordId, dependencyGoalIds)) {
    toast("Essa dependência criaria um ciclo entre as metas.", true);
    return;
  }
  const productRows = rows.filter((item) => item.product_id === productActivityState.productId);
  const targetDays = document.getElementById("pg-target-days").value;
  const body = {
    product_id: productActivityState.productId,
    name,
    metric,
    comparison: document.getElementById("pg-comparison").value,
    target_value: Number(targetValue),
    unit: document.getElementById("pg-unit").value.trim(),
    target_days: targetDays === "" ? null : Number(targetDays),
    default_owner_id: document.getElementById("pg-owner").value || null,
    dependency_goal_template_ids: dependencyGoalIds,
    dependency_activity_template_ids: dependencyActivityIds,
    sort_order: current?.sort_order ?? (Math.max(-1, ...productRows.map((item) => Number(item.sort_order || 0))) + 1),
    updated_at: new Date().toISOString()
  };
  try {
    if (current) {
      const saved = isLive() ? await updateRow("productGoals", current.id, body) : { ...current, ...body };
      Object.assign(current, saved);
    } else {
      const draft = { id: recordId, ...body, created_at: new Date().toISOString() };
      rows.push(isLive() ? await createRow("productGoals", draft) : draft);
    }
    if (isLive()) cache.productGoals = rows;
    else saveProductGoals(rows);
    await syncProductGoals();
    await syncDeliveryGoalDependencies();
    closeProductActivityDrawer();
    if (document.getElementById("registrations-root")) renderRegistrationsSection();
    else renderProductGoals();
    toast("Meta do produto salva.");
  } catch (err) { toast("Erro ao salvar meta · " + err.message, true); }
}

async function deleteProductGoal(goalId) {
  if (!window.confirm("Excluir esta meta do produto?")) return;
  try {
    if (isLive()) await deleteRow("productGoals", goalId);
    const rows = loadProductGoals().filter((item) => item.id !== goalId);
    if (isLive()) cache.productGoals = rows;
    else saveProductGoals(rows);
    renderProductGoals();
    toast("Meta removida.");
  } catch (err) { toast("Erro ao excluir meta · " + err.message, true); }
}

function cloneProductActivity(templateId) {
  openProductActivityDrawer(null, templateId);
}

function openReadyActivityPicker() {
  closeProductActivityDrawer();
  const current = loadProductActivities().filter((item) => item.product_id === productActivityState.productId);
  const currentSignatures = new Set(current.map((item) => [item.group, item.sector, item.channel, item.type, item.activity, item.recurrence || "once"].join("|")));
  const seen = new Set();
  const available = loadProductActivities().filter((item) => {
    if (item.product_id === productActivityState.productId) return false;
    const signature = [item.group, item.sector, item.channel, item.type, item.activity, item.recurrence || "once"].join("|");
    if (seen.has(signature) || currentSignatures.has(signature)) return false;
    seen.add(signature);
    return true;
  });
  const overlay = document.createElement("div");
  overlay.id = "product-activity-drawer-overlay";
  overlay.className = "activity-form-overlay";
  overlay.innerHTML = `<aside class="activity-form-drawer ready-activity-drawer">
    <h3>Escolher tarefa pronta<button class="modal-close-x" id="ready-close" title="Fechar">✕</button></h3>
    <div class="ready-activity-search"><input id="ready-activity-search" placeholder="Buscar tarefa..."></div>
    <div class="ready-activity-list" id="ready-activity-list"></div>
    <div class="modal-foot"><button class="btn" id="ready-cancel">Cancelar</button><button class="btn primary" id="ready-add">Adicionar selecionadas</button></div>
  </aside>`;
  document.querySelector("#ov .modal.full")?.appendChild(overlay);
  const list = document.getElementById("ready-activity-list");
  const draw = () => {
    const query = document.getElementById("ready-activity-search").value.trim().toLocaleLowerCase("pt-BR");
    const filtered = available.filter((item) => !query || activityDisplayName(item).toLocaleLowerCase("pt-BR").includes(query));
    list.innerHTML = filtered.map((item) => {
      const product = cache.productById[item.product_id]?.name || "Produto não encontrado";
      return `<label class="ready-activity-item"><input type="checkbox" value="${esc(item.id)}"><span><strong>${esc(activityDisplayName(item))}</strong><small>${esc(product)} · ${esc(RECURRENCE_LABEL[item.recurrence] || "Única")}</small></span></label>`;
    }).join("") || '<div class="empty">Nenhuma tarefa pronta disponível.</div>';
  };
  draw();
  document.getElementById("ready-activity-search").addEventListener("input", draw);
  document.getElementById("ready-close").addEventListener("click", closeProductActivityDrawer);
  document.getElementById("ready-cancel").addEventListener("click", closeProductActivityDrawer);
  document.getElementById("ready-add").addEventListener("click", async () => {
    const selectedIds = [...list.querySelectorAll('input[type="checkbox"]:checked')].map((input) => input.value);
    if (!selectedIds.length) { toast("Selecione pelo menos uma tarefa.", true); return; }
    const rows = loadProductActivities();
    const signatureOf = (item) => [item.group, item.sector, item.channel, item.type, item.activity, item.recurrence || "once"].join("|");
    const targetBySignature = new Map(current.map((item) => [signatureOf(item), item]));
    const orderedSources = [];
    const visited = new Set();
    const visitSource = (sourceId) => {
      if (!sourceId || visited.has(sourceId)) return;
      visited.add(sourceId);
      const source = rows.find((item) => item.id === sourceId);
      if (!source) return;
      normalizeIdList(source.dependency_template_ids, source.depends_on_template_id).forEach(visitSource);
      orderedSources.push(source);
    };
    selectedIds.forEach(visitSource);
    let nextOrder = Math.max(-1, ...current.map((item) => Number(item.sort_order || 0))) + 1;
    try {
      const objectiveRows = loadProductObjectives();
      const targetObjectives = objectiveRows.filter((item) => item.product_id === productActivityState.productId);
      const objectiveMap = new Map();
      for (const source of orderedSources) {
        if (!source.objective_template_id || objectiveMap.has(source.objective_template_id)) continue;
        const sourceObjective = objectiveRows.find((item) => item.id === source.objective_template_id);
        if (!sourceObjective) { objectiveMap.set(source.objective_template_id, null); continue; }
        let targetObjective = targetObjectives.find((item) => item.name.trim().toLocaleLowerCase("pt-BR") === sourceObjective.name.trim().toLocaleLowerCase("pt-BR"));
        if (!targetObjective) {
          const now = new Date().toISOString();
          const objectiveDraft = {
            id: crypto.randomUUID(), product_id: productActivityState.productId,
            name: sourceObjective.name, completion_criteria: sourceObjective.completion_criteria || "",
            default_owner_id: sourceObjective.default_owner_id || null,
            target_days: sourceObjective.target_days ?? null,
            sort_order: Math.max(-1, ...targetObjectives.map((item) => Number(item.sort_order || 0))) + 1,
            created_at: now, updated_at: now
          };
          targetObjective = isLive() ? await createRow("productObjectives", objectiveDraft) : objectiveDraft;
          objectiveRows.push(targetObjective);
          targetObjectives.push(targetObjective);
        }
        objectiveMap.set(source.objective_template_id, targetObjective.id);
      }
      const activityMap = new Map();
      for (const source of orderedSources) {
        const existing = targetBySignature.get(signatureOf(source));
        activityMap.set(source.id, existing?.id || crypto.randomUUID());
      }
      let createdCount = 0;
      for (const source of orderedSources) {
        if (targetBySignature.has(signatureOf(source))) continue;
        const now = new Date().toISOString();
        const draft = {
          ...source, id: activityMap.get(source.id), product_id: productActivityState.productId,
          dependency_template_ids: normalizeIdList(source.dependency_template_ids, source.depends_on_template_id).map((id) => activityMap.get(id)).filter(Boolean),
          depends_on_template_id: normalizeIdList(source.dependency_template_ids, source.depends_on_template_id).map((id) => activityMap.get(id)).filter(Boolean)[0] || null,
          objective_template_id: objectiveMap.get(source.objective_template_id) || null,
          checklist: normalizeChecklist(source.checklist).map((item) => ({ ...item, checked: false })),
          sort_order: nextOrder++,
          created_at: now, updated_at: now
        };
        const saved = isLive() ? await createRow("productActivities", draft) : draft;
        rows.push(saved);
        targetBySignature.set(signatureOf(saved), saved);
        createdCount += 1;
      }
      if (isLive()) {
        cache.productActivities = rows;
        cache.productObjectives = objectiveRows;
      } else {
        saveProductActivities(rows);
        saveProductObjectives(objectiveRows);
      }
      await syncProductObjectives();
      await syncProductActivities();
      refreshActivityCache();
      closeProductActivityDrawer();
      renderProductActivities();
      toast(`${createdCount} tarefa(s) adicionada(s) com todos os vínculos.`);
    } catch (err) { toast("Erro ao adicionar tarefas · " + err.message, true); }
  });
  document.getElementById("ready-activity-search").focus();
}

function wireProductActivityDragAndDrop() {
  const tbody = document.getElementById("pa-tbody");
  if (!tbody) return;
  let dragged = null;
  tbody.querySelectorAll(".pa-row").forEach((row) => {
    row.addEventListener("dragstart", (event) => {
      if (event.target.closest("button")) { event.preventDefault(); return; }
      dragged = row;
      row.classList.add("dragging");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", row.dataset.id);
    });
    row.addEventListener("dragover", (event) => {
      event.preventDefault();
      if (!dragged || dragged === row) return;
      const rect = row.getBoundingClientRect();
      tbody.insertBefore(dragged, event.clientY < rect.top + rect.height / 2 ? row : row.nextSibling);
    });
    row.addEventListener("drop", async (event) => {
      event.preventDefault();
      await persistProductActivityOrder();
    });
    row.addEventListener("dragend", () => {
      row.classList.remove("dragging");
      dragged = null;
    });
  });
}

async function persistProductActivityOrder() {
  const ids = [...document.querySelectorAll("#pa-tbody .pa-row")].map((row) => row.dataset.id);
  const rows = loadProductActivities();
  const changed = [];
  ids.forEach((id, sortOrder) => {
    const item = rows.find((row) => row.id === id);
    if (!item || Number(item.sort_order || 0) === sortOrder) return;
    item.sort_order = sortOrder;
    item.updated_at = new Date().toISOString();
    changed.push(item);
  });
  if (!changed.length) return;
  try {
    if (isLive()) {
      await Promise.all(changed.map((item) => updateRow("productActivities", item.id, {
        sort_order: item.sort_order,
        updated_at: item.updated_at
      })));
      cache.productActivities = rows;
    } else saveProductActivities(rows);
    await syncProductActivities();
    refreshActivityCache();
    toast("Ordem das tarefas salva.");
  } catch (err) {
    toast("Erro ao salvar a ordem · " + err.message, true);
    renderProductActivities();
  }
}

function closeProductActivityDrawer() {
  document.getElementById("product-activity-drawer-overlay")?.remove();
  productActivityState.editId = null;
  productActivityState.objectiveEditId = null;
  productActivityState.goalEditId = null;
}

function openProductActivityDrawer(editId = null, cloneSourceId = null) {
  closeProductActivityDrawer();
  productActivityState.editId = editId;
  const templates = loadProductActivities().filter((item) => item.product_id === productActivityState.productId);
  const editing = templates.find((item) => item.id === editId) || null;
  const cloneSource = templates.find((item) => item.id === cloneSourceId) || null;
  const current = editing || (cloneSource ? { ...cloneSource, id: null, activity: `${cloneSource.activity} (cópia)` } : {});
  productActivityDraftGroupId = editing?.template_group_id || crypto.randomUUID();
  productActivityRelatedIds = editing
    ? loadProductActivities().filter((item) => item.template_group_id
      ? item.template_group_id === editing.template_group_id
      : item.id === editing.id).map((item) => item.id)
    : [];
  const selectedProductIds = new Set(editing
    ? loadProductActivities().filter((item) => productActivityRelatedIds.includes(item.id)).map((item) => item.product_id)
    : [productActivityState.productId]);
  productActivityChecklistDraft = normalizeChecklist(current.checklist).map((item) => ({ ...item, checked: false }));
  const selectedDependencies = new Set(normalizeIdList(current.dependency_template_ids, current.depends_on_template_id));
  const dependencyOptions = templates.filter((item) => item.id !== editId).map((item) => ({ value: item.id, label: activityDisplayName(item) }));
  const selectedAssignees = new Set(normalizeIdList(current.default_assignee_ids, current.default_owner_id));
  const assigneeOptions = (cache.users || []).map((user) => ({ value: user.id, label: user.full_name || user.name || user.email || user.id }));
  const selectedJobTitles = new Set(normalizeTextList(current.default_assignee_job_titles));
  const objectiveOptions = ['<option value="">Sem objetivo</option>'].concat(
    loadProductObjectives().filter((item) => item.product_id === productActivityState.productId).map((item) =>
      `<option value="${esc(item.id)}"${item.id === current.objective_template_id ? " selected" : ""}>${esc(item.name)}</option>`)
  ).join("");
  const recurrenceOptions = RECURRENCE_OPTIONS.map(([value, label]) =>
    `<option value="${value}"${value === (current.recurrence || "once") ? " selected" : ""}>${label}</option>`).join("");
  const priorityOptions = PRIORITY_OPTIONS.map(([value, label]) =>
    `<option value="${value}"${value === (current.priority || "normal") ? " selected" : ""}>${label}</option>`).join("");
  const productOptions = (cache.products || []).map((product) => ({ value: product.id, label: product.name }));
  const overlay = document.createElement("div");
  overlay.id = "product-activity-drawer-overlay";
  overlay.className = "activity-form-overlay";
  overlay.innerHTML = `<aside class="activity-form-drawer">
    <h3>${current.id ? "Editar tarefa" : cloneSource ? "Clonar tarefa" : "Nova tarefa"}<button class="modal-close-x" id="pa-close" title="Fechar">✕</button></h3>
    <div class="form product-activity-form">
      <div class="field"><label>Produtos *</label>${multiPickerHtml("pa-products", productOptions, selectedProductIds, "Selecionar produtos")}</div>
      <div class="field"><label>Grupo</label><input id="pa-group" value="${esc(current.group || "")}"></div>
      <div class="field"><label>Setor</label><input id="pa-sector" value="${esc(current.sector || "")}"></div>
      <div class="field"><label>Canal</label><input id="pa-channel" value="${esc(current.channel || "")}"></div>
      <div class="field"><label>Tipo</label><input id="pa-type" value="${esc(current.type || "")}"></div>
      <div class="field"><label>Recorrência</label><select id="pa-recurrence">${recurrenceOptions}</select></div>
      <div class="field"><label>Prioridade</label><select id="pa-priority">${priorityOptions}</select></div>
      <div class="field"><label>Tarefa *</label><input id="pa-activity" value="${esc(current.activity || "")}" placeholder="Nome da tarefa"></div>
      <div class="field"><label>Informação</label><textarea id="pa-information" rows="5" placeholder="Instruções, contexto ou informações importantes">${esc(current.information || "")}</textarea></div>
      <div class="field"><label>Checklist</label><div class="checklist-editor" id="pa-checklist"></div><button class="btn checklist-add" id="pa-checklist-add" type="button">+ Item</button></div>
      <div class="field"><label>Objetivo</label><select id="pa-objective">${objectiveOptions}</select></div>
      <div class="field"><label>Responsáveis padrão</label>${multiPickerHtml("pa-assignees", assigneeOptions, selectedAssignees, "Selecionar responsáveis")}</div>
      <div class="field"><label>Cargos responsáveis</label>${multiPickerHtml("pa-assignee-job-titles", assigneeJobTitleOptions(), selectedJobTitles, "Selecionar cargos")}</div>
      <div class="field"><label>Depende de</label>${multiPickerHtml("pa-dependencies", dependencyOptions, selectedDependencies, "Selecionar dependências")}</div>
    </div>
    <div class="modal-foot"><button class="btn" id="pa-cancel">Cancelar</button><button class="btn primary" id="pa-save">${current.id ? "Salvar" : cloneSource ? "Criar cópia" : "Criar"}</button></div>
  </aside>`;
  document.querySelector("#ov .modal.full")?.appendChild(overlay);
  overlay.addEventListener("click", (event) => { if (event.target === overlay) closeProductActivityDrawer(); });
  document.getElementById("pa-close").addEventListener("click", closeProductActivityDrawer);
  document.getElementById("pa-cancel").addEventListener("click", closeProductActivityDrawer);
  document.getElementById("pa-save").addEventListener("click", saveProductActivity);
  document.getElementById("pa-checklist-add").addEventListener("click", () => {
    productActivityChecklistDraft.push({ id: crypto.randomUUID(), text: "", checked: false });
    renderProductActivityChecklistEditor();
    document.querySelector("#pa-checklist .checklist-edit-row:last-child input")?.focus();
  });
  wireMultiPicker("pa-products");
  wireMultiPicker("pa-assignees");
  wireMultiPicker("pa-assignee-job-titles");
  wireMultiPicker("pa-dependencies");
  renderProductActivityChecklistEditor();
  document.getElementById("pa-activity")?.focus();
}

function createsTemplateDependencyCycle(rows, currentId, dependencyIds) {
  const reachesCurrent = (candidateId, path = new Set()) => {
    if (!candidateId) return false;
    if (candidateId === currentId) return true;
    if (path.has(candidateId)) return false;
    const nextPath = new Set(path).add(candidateId);
    const candidate = rows.find((item) => item.id === candidateId);
    return normalizeIdList(candidate?.dependency_template_ids, candidate?.depends_on_template_id)
      .some((nextId) => reachesCurrent(nextId, nextPath));
  };
  return dependencyIds.some((dependencyId) => reachesCurrent(dependencyId));
}

async function saveProductActivity() {
  const activity = document.getElementById("pa-activity").value.trim();
  if (!activity) { toast("Informe a tarefa.", true); return; }
  const rows = loadProductActivities();
  const current = rows.find((item) => item.id === productActivityState.editId);
  const recordId = current?.id || crypto.randomUUID();
  const dependencyIds = multiPickerValues("pa-dependencies");
  const assigneeIds = multiPickerValues("pa-assignees");
  const assigneeJobTitles = multiPickerValues("pa-assignee-job-titles");
  const selectedProductIds = multiPickerValues("pa-products");
  if (!selectedProductIds.length) { toast("Selecione pelo menos um produto.", true); return; }
  if (createsTemplateDependencyCycle(rows, recordId, dependencyIds)) {
    toast("Essa dependência criaria um ciclo entre as tarefas.", true);
    return;
  }
  const baseBody = {
    group: document.getElementById("pa-group").value.trim(),
    sector: document.getElementById("pa-sector").value.trim(),
    channel: document.getElementById("pa-channel").value.trim(),
    type: document.getElementById("pa-type").value.trim(),
    recurrence: document.getElementById("pa-recurrence").value || "once",
    priority: document.getElementById("pa-priority").value || "normal",
    activity,
    information: document.getElementById("pa-information").value.trim(),
    checklist: productActivityChecklistDraft
      .map((item) => ({ id: item.id || crypto.randomUUID(), text: item.text.trim(), checked: false }))
      .filter((item) => item.text),
    default_owner_id: assigneeIds[0] || null,
    default_assignee_ids: assigneeIds,
    default_assignee_job_titles: assigneeJobTitles,
    template_group_id: productActivityDraftGroupId || crypto.randomUUID(),
    updated_at: new Date().toISOString()
  };
  try {
    const related = productActivityRelatedIds.map((id) => rows.find((item) => item.id === id)).filter(Boolean);
    const taskRows = loadProjectTasks();
    const selectedObjective = loadProductObjectives().find((item) => item.id === (document.getElementById("pa-objective").value || null));
    const selectedDependencies = dependencyIds.map((id) => rows.find((item) => item.id === id)).filter(Boolean);
    for (const productId of selectedProductIds) {
      const productRows = rows.filter((item) => item.product_id === productId);
      const existing = related.find((item) => item.product_id === productId) || (current?.product_id === productId ? current : null);
      const targetObjective = productId === productActivityState.productId
        ? selectedObjective
        : loadProductObjectives().find((item) => item.product_id === productId && selectedObjective && item.name.trim().toLocaleLowerCase("pt-BR") === selectedObjective.name.trim().toLocaleLowerCase("pt-BR"));
      const targetDependencies = selectedDependencies.map((selectedDependency) => productId === productActivityState.productId
        ? selectedDependency
        : productRows.find((item) => productActivityIdentity(item) === productActivityIdentity(selectedDependency))).filter(Boolean);
      const body = {
        ...baseBody,
        product_id: productId,
        depends_on_template_id: targetDependencies[0]?.id || null,
        dependency_template_ids: targetDependencies.map((item) => item.id),
        objective_template_id: targetObjective?.id || null,
        sort_order: existing?.sort_order ?? (Math.max(-1, ...productRows.map((item) => Number(item.sort_order || 0))) + 1)
      };
      if (existing) {
        const saved = isLive() ? await updateRow("productActivities", existing.id, body) : { ...existing, ...body };
        Object.assign(existing, saved);
      } else {
        const draft = { id: productId === productActivityState.productId ? recordId : crypto.randomUUID(), ...body, created_at: new Date().toISOString() };
        rows.push(isLive() ? await createRow("productActivities", draft) : draft);
      }
    }
    for (const removed of related.filter((item) => !selectedProductIds.includes(item.product_id))) {
      if (isLive()) await deleteRow("productActivities", removed.id);
      const index = rows.findIndex((item) => item.id === removed.id);
      if (index >= 0) rows.splice(index, 1);
      const linkedTasks = taskRows.filter((task) => task.source_template_id === removed.id);
      for (const task of linkedTasks) {
        task.source_template_id = null;
        if (isLive()) await updateRow("activities", task.id, { source_template_id: null });
      }
    }
    if (!isLive() && related.some((item) => !selectedProductIds.includes(item.product_id))) saveProjectTasks(taskRows);
    if (isLive()) cache.productActivities = rows;
    else saveProductActivities(rows);
    await syncProductActivities();
    refreshActivityCache();
    closeProductActivityDrawer();
    if (document.getElementById("registrations-root")) renderRegistrationsSection();
    else renderProductActivities();
    toast(`Tarefa salva em ${selectedProductIds.length} produto(s) e sincronizada com as entregas.`);
  } catch (err) { toast("Erro ao salvar tarefa · " + err.message, true); }
}

const TASK_STATUS = [
  { id: "todo", label: "A fazer" },
  { id: "doing", label: "Em andamento" },
  { id: "done", label: "Concluído" }
];
let projectBoardState = { projectId: null, view: "table", section: "activities", search: "", page: 1, pageSize: 50, calendarCursor: null, sortKey: null, sortDir: 1, filters: {} };

function userOptions(selected = "") {
  return ['<option value="">Sem responsável</option>']
    .concat((cache?.users || []).map((u) => {
      const id = u.id;
      const label = u.full_name || u.name || u.email || id;
      return `<option value="${esc(id)}"${id === selected ? " selected" : ""}>${esc(label)}</option>`;
    })).join("");
}

function assigneeNames(ids, fallbackId = null) {
  const names = normalizeIdList(ids, fallbackId).map((id) => {
    const user = cache?.userById?.[id];
    return user?.full_name || user?.name || user?.email || id;
  });
  return names.join(", ") || "—";
}

function assigneeJobTitleOptions() {
  return [...new Map((cache?.users || [])
    .filter((user) => user.status === "active" && String(user.job_title || "").trim())
    .map((user) => {
      const title = String(user.job_title).trim();
      return [title.toLocaleLowerCase("pt-BR"), { value: title, label: title }];
    })).values()].sort((a, b) => a.label.localeCompare(b.label, "pt-BR", { sensitivity: "base" }));
}

function responsibilityNames(ids, fallbackId = null, jobTitles = []) {
  const direct = normalizeIdList(ids, fallbackId).map((id) => {
    const user = cache?.userById?.[id];
    return user?.full_name || user?.name || user?.email || id;
  });
  const roles = normalizeTextList(jobTitles).map((title) => {
    const eligible = (cache?.users || []).filter((user) =>
      user.status === "active" && String(user.job_title || "").trim().toLocaleLowerCase("pt-BR") === title.toLocaleLowerCase("pt-BR")
    ).map((user) => user.full_name || user.name || user.email).filter(Boolean);
    return eligible.length ? `Cargo: ${title} (${eligible.join(", ")})` : `Cargo: ${title}`;
  });
  return [...new Set([...direct, ...roles])].join(", ") || "—";
}

function dependencyNames(ids, fallbackId, rows = loadProjectTasks()) {
  const names = normalizeIdList(ids, fallbackId).map((id) => activityDisplayName(rows.find((item) => item.id === id))).filter((name) => name !== "—");
  return names.join(", ") || "—";
}

function multiPickerHtml(id, options, selectedIds, placeholder) {
  const selected = new Set(selectedIds);
  const rows = options.map((option) => `<button type="button" class="multi-picker-option${selected.has(option.value) ? " active" : ""}" data-value="${esc(option.value)}" data-label="${esc(option.label)}"><span>${esc(option.label)}</span><b>✓</b></button>`).join("");
  return `<div class="multi-picker" id="${esc(id)}" data-placeholder="${esc(placeholder)}">
    <div class="multi-picker-control" role="button" tabindex="0" aria-expanded="false"><div class="multi-picker-selection"></div><span class="multi-picker-chevron">▾</span></div>
    <div class="multi-picker-menu" hidden><input class="multi-picker-search" type="search" placeholder="Buscar..."><div class="multi-picker-options">${rows || '<div class="multi-picker-empty">Nenhuma opção disponível.</div>'}</div></div>
  </div>`;
}

function multiPickerValues(id) {
  return [...document.querySelectorAll(`#${id} .multi-picker-option.active`)].map((option) => option.dataset.value);
}

function wireMultiPicker(id) {
  const root = document.getElementById(id);
  if (!root) return;
  const control = root.querySelector(".multi-picker-control");
  const menu = root.querySelector(".multi-picker-menu");
  const search = root.querySelector(".multi-picker-search");
  const drawSelection = () => {
    const active = [...root.querySelectorAll(".multi-picker-option.active")];
    root.querySelector(".multi-picker-selection").innerHTML = active.length
      ? active.map((option) => `<button type="button" class="multi-picker-chip" data-value="${esc(option.dataset.value)}" title="Remover"><span>${esc(option.dataset.label)}</span><b>×</b></button>`).join("")
      : `<span class="multi-picker-placeholder">${esc(root.dataset.placeholder || "Selecione")}</span>`;
    root.querySelectorAll(".multi-picker-chip").forEach((chip) => chip.addEventListener("click", (event) => {
      event.stopPropagation();
      root.querySelector(`.multi-picker-option[data-value="${CSS.escape(chip.dataset.value)}"]`)?.classList.remove("active");
      drawSelection();
    }));
  };
  const toggleMenu = (open) => {
    document.querySelectorAll(".multi-picker-menu:not([hidden])").forEach((other) => { if (other !== menu) other.hidden = true; });
    menu.hidden = open == null ? !menu.hidden : !open;
    control.setAttribute("aria-expanded", String(!menu.hidden));
    if (!menu.hidden) { search.value = ""; root.querySelectorAll(".multi-picker-option").forEach((option) => { option.hidden = false; }); search.focus(); }
  };
  control.addEventListener("click", () => toggleMenu());
  control.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); toggleMenu(); } });
  root.addEventListener("keydown", (event) => { if (event.key === "Escape") { event.stopPropagation(); toggleMenu(false); control.focus(); } });
  root.querySelectorAll(".multi-picker-option").forEach((option) => option.addEventListener("click", () => { option.classList.toggle("active"); drawSelection(); }));
  search.addEventListener("input", () => {
    const query = search.value.trim().toLocaleLowerCase("pt-BR");
    root.querySelectorAll(".multi-picker-option").forEach((option) => { option.hidden = Boolean(query && !option.dataset.label.toLocaleLowerCase("pt-BR").includes(query)); });
  });
  drawSelection();
}

document.addEventListener("click", (event) => {
  if (event.target.closest(".multi-picker")) return;
  document.querySelectorAll(".multi-picker-menu:not([hidden])").forEach((menu) => {
    menu.hidden = true;
    menu.closest(".multi-picker")?.querySelector(".multi-picker-control")?.setAttribute("aria-expanded", "false");
  });
});

function taskStatusOptions(selected = "todo", blocked = false) {
  return TASK_STATUS.map((s) => `<option value="${s.id}"${s.id === selected ? " selected" : ""}${blocked && s.id !== "todo" ? " disabled" : ""}>${s.label}</option>`).join("");
}

function taskDependencies(task, tasks = loadProjectTasks()) {
  const ids = normalizeIdList(task.dependency_ids, task.depends_on_activity_id);
  return ids.map((id) => tasks.find((item) => item.id === id)).filter(Boolean);
}

function taskDependency(task, tasks = loadProjectTasks()) {
  return taskDependencies(task, tasks)[0] || null;
}

function taskIsBlocked(task, tasks = loadProjectTasks()) {
  return taskDependencies(task, tasks).some((dependency) => dependency.status !== "done");
}

function taskCardHtml(task) {
  const owners = assigneeNames(task.assignee_ids, task.owner_id);
  const objective = cache.deliveryObjectiveById?.[task.objective_id];
  const dependencies = taskDependencies(task);
  const blocked = taskIsBlocked(task);
  const checklist = checklistProgress(task.checklist);
  return `<div class="task-card ${task.status === "done" ? "done" : ""}${blocked ? " blocked" : ""}" data-id="${esc(task.id)}">
    <input class="task-title-input" value="${esc(activityDisplayName(task))}" placeholder="Título da tarefa"${task.source_template_id ? ' readonly title="Tarefa definida no produto"' : ""}>
    <div>${badge(task.source_template_id ? "qualification" : "proposal", task.source_template_id ? "Produto" : "Dia a dia")} ${priorityBadge(task.priority)}</div>
    ${dependencies.length ? `<div class="task-dependency${blocked ? " blocked" : ""}">${blocked ? "Bloqueada por" : "Liberada após"}: ${esc(dependencyNames(task.dependency_ids, task.depends_on_activity_id))}</div>` : ""}
    ${task.information ? `<div class="task-information"><strong>Informação</strong><span>${esc(task.information)}</span></div>` : ""}
    ${objective ? `<div class="task-dependency">Objetivo: ${esc(objective.name)}</div>` : ""}
    ${(task.group || task.sector || task.channel || task.type) ? `<div class="task-taxonomy">
      ${task.group ? `<span>${esc(task.group)}</span>` : ""}${task.sector ? `<span>${esc(task.sector)}</span>` : ""}
      ${task.channel ? `<span>${esc(task.channel)}</span>` : ""}${task.type ? `<span>${esc(task.type)}</span>` : ""}
    </div>` : ""}
    <div class="task-row">
      <span class="muted">${esc(owners)}</span>
      <input class="task-due" type="date" value="${esc(task.due_date || "")}" title="Prazo">
    </div>
    <textarea class="task-notes" placeholder="Notas, checklist ou contexto">${esc(task.notes || "")}</textarea>
    <button class="btn checklist-open${checklist.total > 0 && checklist.done === checklist.total ? " complete" : ""}" data-id="${esc(task.id)}" type="button">Checklist ${checklist.done}/${checklist.total}</button>
    <div class="task-actions">
      <select class="task-status"${blocked ? ' title="Conclua a tarefa anterior para liberar"' : ""}>${taskStatusOptions(task.status || "todo", blocked)}</select>
      <button class="rowbtn task-edit" title="Editar tarefa">✎</button>
      ${task.source_template_id ? '<span class="muted">Produto</span>' : '<button class="rowbtn del-task" title="Excluir tarefa">✕</button>'}
    </div>
  </div>`;
}

function openProjectBoard(projectId) {
  const project = (cache.projects || []).find((p) => p.id === projectId);
  if (!project) return;
  projectBoardState = { projectId, view: "table", section: "activities", search: "", page: 1, pageSize: 50, calendarCursor: null, sortKey: null, sortDir: 1, filters: {} };
  const headerCenter = `<div class="modal-header-tabs" role="tablist" aria-label="Conteúdo da entrega">
    <button class="modal-header-tab active" data-project-section="activities" role="tab">Tarefas</button>
    <button class="modal-header-tab" data-project-section="objectives" role="tab">Objetivos</button>
    <button class="modal-header-tab" data-project-section="goals" role="tab">Metas</button>
  </div>`;
  shell(`Entrega · ${project.name || project.id}`, `<div id="project-board-root" class="full-body"></div>`, {
    cls: "full registrations-modal",
    headerCenter,
    titleHtml: `<span class="registration-brand">ENTERPRISER <b>• CRM</b><em>Entrega · ${esc(project.name || project.id)}</em></span>`
  });
  document.querySelectorAll("[data-project-section]").forEach((button) => button.addEventListener("click", () => {
    projectBoardState.section = button.dataset.projectSection;
    projectBoardState.view = "table";
    projectBoardState.search = "";
    projectBoardState.page = 1;
    projectBoardState.sortKey = null;
    projectBoardState.sortDir = 1;
    projectBoardState.filters = {};
    document.querySelectorAll("[data-project-section]").forEach((tab) => tab.classList.toggle("active", tab === button));
    renderProjectBoard(projectId);
  }));
  renderProjectBoard(projectId);
}

function renderTaskMatrix(tasks) {
  return `<div class="task-columns">${TASK_STATUS.map((status) => {
    const items = tasks.filter((task) => (task.status || "todo") === status.id);
    return `<section class="task-col" data-status="${status.id}">
      <h4>${status.label}<span>${items.length}</span></h4>
      <div class="task-list">${items.map(taskCardHtml).join("") || '<div class="empty" style="padding:22px 8px">Sem tarefas.</div>'}</div>
    </section>`;
  }).join("")}</div>`;
}

function renderTaskTable(tasks) {
  const totalPages = Math.max(1, Math.ceil(tasks.length / projectBoardState.pageSize));
  projectBoardState.page = Math.min(Math.max(1, projectBoardState.page || 1), totalPages);
  const start = (projectBoardState.page - 1) * projectBoardState.pageSize;
  const pageRows = tasks.slice(start, start + projectBoardState.pageSize);
  const rows = pageRows.map((task) => {
    const status = TASK_STATUS.find((s) => s.id === (task.status || "todo"))?.label || "A fazer";
    const checklist = checklistProgress(task.checklist);
    return `<tr>
      <td>${esc(activityDisplayName(task))}</td>
      <td>${badge(task.source_template_id ? "qualification" : "proposal", task.source_template_id ? "Produto" : "Dia a dia")}</td>
      <td>${priorityBadge(task.priority)}</td>
      <td>${esc(dependencyNames(task.dependency_ids, task.depends_on_activity_id, tasks))}</td>
      <td>${esc(task.information || "—")}</td>
      <td>${esc(task.group || "—")}</td>
      <td>${esc(task.sector || "—")}</td>
      <td>${esc(task.channel || "—")}</td>
      <td>${esc(task.type || "—")}</td>
      <td><button class="btn checklist-open${checklist.total > 0 && checklist.done === checklist.total ? " complete" : ""}" data-id="${esc(task.id)}">${checklist.done}/${checklist.total}</button></td>
      <td>${esc(cache.deliveryObjectiveById?.[task.objective_id]?.name || "—")}</td>
      <td>${esc(responsibilityNames(task.assignee_ids, task.owner_id, task.assignee_job_titles))}</td>
      <td>${esc(task.due_date ? dt(task.due_date) : "—")}</td>
      <td>${esc(status)}</td>
      <td class="muted">${esc(task.notes || "—")}</td>
      <td><button class="rowbtn task-edit" data-id="${esc(task.id)}" title="Editar tarefa">✎</button></td>
    </tr>`;
  }).join("");
  return `<div class="task-table-shell"><div class="task-table-wrap">
    <table><thead><tr>
      <th>Tarefa</th><th>Origem</th><th>Prioridade</th><th>Depende de</th><th>Informação</th><th>Grupo</th><th>Setor</th><th>Canal</th><th>Tipo</th><th>Checklist</th><th>Objetivo</th><th>Responsáveis</th><th>Prazo</th><th>Status</th><th>Notas</th><th>Ações</th>
    </tr></thead><tbody>${rows || '<tr><td colspan="16" class="empty">Sem tarefas.</td></tr>'}</tbody></table>
  </div><div class="table-pagination"><span>${tasks.length ? `${start + 1}-${Math.min(start + projectBoardState.pageSize, tasks.length)} de ${tasks.length}` : "0 registros"}</span>
    <div><button class="btn" id="project-page-prev"${projectBoardState.page <= 1 ? " disabled" : ""}>‹</button><span>Página ${projectBoardState.page} de ${totalPages}</span><button class="btn" id="project-page-next"${projectBoardState.page >= totalPages ? " disabled" : ""}>›</button></div>
  </div></div>`;
}

function renderProjectTaskCalendar(tasks) {
  const cursor = projectBoardState.calendarCursor ? dateOnly(`${projectBoardState.calendarCursor}-01`) : new Date();
  const monthStart = new Date(cursor.getFullYear(), cursor.getMonth(), 1, 12);
  projectBoardState.calendarCursor = `${monthStart.getFullYear()}-${String(monthStart.getMonth() + 1).padStart(2, "0")}`;
  const gridStart = new Date(monthStart);
  gridStart.setDate(gridStart.getDate() - gridStart.getDay());
  const byDay = new Map();
  tasks.filter((task) => dateOnly(task.due_date)).forEach((task) => {
    const key = String(task.due_date).slice(0, 10);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(task);
  });
  const weekdays = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"].map((day) => `<div class="calendar-weekday">${day}</div>`).join("");
  const today = isoDay(new Date());
  const days = Array.from({ length: 42 }, (_, index) => {
    const date = new Date(gridStart);
    date.setDate(gridStart.getDate() + index);
    const key = isoDay(date);
    return `<div class="calendar-day${date.getMonth() !== monthStart.getMonth() ? " outside" : ""}${key === today ? " today" : ""}">
      <span class="calendar-date">${date.getDate()}</span>${(byDay.get(key) || []).map((task) => `<button class="calendar-item project-calendar-item" data-id="${esc(task.id)}">${esc(activityDisplayName(task))}</button>`).join("")}
    </div>`;
  }).join("");
  return `<div class="calendar-view"><div class="calendar-toolbar"><strong>${monthStart.toLocaleDateString("pt-BR", { month: "long", year: "numeric" })}</strong>
    <div class="calendar-nav"><button class="btn" id="project-calendar-prev">‹</button><button class="btn" id="project-calendar-today">Hoje</button><button class="btn" id="project-calendar-next">›</button></div>
  </div><div class="calendar-grid">${weekdays}${days}</div></div>`;
}

function renderProjectTaskGantt(tasks) {
  const items = tasks.filter((task) => dateOnly(task.due_date));
  if (!items.length) return '<div class="empty">Nenhuma tarefa com prazo para exibir no Gantt.</div>';
  const dates = items.map((task) => dateOnly(task.due_date).getTime());
  const min = Math.min(...dates);
  const max = Math.max(...dates, min + 86400000);
  const span = Math.max(86400000, max - min);
  const rows = items.sort((a, b) => dateOnly(a.due_date) - dateOnly(b.due_date)).map((task) => {
    const left = (dateOnly(task.due_date).getTime() - min) / span * 100;
    return `<div class="gantt-row"><div class="gantt-label"><strong>${esc(activityDisplayName(task))}</strong><small>${esc(TASK_STATUS.find((status) => status.id === task.status)?.label || "A fazer")}</small></div>
      <div class="gantt-track"><button class="gantt-bar project-gantt-item" data-id="${esc(task.id)}" style="left:${Math.min(left, 98)}%;width:2%" title="${esc(dt(task.due_date))}">${esc(activityDisplayName(task))}</button></div></div>`;
  }).join("");
  return `<div class="gantt-view"><div class="gantt-board"><div class="gantt-head"><div>Tarefa</div><div>${esc(dt(isoDay(new Date(min))))} a ${esc(dt(isoDay(new Date(max))))}</div></div>${rows}</div></div>`;
}

function renderDeliveryObjectives(projectId, tasks, sourceRows = null) {
  const objectives = sourceRows || loadDeliveryObjectives().filter((item) => item.project_id === projectId)
    .sort((a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0));
  const rows = objectives.map((objective) => {
    const linked = tasks.filter((task) => task.objective_id === objective.id);
    const done = linked.filter((task) => task.status === "done").length;
    const progress = linked.length ? Math.round((done / linked.length) * 100) : 0;
    const dependencyState = deliveryObjectiveDependencyState(objective);
    const dependencyLabel = deliveryObjectiveDependencyLabel(objective);
    return `<tr data-objective-id="${esc(objective.id)}">
      <td><strong>${esc(objective.name)}</strong></td>
      <td>${esc(objective.completion_criteria || "—")}</td>
      <td>${done}/${linked.length} · ${progress}%</td>
      <td>${esc(dependencyLabel)}${dependencyState.blocked ? '<div class="muted">Aguardando dependências</div>' : ""}</td>
      <td><select class="objective-control delivery-objective-owner">${userOptions(objective.owner_id || "")}</select></td>
      <td><input class="objective-control delivery-objective-due" type="date" value="${esc(objective.due_date || "")}"></td>
      <td><select class="objective-control delivery-objective-status">${taskStatusOptions(objective.status || "todo")}</select></td>
    </tr>`;
  }).join("");
  return `<div class="task-table-wrap"><table><thead><tr>
    <th>Objetivo</th><th>Critério de conclusão</th><th>Progresso das tarefas</th><th>Depende de</th><th>Responsável</th><th>Prazo</th><th>Status</th>
  </tr></thead><tbody>${rows || '<tr><td colspan="7" class="empty">Esta entrega ainda não possui objetivos.</td></tr>'}</tbody></table></div>`;
}

function deliveryObjectiveDependencyState(objective) {
  const objectives = loadDeliveryObjectives();
  const tasks = loadProjectTasks();
  const dependencyObjectives = normalizeIdList(objective.dependency_objective_ids)
    .map((id) => objectives.find((item) => item.id === id)).filter(Boolean);
  const dependencyActivities = normalizeIdList(objective.dependency_activity_ids)
    .map((id) => tasks.find((item) => item.id === id)).filter(Boolean);
  const pendingObjectives = dependencyObjectives.filter((item) => item.status !== "done");
  const pendingActivities = dependencyActivities.filter((item) => item.status !== "done");
  return { dependencyObjectives, dependencyActivities, pendingObjectives, pendingActivities, blocked: Boolean(pendingObjectives.length || pendingActivities.length) };
}

function deliveryObjectiveDependencyLabel(objective) {
  const state = deliveryObjectiveDependencyState(objective);
  return [
    ...state.dependencyObjectives.map((item) => item.name),
    ...state.dependencyActivities.map(activityDisplayName)
  ].join(", ") || "—";
}

function deliveryGoalReached(goal, value = Number(goal.current_value || 0)) {
  const target = Number(goal.target_value || 0);
  if (goal.comparison === "at_most") return value <= target;
  if (goal.comparison === "exactly") return value === target;
  return value >= target;
}

function deliveryGoalDependencyState(goal) {
  const goals = loadDeliveryGoals();
  const tasks = loadProjectTasks();
  const dependencyGoals = normalizeIdList(goal.dependency_goal_ids)
    .map((id) => goals.find((item) => item.id === id)).filter(Boolean);
  const dependencyActivities = normalizeIdList(goal.dependency_activity_ids)
    .map((id) => tasks.find((item) => item.id === id)).filter(Boolean);
  const pendingGoals = dependencyGoals.filter((item) => item.status !== "done");
  const pendingActivities = dependencyActivities.filter((item) => item.status !== "done");
  return { dependencyGoals, dependencyActivities, pendingGoals, pendingActivities, blocked: Boolean(pendingGoals.length || pendingActivities.length) };
}

function deliveryGoalDependencyLabel(goal) {
  const state = deliveryGoalDependencyState(goal);
  const names = [
    ...state.dependencyGoals.map((item) => item.name),
    ...state.dependencyActivities.map(activityDisplayName)
  ];
  return names.join(", ") || "—";
}

function renderDeliveryGoals(projectId, sourceRows = null) {
  const goals = sourceRows || loadDeliveryGoals().filter((item) => item.project_id === projectId)
    .sort((a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0));
  const rows = goals.map((goal) => {
    const current = Number(goal.current_value || 0);
    const target = Number(goal.target_value || 0);
    const progress = target ? Math.max(0, Math.min(100, Math.round(current / target * 100))) : 0;
    const targetLabel = `${GOAL_COMPARISON_LABEL[goal.comparison] || "No mínimo"} ${target.toLocaleString("pt-BR")} ${goal.unit || ""}`.trim();
    const dependencyState = deliveryGoalDependencyState(goal);
    const dependencyLabel = deliveryGoalDependencyLabel(goal);
    return `<tr data-goal-id="${esc(goal.id)}">
      <td><strong>${esc(goal.name)}</strong></td><td>${esc(goal.metric)}</td>
      <td><input class="objective-control delivery-goal-current" type="number" step="any" value="${esc(current)}"></td>
      <td>${esc(targetLabel)}</td><td>${progress}%</td><td>${esc(dependencyLabel)}${dependencyState.blocked ? '<div class="muted">Aguardando dependências</div>' : ""}</td>
      <td><select class="objective-control delivery-goal-owner">${userOptions(goal.owner_id || "")}</select></td>
      <td><input class="objective-control delivery-goal-due" type="date" value="${esc(goal.due_date || "")}"></td>
      <td><select class="objective-control delivery-goal-status">${taskStatusOptions(goal.status || "todo")}</select></td>
    </tr>`;
  }).join("");
  return `<div class="task-table-shell"><div class="task-table-wrap"><table><thead><tr>
    <th>Meta</th><th>Indicador</th><th>Valor atual</th><th>Valor-alvo</th><th>Progresso</th><th>Depende de</th><th>Responsável</th><th>Prazo</th><th>Status</th>
  </tr></thead><tbody>${rows || '<tr><td colspan="9" class="empty">Esta entrega ainda não possui metas.</td></tr>'}</tbody></table></div>
  <div class="table-pagination"><span>${goals.length} meta(s)</span><div><span>Acompanhamento da entrega</span></div></div></div>`;
}

function renderTaskDashboard(tasks) {
  const total = tasks.length;
  const done = tasks.filter((t) => t.status === "done").length;
  const doing = tasks.filter((t) => t.status === "doing").length;
  const overdue = tasks.filter((t) => t.due_date && t.status !== "done" && t.due_date < new Date().toISOString().slice(0, 10)).length;
  const pct = total ? Math.round((done / total) * 100) : 0;
  return `<div class="project-dashboard">
    <div class="metric"><div class="k">Tarefas</div><div class="v">${total}</div></div>
    <div class="metric"><div class="k">Em andamento</div><div class="v">${doing}</div></div>
    <div class="metric"><div class="k">Concluídas</div><div class="v">${done}</div></div>
    <div class="metric"><div class="k">Atrasadas</div><div class="v">${overdue}</div></div>
    <div class="metric"><div class="k">Progresso</div><div class="v">${pct}%</div></div>
  </div>`;
}

function renderDeliveryStatusMatrix(rows, kind, tasks = []) {
  return `<div class="task-columns">${TASK_STATUS.map((status) => {
    const items = rows.filter((item) => (item.status || "todo") === status.id);
    const cards = items.map((item) => {
      if (kind === "objectives") {
        const linked = tasks.filter((task) => task.objective_id === item.id);
        const done = linked.filter((task) => task.status === "done").length;
        return `<article class="task-card"><strong>${esc(item.name || "Objetivo")}</strong><span class="muted">${esc(item.completion_criteria || "Sem critério")}</span><span>${done}/${linked.length} tarefa(s)</span></article>`;
      }
      return `<article class="task-card"><strong>${esc(item.name || "Meta")}</strong><span class="muted">${esc(item.metric || "Sem indicador")}</span><span>${Number(item.current_value || 0).toLocaleString("pt-BR")} / ${Number(item.target_value || 0).toLocaleString("pt-BR")} ${esc(item.unit || "")}</span></article>`;
    }).join("");
    return `<section class="task-col"><h4>${status.label}<span>${items.length}</span></h4><div class="task-list">${cards || '<div class="empty" style="padding:22px 8px">Sem itens.</div>'}</div></section>`;
  }).join("")}</div>`;
}

function renderDeliverySectionDashboard(rows, kind, tasks = []) {
  const done = rows.filter((item) => item.status === "done").length;
  const doing = rows.filter((item) => item.status === "doing").length;
  const blocked = rows.filter((item) => kind === "objectives" ? deliveryObjectiveDependencyState(item).blocked : deliveryGoalDependencyState(item).blocked).length;
  const overdue = rows.filter((item) => item.due_date && item.status !== "done" && item.due_date < new Date().toISOString().slice(0, 10)).length;
  const linked = kind === "objectives" ? tasks.filter((task) => rows.some((item) => item.id === task.objective_id)).length : 0;
  return `<div class="project-dashboard">
    <div class="metric"><div class="k">${kind === "objectives" ? "Objetivos" : "Metas"}</div><div class="v">${rows.length}</div></div>
    <div class="metric"><div class="k">Em andamento</div><div class="v">${doing}</div></div>
    <div class="metric"><div class="k">Concluídos</div><div class="v">${done}</div></div>
    <div class="metric"><div class="k">Bloqueados</div><div class="v">${blocked}</div></div>
    <div class="metric"><div class="k">Atrasados</div><div class="v">${overdue}</div></div>
    ${kind === "objectives" ? `<div class="metric"><div class="k">Tarefas vinculadas</div><div class="v">${linked}</div></div>` : ""}
  </div>`;
}

function projectSectionRows(projectId, section = projectBoardState.section) {
  if (section === "objectives") return loadDeliveryObjectives().filter((item) => item.project_id === projectId);
  if (section === "goals") return loadDeliveryGoals().filter((item) => item.project_id === projectId);
  return projectTasks(projectId);
}

const PROJECT_TABLE_LABELS = {
  activities: ["Tarefa", "Origem", "Prioridade", "Depende de", "Informação", "Grupo", "Setor", "Canal", "Tipo", "Checklist", "Objetivo", "Responsáveis", "Prazo", "Status", "Notas"],
  objectives: ["Objetivo", "Critério de conclusão", "Progresso das tarefas", "Depende de", "Responsável", "Prazo", "Status"],
  goals: ["Meta", "Indicador", "Valor atual", "Valor-alvo", "Progresso", "Depende de", "Responsável", "Prazo", "Status"]
};

function projectSectionValues(item, tasks = []) {
  if (projectBoardState.section === "activities") {
    const checklist = checklistProgress(item.checklist);
    return [
      activityDisplayName(item),
      item.source_template_id ? "Produto" : "Dia a dia",
      PRIORITY_LABEL[item.priority || "normal"] || "Normal",
      dependencyNames(item.dependency_ids, item.depends_on_activity_id, tasks),
      item.information || "—", item.group || "—", item.sector || "—", item.channel || "—", item.type || "—",
      `${checklist.done}/${checklist.total}`,
      cache.deliveryObjectiveById?.[item.objective_id]?.name || "—",
      responsibilityNames(item.assignee_ids, item.owner_id, item.assignee_job_titles),
      item.due_date ? dt(item.due_date) : "—",
      TASK_STATUS.find((status) => status.id === (item.status || "todo"))?.label || "A fazer",
      item.notes || "—"
    ];
  }
  if (projectBoardState.section === "objectives") {
    const linked = tasks.filter((task) => task.objective_id === item.id);
    const done = linked.filter((task) => task.status === "done").length;
    const progress = linked.length ? Math.round(done / linked.length * 100) : 0;
    return [
      item.name || "—", item.completion_criteria || "—", `${done}/${linked.length} · ${progress}%`,
      deliveryObjectiveDependencyLabel(item), assigneeNames([], item.owner_id),
      item.due_date ? dt(item.due_date) : "—",
      TASK_STATUS.find((status) => status.id === (item.status || "todo"))?.label || "A fazer"
    ];
  }
  const current = Number(item.current_value || 0);
  const target = Number(item.target_value || 0);
  return [
    item.name || "—", item.metric || "—", current.toLocaleString("pt-BR"),
    `${GOAL_COMPARISON_LABEL[item.comparison] || "No mínimo"} ${target.toLocaleString("pt-BR")} ${item.unit || ""}`.trim(),
    `${target ? Math.max(0, Math.min(100, Math.round(current / target * 100))) : 0}%`,
    deliveryGoalDependencyLabel(item), assigneeNames([], item.owner_id),
    item.due_date ? dt(item.due_date) : "—",
    TASK_STATUS.find((status) => status.id === (item.status || "todo"))?.label || "A fazer"
  ];
}

function projectRowValue(item, key, tasks) {
  const index = Number(String(key || "").slice(1));
  return String(projectSectionValues(item, tasks)[index] ?? "—");
}

function filterProjectSectionRows(rows, tasks = []) {
  const query = String(projectBoardState.search || "").trim().toLocaleLowerCase("pt-BR");
  const filters = projectBoardState.filters || {};
  const filtered = rows.filter((item) => {
    const values = projectSectionValues(item, tasks);
    const matchesSearch = !query || values.some((value) => String(value ?? "").toLocaleLowerCase("pt-BR").includes(query));
    return matchesSearch && Object.entries(filters).every(([key, selected]) =>
      !selected?.size || selected.has(projectRowValue(item, key, tasks))
    );
  });
  if (!projectBoardState.sortKey) return filtered;
  return filtered.sort((a, b) => projectRowValue(a, projectBoardState.sortKey, tasks).localeCompare(
    projectRowValue(b, projectBoardState.sortKey, tasks), "pt-BR", { numeric: true, sensitivity: "base" }
  ) * projectBoardState.sortDir);
}

function projectFilterStripHtml() {
  const filters = projectBoardState.filters || {};
  const labels = PROJECT_TABLE_LABELS[projectBoardState.section] || [];
  const active = Object.entries(filters).filter(([, values]) => values?.size);
  return `<div class="registration-filter-strip"><div class="registration-filter-badges">${active.map(([key, values]) => {
    const label = labels[Number(key.slice(1))] || key;
    return `<button class="registration-filter-badge project-filter-badge" data-key="${esc(key)}" title="Limpar filtro"><span>${esc(label)}: ${esc([...values].join(", "))}</span><b>×</b></button>`;
  }).join("")}</div><button class="filter-clear-all project-filter-clear-all" type="button"${active.length < 2 ? " hidden" : ""}><span aria-hidden="true">×</span> Limpar tudo</button></div>`;
}

function projectToolbarHtml(client, product, total) {
  const sectionLabel = projectBoardState.section === "activities" ? "tarefa(s)" : projectBoardState.section === "objectives" ? "objetivo(s)" : "meta(s)";
  return `<div class="project-head project-data-toolbar">
    <div class="registration-toolbar-left"><div class="project-meta"><span>${esc(client)}</span><span>·</span><span>${esc(product)}</span><span>·</span><span>${total} ${sectionLabel}</span></div></div>
    <div class="registration-toolbar-center"><input class="search registration-toolbar-search" id="project-search" placeholder="Buscar..." value="${esc(projectBoardState.search || "")}">${projectBoardState.section === "activities" ? '<button class="btn primary plus" id="project-add-task" title="Adicionar tarefa">+</button>' : ""}</div>
    <div class="registration-toolbar-right"><button class="btn project-cols-btn" type="button" title="Selecionar colunas"${projectBoardState.view === "table" ? "" : " disabled"}>⊞</button>
      <button class="view project-mode${projectBoardState.view === "table" ? " active" : ""}" data-project-mode="table">Tabela</button>
      <button class="view project-mode${projectBoardState.view === "matrix" ? " active" : ""}" data-project-mode="matrix">Matriz</button>
      <button class="view project-mode${projectBoardState.view === "dashboard" ? " active" : ""}" data-project-mode="dashboard">Dashboard</button>
    </div>
  </div>`;
}

function renderProjectBoard(projectId) {
  const root = document.getElementById("project-board-root");
  const project = (cache.projects || []).find((p) => p.id === projectId);
  if (!root || !project) return;
  const allTasks = projectTasks(projectId);
  const allRows = projectSectionRows(projectId);
  const rows = filterProjectSectionRows(allRows, allTasks);
  const client = cache.companyById[project.company_id]?.legal_name || "Sem cliente";
  const product = cache.productById[project.product_id]?.name || "Sem produto";
  const view = projectBoardState.view || "table";
  let body = "";
  if (projectBoardState.section === "activities") {
    body = view === "table" ? renderTaskTable(rows) : view === "matrix" ? renderTaskMatrix(rows) : renderTaskDashboard(rows);
  } else if (projectBoardState.section === "objectives") {
    body = view === "table" ? renderDeliveryObjectives(projectId, allTasks, rows)
      : view === "matrix" ? renderDeliveryStatusMatrix(rows, "objectives", allTasks)
      : renderDeliverySectionDashboard(rows, "objectives", allTasks);
  } else {
    body = view === "table" ? renderDeliveryGoals(projectId, rows)
      : view === "matrix" ? renderDeliveryStatusMatrix(rows, "goals")
      : renderDeliverySectionDashboard(rows, "goals");
  }
  root.innerHTML = `<div class="project-board">${projectToolbarHtml(client, product, rows.length)}${view === "table" ? projectFilterStripHtml() : ""}${body}</div>`;
  const table = root.querySelector("table");
  if (table && view === "table") wireProjectTableColumns(table);
  if (projectBoardState.section === "objectives" && view === "table") wireDeliveryObjectives(projectId);
  if (projectBoardState.section === "goals" && view === "table") wireDeliveryGoals(projectId);
  wireProjectBoard(projectId);
}

async function updateDeliveryObjective(objectiveId, patch) {
  const rows = loadDeliveryObjectives();
  const objective = rows.find((item) => item.id === objectiveId);
  if (!objective) return;
  if (patch.status && patch.status !== "todo") {
    const dependencyState = deliveryObjectiveDependencyState(objective);
    if (dependencyState.blocked) {
      const pending = dependencyState.pendingObjectives[0]?.name || activityDisplayName(dependencyState.pendingActivities[0]);
      toast(`Conclua "${pending}" antes de avançar este objetivo.`, true);
      return false;
    }
  }
  if (patch.status && patch.status !== "done" && objective.status === "done") {
    const activeDependent = rows.find((item) => normalizeIdList(item.dependency_objective_ids).includes(objective.id) && item.status !== "todo");
    if (activeDependent) {
      toast(`Volte "${activeDependent.name}" para A fazer antes de reabrir este objetivo.`, true);
      return false;
    }
  }
  const changes = { ...patch, updated_at: new Date().toISOString() };
  if (isLive()) await updateRow("deliveryObjectives", objectiveId, changes);
  Object.assign(objective, changes);
  if (isLive()) cache.deliveryObjectives = rows;
  else saveDeliveryObjectives(rows);
  refreshActivityCache();
  return true;
}

function wireDeliveryObjectives(projectId) {
  document.querySelectorAll("#project-board-root tr[data-objective-id]").forEach((row) => {
    const objectiveId = row.dataset.objectiveId;
    row.querySelector(".delivery-objective-owner")?.addEventListener("change", async (event) => {
      await updateDeliveryObjective(objectiveId, { owner_id: event.target.value || null });
    });
    row.querySelector(".delivery-objective-due")?.addEventListener("change", async (event) => {
      await updateDeliveryObjective(objectiveId, { due_date: event.target.value || null });
    });
    row.querySelector(".delivery-objective-status")?.addEventListener("change", async (event) => {
      await updateDeliveryObjective(objectiveId, { status: event.target.value });
      renderProjectBoard(projectId);
    });
  });
}

async function updateDeliveryGoal(goalId, patch) {
  const rows = loadDeliveryGoals();
  const goal = rows.find((item) => item.id === goalId);
  if (!goal) return;
  if (patch.status && patch.status !== "todo") {
    const dependencyState = deliveryGoalDependencyState(goal);
    if (dependencyState.blocked) {
      const pending = dependencyState.pendingGoals[0]?.name || activityDisplayName(dependencyState.pendingActivities[0]);
      toast(`Conclua "${pending}" antes de avançar esta meta.`, true);
      return false;
    }
  }
  if (patch.status && patch.status !== "done" && goal.status === "done") {
    const activeDependent = rows.find((item) => normalizeIdList(item.dependency_goal_ids).includes(goal.id) && item.status !== "todo");
    if (activeDependent) {
      toast(`Volte "${activeDependent.name}" para A fazer antes de reabrir esta meta.`, true);
      return false;
    }
  }
  const changes = { ...patch, updated_at: new Date().toISOString() };
  if (isLive()) await updateRow("deliveryGoals", goalId, changes);
  Object.assign(goal, changes);
  if (isLive()) cache.deliveryGoals = rows;
  else saveDeliveryGoals(rows);
  return true;
}

function wireDeliveryGoals(projectId) {
  document.querySelectorAll("#project-board-root tr[data-goal-id]").forEach((row) => {
    const goalId = row.dataset.goalId;
    row.querySelector(".delivery-goal-current")?.addEventListener("change", async (event) => {
      const goal = loadDeliveryGoals().find((item) => item.id === goalId);
      const currentValue = Number(event.target.value || 0);
      const reached = goal && deliveryGoalReached(goal, currentValue);
      const status = reached && !deliveryGoalDependencyState(goal).blocked ? "done" : (goal?.status === "done" ? "doing" : goal?.status || "todo");
      await updateDeliveryGoal(goalId, { current_value: currentValue, status });
      renderProjectBoard(projectId);
    });
    row.querySelector(".delivery-goal-owner")?.addEventListener("change", async (event) =>
      updateDeliveryGoal(goalId, { owner_id: event.target.value || null }));
    row.querySelector(".delivery-goal-due")?.addEventListener("change", async (event) =>
      updateDeliveryGoal(goalId, { due_date: event.target.value || null }));
    row.querySelector(".delivery-goal-status")?.addEventListener("change", async (event) => {
      await updateDeliveryGoal(goalId, { status: event.target.value });
      renderProjectBoard(projectId);
    });
  });
}

async function updateProjectTask(taskId, patch) {
  const tasks = loadProjectTasks();
  const task = tasks.find((item) => item.id === taskId);
  if (!task) return false;
  if (patch.status && patch.status !== "todo" && taskIsBlocked(task, tasks)) {
    const dependency = taskDependencies(task, tasks).find((item) => item.status !== "done");
    toast(`Conclua "${dependency ? activityDisplayName(dependency) : "a tarefa anterior"}" antes de iniciar esta tarefa.`, true);
    return false;
  }
  if (patch.status && patch.status !== "done" && task.status === "done") {
    const activeDependent = tasks.find((item) => normalizeIdList(item.dependency_ids, item.depends_on_activity_id).includes(task.id) && item.status !== "todo");
    if (activeDependent) {
      toast(`Volte "${activityDisplayName(activeDependent)}" para A fazer antes de reabrir esta tarefa.`, true);
      return false;
    }
  }
  const changes = { ...patch, updated_at: new Date().toISOString() };
  if (isLive()) await updateRow("activities", taskId, changes);
  Object.assign(task, changes);
  if (isLive()) cache.activityRecords = tasks;
  else saveProjectTasks(tasks);
  refreshActivityCache();
  return true;
}

function createsTaskDependencyCycle(tasks, currentId, dependencyIds) {
  if (!currentId) return false;
  const reachesCurrent = (candidateId, path = new Set()) => {
    if (candidateId === currentId) return true;
    if (path.has(candidateId)) return false;
    const nextPath = new Set(path).add(candidateId);
    const candidate = tasks.find((task) => task.id === candidateId);
    return normalizeIdList(candidate?.dependency_ids, candidate?.depends_on_activity_id)
      .some((nextId) => reachesCurrent(nextId, nextPath));
  };
  return dependencyIds.some((dependencyId) => reachesCurrent(dependencyId));
}

function renderActivityChecklistPanel(taskId) {
  const body = document.getElementById("activity-checklist-body");
  const task = loadProjectTasks().find((item) => item.id === taskId);
  if (!body || !task) return;
  const items = normalizeChecklist(task.checklist);
  const progress = checklistProgress(items);
  body.innerHTML = `<div class="checklist-panel-summary"><span>${progress.done} de ${progress.total} concluído(s)</span><strong>${progress.total ? Math.round(progress.done / progress.total * 100) : 0}%</strong></div>
    <div>${items.map((item) => `<div class="checklist-item${item.checked ? " done" : ""}" data-id="${esc(item.id)}">
      <input class="activity-check-toggle" type="checkbox"${item.checked ? " checked" : ""} title="Marcar como concluído">
      <input class="activity-check-text" type="text" value="${esc(item.text)}" aria-label="Item do checklist">
      <button class="rowbtn activity-check-remove" type="button" title="Remover item">✕</button>
    </div>`).join("") || '<div class="empty" style="padding:28px 8px">Nenhum item no checklist.</div>'}</div>
    <div class="checklist-new"><input id="activity-check-new" placeholder="Novo item"><button class="btn primary" id="activity-check-add">Adicionar</button></div>`;
  const persist = async (nextItems) => {
    try {
      await updateProjectTask(taskId, { checklist: normalizeChecklist(nextItems) });
      renderActivityChecklistPanel(taskId);
    } catch (err) { toast("Erro ao atualizar checklist · " + err.message, true); }
  };
  body.querySelectorAll(".checklist-item").forEach((row) => {
    row.querySelector(".activity-check-toggle").addEventListener("change", (event) => {
      const next = items.map((item) => item.id === row.dataset.id ? { ...item, checked: event.target.checked } : item);
      persist(next);
    });
    row.querySelector(".activity-check-text").addEventListener("change", (event) => {
      const next = items.map((item) => item.id === row.dataset.id ? { ...item, text: event.target.value.trim() } : item);
      persist(next);
    });
    row.querySelector(".activity-check-remove").addEventListener("click", () =>
      persist(items.filter((item) => item.id !== row.dataset.id)));
  });
  const addItem = () => {
    const input = document.getElementById("activity-check-new");
    const text = input?.value.trim();
    if (!text) return;
    persist([...items, { id: crypto.randomUUID(), text, checked: false }]);
  };
  document.getElementById("activity-check-add")?.addEventListener("click", addItem);
  document.getElementById("activity-check-new")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") addItem();
  });
}

function openActivityChecklist(taskId) {
  const task = loadProjectTasks().find((item) => item.id === taskId);
  if (!task) return;
  const fullModal = document.querySelector("#ov .modal.full");
  if (fullModal) {
    document.getElementById("activity-checklist-overlay")?.remove();
    const overlay = document.createElement("div");
    overlay.id = "activity-checklist-overlay";
    overlay.className = "activity-form-overlay";
    overlay.innerHTML = `<aside class="activity-form-drawer"><h3>Checklist<button class="modal-close-x" id="activity-checklist-close" title="Fechar">✕</button></h3><div class="checklist-panel-body" id="activity-checklist-body"></div></aside>`;
    fullModal.appendChild(overlay);
    const close = () => { overlay.remove(); renderProjectBoard(projectBoardState.projectId); };
    overlay.addEventListener("click", (event) => { if (event.target === overlay) close(); });
    document.getElementById("activity-checklist-close").addEventListener("click", close);
  } else {
    sidePanel(`Checklist · ${activityDisplayName(task)}`, '<div class="checklist-panel-body" id="activity-checklist-body"></div>', { closeOnOverlay: true });
    document.getElementById("side-close")?.addEventListener("click", render);
  }
  renderActivityChecklistPanel(taskId);
}

function openProjectViewMenu() {
  document.getElementById("project-view-dd")?.remove();
  const button = document.getElementById("project-view-menu-btn");
  if (!button) return;
  const rect = button.getBoundingClientRect();
  const panel = document.createElement("div");
  panel.id = "project-view-dd";
  panel.className = "view-dd";
  panel.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 198))}px`;
  panel.style.top = `${rect.bottom + 5}px`;
  panel.innerHTML = VIEW_MODES.map((mode) => `<button class="view-option${projectBoardState.view === mode.id ? " active" : ""}" data-view="${mode.id}">
    <span class="view-option-icon">${mode.icon}</span><span>${mode.label}</span><span>${projectBoardState.view === mode.id ? "✓" : ""}</span>
  </button>`).join("");
  document.body.appendChild(panel);
  panel.querySelectorAll(".view-option").forEach((option) => option.addEventListener("click", () => {
    projectBoardState.view = option.dataset.view;
    projectBoardState.page = 1;
    panel.remove();
    renderProjectBoard(projectBoardState.projectId);
  }));
  setTimeout(() => {
    const outside = (event) => {
      if (!panel.contains(event.target) && !button.contains(event.target)) {
        panel.remove();
        document.removeEventListener("mousedown", outside);
      }
    };
    document.addEventListener("mousedown", outside);
  }, 80);
}

function openTaskDeliveryPicker() {
  const deliveries = cache?.projects || [];
  if (!deliveries.length) { toast("Cadastre uma entrega antes de criar tarefas.", true); return; }
  const options = deliveries.map((project) => `<option value="${esc(project.id)}">${esc(project.name || project.client_name || project.id)}</option>`).join("");
  sidePanel("Nova tarefa", `<div class="form product-activity-form">
    <div class="field full"><label>Entrega *</label><select id="task-delivery-picker">${options}</select></div>
  </div><div class="modal-foot"><button class="btn" id="task-delivery-cancel">Cancelar</button><button class="btn primary" id="task-delivery-next">Continuar</button></div>`, { closeOnOverlay: true });
  document.getElementById("task-delivery-cancel").addEventListener("click", closeModal);
  document.getElementById("task-delivery-next").addEventListener("click", () => {
    const projectId = document.getElementById("task-delivery-picker").value;
    if (!projectId) { toast("Selecione uma entrega.", true); return; }
    closeModal();
    openProjectBoard(projectId);
    openDeliveryTaskDrawer(projectId);
  });
}

function openDeliveryTaskDrawer(projectId, editId = null) {
  document.getElementById("project-task-drawer-overlay")?.remove();
  const tasks = projectTasks(projectId);
  const current = tasks.find((task) => task.id === editId) || {};
  const objectives = loadDeliveryObjectives().filter((item) => item.project_id === projectId);
  const selectedDependencies = new Set(normalizeIdList(current.dependency_ids, current.depends_on_activity_id));
  const dependencyOptions = tasks.filter((task) => task.id !== editId).map((task) => ({ value: task.id, label: activityDisplayName(task) }));
  const selectedAssignees = new Set(normalizeIdList(current.assignee_ids, current.owner_id));
  const assigneeOptions = (cache.users || []).map((user) => ({ value: user.id, label: user.full_name || user.name || user.email || user.id }));
  const selectedJobTitles = new Set(normalizeTextList(current.assignee_job_titles));
  const objectiveOptions = ['<option value="">Sem objetivo</option>'].concat(objectives.map((item) =>
    `<option value="${esc(item.id)}"${item.id === current.objective_id ? " selected" : ""}>${esc(item.name)}</option>`)).join("");
  const recurrenceOptions = RECURRENCE_OPTIONS.map(([value, label]) => `<option value="${value}"${value === (current.recurrence || "once") ? " selected" : ""}>${label}</option>`).join("");
  const priorityOptions = PRIORITY_OPTIONS.map(([value, label]) => `<option value="${value}"${value === (current.priority || "normal") ? " selected" : ""}>${label}</option>`).join("");
  const overlay = document.createElement("div");
  overlay.id = "project-task-drawer-overlay";
  overlay.className = "activity-form-overlay";
  overlay.innerHTML = `<aside class="activity-form-drawer"><h3>${editId ? "Editar tarefa" : "Nova tarefa"}<button class="modal-close-x" id="project-task-close" title="Fechar">✕</button></h3>
    <div class="form product-activity-form">
      <div class="field"><label>Origem</label><input value="${current.source_template_id ? "Produto" : "Dia a dia"}" disabled></div>
      <div class="field"><label>Tarefa *</label><input id="project-task-title" value="${esc(current.title || "")}" placeholder="Nome da tarefa"${current.source_template_id ? " readonly" : ""}></div>
      <div class="field"><label>Informação</label><textarea id="project-task-information" rows="4" placeholder="Instruções ou contexto">${esc(current.information || "")}</textarea></div>
      <div class="field"><label>Grupo</label><input id="project-task-group" value="${esc(current.group || "")}"></div>
      <div class="field"><label>Setor</label><input id="project-task-sector" value="${esc(current.sector || "")}"></div>
      <div class="field"><label>Canal</label><input id="project-task-channel" value="${esc(current.channel || "")}"></div>
      <div class="field"><label>Tipo</label><input id="project-task-type" value="${esc(current.type || "")}"></div>
      <div class="field"><label>Recorrência</label><select id="project-task-recurrence">${recurrenceOptions}</select></div>
      <div class="field"><label>Prioridade</label><select id="project-task-priority">${priorityOptions}</select></div>
      <div class="field"><label>Objetivo</label><select id="project-task-objective">${objectiveOptions}</select></div>
      <div class="field"><label>Depende de</label>${multiPickerHtml("project-task-dependencies", dependencyOptions, selectedDependencies, "Selecionar dependências")}</div>
      <div class="field"><label>Responsáveis</label>${multiPickerHtml("project-task-assignees", assigneeOptions, selectedAssignees, "Selecionar responsáveis")}</div>
      <div class="field"><label>Cargos responsáveis</label>${multiPickerHtml("project-task-assignee-job-titles", assigneeJobTitleOptions(), selectedJobTitles, "Selecionar cargos")}</div>
      <div class="field"><label>Prazo</label><input id="project-task-due" type="date" value="${esc(current.due_date || "")}"></div>
      <div class="field"><label>Notas</label><textarea id="project-task-notes" rows="4">${esc(current.notes || "")}</textarea></div>
    </div><div class="modal-foot"><button class="btn" id="project-task-cancel">Cancelar</button><button class="btn primary" id="project-task-save">${editId ? "Salvar" : "Criar"}</button></div>
  </aside>`;
  document.querySelector("#ov .modal.full")?.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.addEventListener("click", (event) => { if (event.target === overlay) close(); });
  document.getElementById("project-task-close").addEventListener("click", close);
  document.getElementById("project-task-cancel").addEventListener("click", close);
  wireMultiPicker("project-task-dependencies");
  wireMultiPicker("project-task-assignees");
  wireMultiPicker("project-task-assignee-job-titles");
  document.getElementById("project-task-save").addEventListener("click", async () => {
    const title = document.getElementById("project-task-title").value.trim();
    if (!title) { toast("Informe a tarefa.", true); return; }
    const dependencyIds = multiPickerValues("project-task-dependencies");
    const assigneeIds = multiPickerValues("project-task-assignees");
    const assigneeJobTitles = multiPickerValues("project-task-assignee-job-titles");
    if (createsTaskDependencyCycle(tasks, editId, dependencyIds)) { toast("Essa dependência criaria um ciclo entre as tarefas.", true); return; }
    const now = new Date().toISOString();
    const draft = {
      id: editId || crypto.randomUUID(), project_id: projectId, title,
      information: document.getElementById("project-task-information").value.trim(),
      group: document.getElementById("project-task-group").value.trim(),
      sector: document.getElementById("project-task-sector").value.trim(),
      channel: document.getElementById("project-task-channel").value.trim(),
      type: document.getElementById("project-task-type").value.trim(),
      recurrence: document.getElementById("project-task-recurrence").value,
      priority: document.getElementById("project-task-priority").value || "normal",
      objective_id: document.getElementById("project-task-objective").value || null,
      depends_on_activity_id: dependencyIds[0] || null,
      dependency_ids: dependencyIds,
      owner_id: assigneeIds[0] || null,
      assignee_ids: assigneeIds,
      assignee_job_titles: assigneeJobTitles,
      due_date: document.getElementById("project-task-due").value || null,
      notes: document.getElementById("project-task-notes").value.trim(),
      sort_order: editId ? Number(current.sort_order || 0) : Math.max(-1, ...tasks.map((task) => Number(task.sort_order || 0))) + 1,
      checklist: normalizeChecklist(current.checklist),
      status: current.status || "todo",
      created_at: current.created_at || now, updated_at: now
    };
    try {
      const allTasks = loadProjectTasks();
      if (editId) {
        const saved = isLive() ? await updateRow("activities", editId, draft) : { ...current, ...draft };
        Object.assign(allTasks.find((task) => task.id === editId), saved);
      } else {
        const saved = isLive() ? await createRow("activities", draft) : draft;
        allTasks.push(saved);
      }
      if (isLive()) cache.activityRecords = allTasks;
      else saveProjectTasks(allTasks);
      refreshActivityCache();
      projectBoardState.page = Math.max(1, Math.ceil(projectTasks(projectId).length / projectBoardState.pageSize));
      close();
      renderProjectBoard(projectId);
      toast(editId ? "Tarefa atualizada." : "Tarefa criada.");
    } catch (err) { toast("Erro ao salvar tarefa · " + err.message, true); }
  });
  document.getElementById("project-task-title").focus();
}

function projectTableRows(table) {
  return [...table.querySelectorAll("tbody tr")].filter((row) => row.children.length > 1 && !row.querySelector(".empty"));
}

function projectTableDefinitions(table) {
  return [...table.querySelectorAll("thead th[data-project-column]")]
    .map((header) => ({ k: header.dataset.projectColumn, h: header.dataset.projectLabel }))
    .sort((a, b) => Number(a.k.slice(1)) - Number(b.k.slice(1)));
}

function applyProjectTableColumnPreferences(table) {
  const scope = `delivery:${projectBoardState.section}`;
  const prefs = secondaryColumnPrefs(scope);
  const definitions = projectTableDefinitions(table);
  const ordered = orderedColumnDefinitions(definitions, prefs);
  const headRow = table.tHead?.rows?.[0];
  if (!headRow) return;
  const headers = Object.fromEntries([...headRow.cells].filter((cell) => cell.dataset.projectColumn).map((cell) => [cell.dataset.projectColumn, cell]));
  const fixedHeaders = [...headRow.cells].filter((cell) => !cell.dataset.projectColumn);
  ordered.forEach((col) => headRow.appendChild(headers[col.k]));
  const selectionHeader = fixedHeaders.find((cell) => cell.classList.contains("select-head"));
  if (selectionHeader) headRow.insertBefore(selectionHeader, headRow.firstChild);
  fixedHeaders.filter((cell) => cell !== selectionHeader).forEach((cell) => headRow.appendChild(cell));
  projectTableRows(table).forEach((row) => {
    const cells = Object.fromEntries([...row.cells].filter((cell) => cell.dataset.projectColumn).map((cell) => [cell.dataset.projectColumn, cell]));
    const fixedCells = [...row.cells].filter((cell) => !cell.dataset.projectColumn);
    ordered.forEach((col) => { if (cells[col.k]) row.appendChild(cells[col.k]); });
    const selectionCell = fixedCells.find((cell) => cell.classList.contains("select-cell"));
    if (selectionCell) row.insertBefore(selectionCell, row.firstChild);
    fixedCells.filter((cell) => cell !== selectionCell).forEach((cell) => row.appendChild(cell));
  });
  ordered.forEach((col) => {
    const visible = prefs[col.k] !== false;
    headers[col.k].hidden = !visible;
    projectTableRows(table).forEach((row) => {
      const cell = row.querySelector(`td[data-project-column="${CSS.escape(col.k)}"]`);
      if (cell) cell.hidden = !visible;
    });
  });
}

function wireProjectTableColumns(table) {
  const headers = [...table.querySelectorAll("thead th")];
  headers.forEach((header, index) => {
    if (header.textContent.trim().toLocaleUpperCase("pt-BR") === "AÇÕES") return;
    const key = `d${index}`;
    header.dataset.projectColumn = key;
    header.dataset.projectLabel = header.textContent.trim();
    header.title = "Clique para ordenar. Ctrl+clique para filtrar.";
    projectTableRows(table).forEach((row) => {
      const cell = row.children[index];
      if (cell) cell.dataset.projectColumn = key;
    });
    if (projectBoardState.sortKey === key) {
      header.insertAdjacentHTML("beforeend", ` <span class="arrow">${projectBoardState.sortDir > 0 ? "▲" : "▼"}</span>`);
    }
    header.addEventListener("click", (event) => {
      if (event.ctrlKey || event.metaKey) {
        openProjectColumnFilter(header, key);
        return;
      }
      if (projectBoardState.sortKey === key) projectBoardState.sortDir *= -1;
      else {
        projectBoardState.sortKey = key;
        projectBoardState.sortDir = 1;
      }
      projectBoardState.page = 1;
      renderProjectBoard(projectBoardState.projectId);
    });
  });
  applyProjectTableColumnPreferences(table);
  wireSecondaryTableSelection(table, `delivery:${projectBoardState.projectId}:${projectBoardState.section}`);
}

function openProjectColumnFilter(header, key) {
  document.getElementById("project-filter-dd")?.remove();
  const tasks = projectTasks(projectBoardState.projectId);
  const rows = projectSectionRows(projectBoardState.projectId);
  const values = [...new Set(rows.map((item) => projectRowValue(item, key, tasks)))]
    .sort((a, b) => a.localeCompare(b, "pt-BR", { numeric: true, sensitivity: "base" }));
  const selected = new Set(projectBoardState.filters?.[key] || []);
  const rect = header.getBoundingClientRect();
  const panel = document.createElement("div");
  panel.id = "project-filter-dd";
  panel.className = "filter-dd";
  panel.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 330))}px`;
  panel.style.top = `${Math.min(rect.bottom + 4, window.innerHeight - 360)}px`;
  panel.innerHTML = `<div class="dd-head"><span>Filtrar · ${esc(header.dataset.projectLabel)}</span><span>${values.length}</span></div>
    <div class="dd-search"><input placeholder="Buscar..."></div><div class="dd-list"></div>
    <div class="dd-foot"><button class="btn project-filter-all">Todos</button><button class="btn danger project-filter-clear">Limpar</button><button class="btn primary project-filter-apply">Aplicar</button></div>`;
  document.body.appendChild(panel);
  const list = panel.querySelector(".dd-list");
  const draw = () => {
    const query = panel.querySelector("input").value.trim().toLocaleLowerCase("pt-BR");
    list.innerHTML = values.filter((value) => !query || value.toLocaleLowerCase("pt-BR").includes(query))
      .map((value) => `<label class="dd-item${selected.has(value) ? " on" : ""}" data-value="${esc(value)}"><span class="dd-check">${selected.has(value) ? "✓" : ""}</span><span>${esc(value)}</span></label>`).join("");
    list.querySelectorAll(".dd-item").forEach((item) => item.addEventListener("click", () => {
      const value = item.dataset.value;
      if (selected.has(value)) selected.delete(value); else selected.add(value);
      draw();
    }));
  };
  draw();
  panel.querySelector("input").addEventListener("input", draw);
  panel.querySelector(".project-filter-all").addEventListener("click", () => {
    if (selected.size === values.length) selected.clear(); else values.forEach((value) => selected.add(value));
    draw();
  });
  panel.querySelector(".project-filter-clear").addEventListener("click", () => {
    delete projectBoardState.filters[key];
    projectBoardState.page = 1;
    panel.remove();
    renderProjectBoard(projectBoardState.projectId);
  });
  panel.querySelector(".project-filter-apply").addEventListener("click", () => {
    if (selected.size && selected.size < values.length) projectBoardState.filters[key] = selected;
    else delete projectBoardState.filters[key];
    projectBoardState.page = 1;
    panel.remove();
    renderProjectBoard(projectBoardState.projectId);
  });
  panel.querySelector("input").focus();
  setTimeout(() => {
    const outside = (event) => {
      if (!panel.contains(event.target) && !header.contains(event.target)) {
        panel.remove();
        document.removeEventListener("mousedown", outside);
      }
    };
    document.addEventListener("mousedown", outside);
  }, 50);
}

function openProjectColumnManager(table) {
  openSecondaryColumnManager({
    scope: `delivery:${projectBoardState.section}`,
    label: projectBoardState.section === "activities" ? "Tarefas da entrega" : projectBoardState.section === "objectives" ? "Objetivos da entrega" : "Metas da entrega",
    definitions: projectTableDefinitions(table),
    onChange: () => applyProjectTableColumnPreferences(table)
  });
}

function wireProjectBoard(projectId) {
  document.getElementById("project-search")?.addEventListener("input", (event) => {
    projectBoardState.search = event.target.value;
    projectBoardState.page = 1;
    renderProjectBoard(projectId);
    const input = document.getElementById("project-search");
    input?.focus();
    input?.setSelectionRange(input.value.length, input.value.length);
  });
  document.querySelectorAll(".project-mode").forEach((button) => button.addEventListener("click", () => {
    projectBoardState.view = button.dataset.projectMode;
    projectBoardState.page = 1;
    renderProjectBoard(projectId);
  }));
  document.querySelector(".project-cols-btn")?.addEventListener("click", (event) => {
    event.stopPropagation();
    const table = document.querySelector("#project-board-root table");
    if (table) openProjectColumnManager(table);
  });
  document.querySelectorAll(".project-filter-badge").forEach((badge) => badge.addEventListener("click", () => {
    delete projectBoardState.filters[badge.dataset.key];
    projectBoardState.page = 1;
    renderProjectBoard(projectId);
  }));
  document.querySelector(".project-filter-clear-all")?.addEventListener("click", () => {
    projectBoardState.filters = {};
    projectBoardState.page = 1;
    renderProjectBoard(projectId);
  });
  document.getElementById("project-add-task")?.addEventListener("click", () => openDeliveryTaskDrawer(projectId));
  document.getElementById("project-page-prev")?.addEventListener("click", () => { projectBoardState.page -= 1; renderProjectBoard(projectId); });
  document.getElementById("project-page-next")?.addEventListener("click", () => { projectBoardState.page += 1; renderProjectBoard(projectId); });
  document.getElementById("project-calendar-prev")?.addEventListener("click", () => {
    const date = dateOnly(`${projectBoardState.calendarCursor}-01`); date.setMonth(date.getMonth() - 1);
    projectBoardState.calendarCursor = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`; renderProjectBoard(projectId);
  });
  document.getElementById("project-calendar-next")?.addEventListener("click", () => {
    const date = dateOnly(`${projectBoardState.calendarCursor}-01`); date.setMonth(date.getMonth() + 1);
    projectBoardState.calendarCursor = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`; renderProjectBoard(projectId);
  });
  document.getElementById("project-calendar-today")?.addEventListener("click", () => { projectBoardState.calendarCursor = null; renderProjectBoard(projectId); });
  document.querySelectorAll(".project-calendar-item,.project-gantt-item").forEach((button) =>
    button.addEventListener("click", () => openActivityChecklist(button.dataset.id)));
  document.querySelectorAll("#project-board-root .checklist-open").forEach((button) =>
    button.addEventListener("click", () => openActivityChecklist(button.dataset.id)));
  document.querySelectorAll("#project-board-root .task-edit[data-id]").forEach((button) =>
    button.addEventListener("click", () => openDeliveryTaskDrawer(projectId, button.dataset.id)));
  document.querySelectorAll("#project-board-root .task-card").forEach((card) => {
    const id = card.dataset.id;
    const rerender = () => renderProjectBoard(projectId);
    card.querySelector(".task-title-input")?.addEventListener("change", async (e) => updateProjectTask(id, { title: e.target.value.trim() }));
    card.querySelector(".task-edit")?.addEventListener("click", () => openDeliveryTaskDrawer(projectId, id));
    card.querySelector(".task-due")?.addEventListener("change", async (e) => updateProjectTask(id, { due_date: e.target.value || null }));
    card.querySelector(".task-notes")?.addEventListener("change", async (e) => updateProjectTask(id, { notes: e.target.value }));
    card.querySelector(".task-status")?.addEventListener("change", async (e) => { await updateProjectTask(id, { status: e.target.value }); rerender(); });
    card.querySelector(".del-task")?.addEventListener("click", async () => {
      if (!window.confirm("Excluir esta tarefa?")) return;
      try {
        if (isLive()) await deleteRow("activities", id);
        const remaining = loadProjectTasks().filter((task) => task.id !== id);
        if (isLive()) cache.activityRecords = remaining;
        else saveProjectTasks(remaining);
        refreshActivityCache();
        renderProjectBoard(projectId);
      } catch (err) { toast("Erro ao excluir tarefa · " + err.message, true); }
    });
  });
}

function closeFloaters() {
  document.getElementById("filter-dd")?.remove();
  document.getElementById("cols-dd")?.remove();
  document.getElementById("csv-dd")?.remove();
  document.getElementById("data-dd")?.remove();
  document.getElementById("view-dd")?.remove();
  document.getElementById("registration-filter-dd")?.remove();
}

const VIEW_MODES = [
  { id: "table", label: "Tabela", icon: "▦" },
  { id: "kanban", label: "Quadro", icon: "▥", tabs: ["deals", "activities"] },
  { id: "calendar", label: "Calendário", icon: "□", tabs: ["deals", "projects", "activities"] },
  { id: "gantt", label: "Gantt", icon: "▤", tabs: ["deals", "projects", "activities"] }
];

function viewModeAvailable(mode, tab = state.tab) {
  return !mode.tabs || mode.tabs.includes(tab);
}

function openViewMenu() {
  closeFloaters();
  const button = document.getElementById("view-menu-btn");
  if (!button || button.disabled) return;
  const rect = button.getBoundingClientRect();
  const panel = document.createElement("div");
  panel.id = "view-dd";
  panel.className = "view-dd";
  panel.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 198))}px`;
  panel.style.top = `${rect.bottom + 5}px`;
  panel.innerHTML = VIEW_MODES.map((mode) => {
    const available = viewModeAvailable(mode);
    return `<button class="view-option${state.view === mode.id ? " active" : ""}" data-view="${mode.id}"${available ? "" : " disabled"}>
      <span class="view-option-icon">${mode.icon}</span><span>${mode.label}</span><span>${state.view === mode.id ? "✓" : ""}</span>
    </button>`;
  }).join("");
  document.body.appendChild(panel);
  panel.querySelectorAll(".view-option:not(:disabled)").forEach((option) => option.addEventListener("click", () => {
    state.view = option.dataset.view;
    closeFloaters();
    render();
  }));
  setTimeout(() => {
    const outside = (event) => {
      if (!panel.contains(event.target) && event.target !== button && !button.contains(event.target)) {
        panel.remove();
        document.removeEventListener("mousedown", outside);
      }
    };
    document.addEventListener("mousedown", outside);
  }, 80);
}

function renderActiveFilterBadges() {
  const root = document.getElementById("filter-badges");
  if (!root) return;
  const filters = tabFilters();
  const cols = orderedColumns(state.tab, cache);
  const orderedKeys = cols.map((col) => col.k);
  const active = [
    ...orderedKeys.map((key) => [key, filters[key]]),
    ...Object.entries(filters).filter(([key]) => !orderedKeys.includes(key))
  ].filter(([, values]) => values?.size);
  root.innerHTML = active.map(([key, values]) => {
    const col = cols.find((item) => item.k === key);
    const label = col?.h || key;
    const selected = [...values];
    const sample = (cache[state.tab] || []).find((row) => String(row[key] ?? "") === selected[0]) || {};
    const valueLabel = selected.length === 1
      ? (selected[0] === "" ? "(em branco)" : col ? displayValue(sample, col, cache) : selected[0])
      : `${selected.length} selecionados`;
    return `<button class="filter-badge" data-key="${esc(key)}" title="Remover filtro de ${esc(label)}"><span>${esc(label)}: ${esc(valueLabel)}</span><span class="x">×</span></button>`;
  }).join("");
  root.querySelectorAll(".filter-badge").forEach((badge) => badge.addEventListener("click", () => {
    delete filters[badge.dataset.key];
    if (state.pages[state.tab]) state.pages[state.tab] = 1;
    closeFloaters();
    render();
  }));
  const clearAll = document.getElementById("filter-clear-all");
  clearAll.hidden = active.length < 2;
  clearAll.onclick = active.length < 2 ? null : () => {
    state.filters[state.tab] = {};
    if (state.pages[state.tab]) state.pages[state.tab] = 1;
    closeFloaters();
    render();
  };
}

function openColumnFilter(th, key) {
  document.getElementById("filter-dd")?.remove();
  const col = columns(state.tab, cache).find((item) => item.k === key);
  const allRows = cache[state.tab] || [];
  const values = [...new Set(allRows.map((r) => String(r[key] ?? "")))].sort((a, b) => a.localeCompare(b, "pt-BR"));
  const filters = tabFilters();
  let temp = new Set(filters[key] || []);
  const rect = th.getBoundingClientRect();
  const dd = document.createElement("div");
  dd.id = "filter-dd";
  dd.className = "filter-dd";
  dd.style.left = Math.min(rect.left, window.innerWidth - 330) + "px";
  dd.style.top = Math.min(rect.bottom + 4, window.innerHeight - 360) + "px";
  dd.innerHTML = `
    <div class="dd-head"><span>▼ ${esc(col?.h || key)}</span><span>${values.length} valores</span></div>
    <div class="dd-search"><input id="filter-dd-search" placeholder="Buscar..."></div>
    <div class="dd-list" id="filter-dd-list"></div>
    <div class="dd-foot">
      <button class="btn" id="filter-dd-all">Todos</button>
      <button class="btn primary" id="filter-dd-ok">Aplicar</button>
      <button class="btn danger" id="filter-dd-clear">Limpar</button>
    </div>`;
  document.body.appendChild(dd);

  const list = dd.querySelector("#filter-dd-list");
  const input = dd.querySelector("#filter-dd-search");
  const labelFor = (v) => {
    const sample = allRows.find((r) => String(r[key] ?? "") === v) || {};
    return v === "" ? "(em branco)" : displayValue(sample, col, cache);
  };
  const draw = () => {
    const q = input.value.trim().toLowerCase();
    list.innerHTML = values.filter((v) => !q || v.toLowerCase().includes(q) || labelFor(v).toLowerCase().includes(q))
      .map((v) => `<div class="dd-item${temp.has(v) ? " on" : ""}" data-v="${esc(v)}">
        <span class="dd-check">${temp.has(v) ? "✓" : ""}</span><span>${esc(labelFor(v))}</span>
      </div>`).join("");
    list.querySelectorAll(".dd-item").forEach((item) => item.addEventListener("mousedown", (e) => {
      e.preventDefault(); e.stopPropagation();
      const v = item.dataset.v;
      if (temp.has(v)) temp.delete(v); else temp.add(v);
      draw();
    }));
  };
  draw();
  input.addEventListener("input", draw);
  dd.querySelector("#filter-dd-all").addEventListener("mousedown", (e) => {
    e.preventDefault(); e.stopPropagation();
    temp = temp.size === values.length ? new Set() : new Set(values);
    draw();
  });
  dd.querySelector("#filter-dd-clear").addEventListener("mousedown", (e) => {
    e.preventDefault(); e.stopPropagation();
    delete filters[key]; if (state.pages[state.tab]) state.pages[state.tab] = 1; closeFloaters(); render();
  });
  dd.querySelector("#filter-dd-ok").addEventListener("mousedown", (e) => {
    e.preventDefault(); e.stopPropagation();
    if (temp.size === 0 || temp.size === values.length) delete filters[key];
    else filters[key] = new Set(temp);
    if (state.pages[state.tab]) state.pages[state.tab] = 1;
    closeFloaters(); render();
  });
  setTimeout(() => {
    const outside = (e) => {
      if (!dd.contains(e.target) && e.target !== th) {
        dd.remove();
        document.removeEventListener("mousedown", outside);
      }
    };
    document.addEventListener("mousedown", outside);
  }, 80);
  input.focus();
}

function openColumnManager() {
  document.getElementById("cols-dd")?.remove();
  const baseCols = columns(state.tab, cache);
  const prefs = colPrefs[state.tab] || {};
  let order = orderedColumns(state.tab, cache).map((col) => col.k);
  let listMode = "all";
  let draggedKey = null;
  const panel = document.createElement("div");
  panel.id = "cols-dd";
  panel.className = "cols-dd";
  panel.innerHTML = `
    <div class="column-manager-head"><span>⊞ Colunas · ${esc(ENTITY_LABEL[state.tab] || state.tab)}</span><button class="column-manager-close" type="button" title="Fechar">×</button></div>
    <div class="column-manager-controls">
      <button class="column-manager-preset" id="cols-dd-reset" type="button">↺ Padrão · ${esc(ENTITY_LABEL[state.tab] || state.tab)}</button>
      <select class="column-manager-filter" id="cols-dd-filter" aria-label="Filtrar colunas">
        <option value="all">Todos</option>
        <option value="visible">Visíveis</option>
        <option value="hidden">Ocultas</option>
      </select>
    </div>
    <div class="column-manager-list" id="cols-dd-list"></div>`;
  document.body.appendChild(panel);
  const colsInOrder = () => order.map((key) => baseCols.find((col) => col.k === key)).filter(Boolean);
  const draw = () => {
    const listed = colsInOrder().filter((col) => listMode === "all" || (listMode === "visible" ? prefs[col.k] !== false : prefs[col.k] === false));
    panel.querySelector("#cols-dd-list").innerHTML = listed.map((col) => {
      const on = prefs[col.k] !== false;
      return `<div class="column-manager-row${on ? "" : " off"}" data-k="${esc(col.k)}" draggable="true">
        <span class="column-drag-handle" title="Arrastar para reordenar">⠿</span>
        <button class="column-switch${on ? " on" : ""}" type="button" role="switch" aria-checked="${on}" title="${on ? "Ocultar" : "Exibir"} ${esc(col.h)}"></button>
        <span class="column-manager-label">${esc(col.h)}</span>
      </div>`;
    }).join("");
    panel.querySelectorAll(".column-manager-row").forEach((item) => {
      item.querySelector(".column-switch").addEventListener("click", () => {
        const visibleCount = baseCols.filter((col) => prefs[col.k] !== false).length;
        const k = item.dataset.k;
        if (prefs[k] !== false && visibleCount <= 1) return;
        prefs[k] = prefs[k] === false;
        prefs.__order = [...order];
        colPrefs[state.tab] = prefs;
        saveColPrefs();
        draw();
        render();
      });
      item.addEventListener("dragstart", (event) => {
        draggedKey = item.dataset.k;
        item.classList.add("dragging");
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", draggedKey);
      });
      item.addEventListener("dragover", (event) => {
        event.preventDefault();
        if (draggedKey && draggedKey !== item.dataset.k) item.classList.add("drag-over");
      });
      item.addEventListener("dragleave", () => item.classList.remove("drag-over"));
      item.addEventListener("drop", (event) => {
        event.preventDefault();
        const targetKey = item.dataset.k;
        item.classList.remove("drag-over");
        if (!draggedKey || draggedKey === targetKey) return;
        const from = order.indexOf(draggedKey);
        const to = order.indexOf(targetKey);
        order.splice(from, 1);
        order.splice(to, 0, draggedKey);
        prefs.__order = [...order];
        colPrefs[state.tab] = prefs;
        saveColPrefs();
        draggedKey = null;
        draw();
        render();
      });
      item.addEventListener("dragend", () => {
        draggedKey = null;
        panel.querySelectorAll(".column-manager-row").forEach((row) => row.classList.remove("dragging", "drag-over"));
      });
    });
  };
  draw();
  panel.querySelector(".column-manager-close").addEventListener("click", () => panel.remove());
  panel.querySelector("#cols-dd-filter").addEventListener("change", (event) => {
    listMode = event.target.value;
    draw();
  });
  panel.querySelector("#cols-dd-reset").addEventListener("click", () => {
    Object.keys(prefs).forEach((key) => delete prefs[key]);
    order = baseCols.map((col) => col.k);
    colPrefs[state.tab] = prefs;
    saveColPrefs();
    listMode = "all";
    panel.querySelector("#cols-dd-filter").value = "all";
    draw();
    render();
  });
  setTimeout(() => {
    const outside = (e) => {
      if (!panel.contains(e.target) && e.target.id !== "cols-btn") {
        panel.remove();
        document.removeEventListener("mousedown", outside);
      }
    };
    document.addEventListener("mousedown", outside);
  }, 80);
}

const SECONDARY_COL_PREFS_KEY = "crm_secondary_cols_v1";
let secondaryColPrefs = (() => {
  try { return JSON.parse(localStorage.getItem(SECONDARY_COL_PREFS_KEY) || "{}"); }
  catch (e) { return {}; }
})();

function secondaryColumnPrefs(scope) {
  if (!secondaryColPrefs[scope]) secondaryColPrefs[scope] = {};
  return secondaryColPrefs[scope];
}

function saveSecondaryColumnPrefs() {
  localStorage.setItem(SECONDARY_COL_PREFS_KEY, JSON.stringify(secondaryColPrefs));
}

function orderedColumnDefinitions(definitions, prefs) {
  const savedOrder = Array.isArray(prefs.__order) ? prefs.__order : [];
  const byKey = Object.fromEntries(definitions.map((col) => [col.k, col]));
  return [
    ...savedOrder.map((key) => byKey[key]).filter(Boolean),
    ...definitions.filter((col) => !savedOrder.includes(col.k))
  ];
}

function openSecondaryColumnManager({ scope, label, definitions, onChange }) {
  document.getElementById("cols-dd")?.remove();
  const prefs = secondaryColumnPrefs(scope);
  let order = orderedColumnDefinitions(definitions, prefs).map((col) => col.k);
  let listMode = "all";
  let draggedKey = null;
  const panel = document.createElement("div");
  panel.id = "cols-dd";
  panel.className = "cols-dd";
  panel.innerHTML = `
    <div class="column-manager-head"><span>⊞ Colunas · ${esc(label)}</span><button class="column-manager-close" type="button" title="Fechar">×</button></div>
    <div class="column-manager-controls">
      <button class="column-manager-preset" type="button">↺ Padrão · ${esc(label)}</button>
      <select class="column-manager-filter" aria-label="Filtrar colunas">
        <option value="all">Todos</option><option value="visible">Visíveis</option><option value="hidden">Ocultas</option>
      </select>
    </div>
    <div class="column-manager-list"></div>`;
  document.body.appendChild(panel);
  const ordered = () => order.map((key) => definitions.find((col) => col.k === key)).filter(Boolean);
  const persist = () => {
    prefs.__order = [...order];
    secondaryColPrefs[scope] = prefs;
    saveSecondaryColumnPrefs();
    onChange();
  };
  const draw = () => {
    const listed = ordered().filter((col) => listMode === "all" || (listMode === "visible" ? prefs[col.k] !== false : prefs[col.k] === false));
    panel.querySelector(".column-manager-list").innerHTML = listed.map((col) => {
      const on = prefs[col.k] !== false;
      return `<div class="column-manager-row${on ? "" : " off"}" data-k="${esc(col.k)}" draggable="true">
        <span class="column-drag-handle" title="Arrastar para reordenar">⠿</span>
        <button class="column-switch${on ? " on" : ""}" type="button" role="switch" aria-checked="${on}" title="${on ? "Ocultar" : "Exibir"} ${esc(col.h)}"></button>
        <span class="column-manager-label">${esc(col.h)}</span>
      </div>`;
    }).join("");
    panel.querySelectorAll(".column-manager-row").forEach((item) => {
      item.querySelector(".column-switch").addEventListener("click", () => {
        const visibleCount = definitions.filter((col) => prefs[col.k] !== false).length;
        const key = item.dataset.k;
        if (prefs[key] !== false && visibleCount <= 1) return;
        prefs[key] = prefs[key] === false;
        persist();
        draw();
      });
      item.addEventListener("dragstart", (event) => {
        draggedKey = item.dataset.k;
        item.classList.add("dragging");
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", draggedKey);
      });
      item.addEventListener("dragover", (event) => {
        event.preventDefault();
        if (draggedKey && draggedKey !== item.dataset.k) item.classList.add("drag-over");
      });
      item.addEventListener("dragleave", () => item.classList.remove("drag-over"));
      item.addEventListener("drop", (event) => {
        event.preventDefault();
        const targetKey = item.dataset.k;
        item.classList.remove("drag-over");
        if (!draggedKey || draggedKey === targetKey) return;
        const from = order.indexOf(draggedKey);
        const to = order.indexOf(targetKey);
        order.splice(from, 1);
        order.splice(to, 0, draggedKey);
        draggedKey = null;
        persist();
        draw();
      });
      item.addEventListener("dragend", () => {
        draggedKey = null;
        panel.querySelectorAll(".column-manager-row").forEach((row) => row.classList.remove("dragging", "drag-over"));
      });
    });
  };
  draw();
  panel.querySelector(".column-manager-close").addEventListener("click", () => panel.remove());
  panel.querySelector(".column-manager-filter").addEventListener("change", (event) => {
    listMode = event.target.value;
    draw();
  });
  panel.querySelector(".column-manager-preset").addEventListener("click", () => {
    Object.keys(prefs).forEach((key) => delete prefs[key]);
    order = definitions.map((col) => col.k);
    listMode = "all";
    panel.querySelector(".column-manager-filter").value = "all";
    persist();
    draw();
  });
  setTimeout(() => {
    const outside = (event) => {
      if (!panel.contains(event.target) && !event.target.closest(".registration-cols-btn,.tools-cols-btn,.project-cols-btn")) {
        panel.remove();
        document.removeEventListener("mousedown", outside);
      }
    };
    document.addEventListener("mousedown", outside);
  }, 80);
}

function csvCell(v) {
  const s = String(v ?? "").replace(/<[^>]+>/g, "");
  return `"${s.replace(/"/g, '""')}"`;
}

function downloadCSV(cols, rows, filename) {
  const header = cols.map((col) => csvCell(col.h)).join(";");
  const body = rows.map((row) => cols.map((col) => {
    const val = col.csv ? col.csv(row[col.k], row, cache) : (col.fmt ? col.fmt(row[col.k], row, cache) : row[col.k] ?? "");
    return csvCell(val);
  }).join(";")).join("\n");
  const blob = new Blob(["\ufeff" + header + "\n" + body], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = new Date().toISOString().slice(0, 16).replace("T", "_").replace(":", "-");
  a.href = url;
  a.download = filename || `entepriser_crm_${state.tab}_${stamp}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function exportTableCSV(activeOnly) {
  const cols = activeOnly ? visibleColumns(state.tab, cache) : columns(state.tab, cache);
  const rows = rowsFor(state.tab, cache);
  const suffix = activeOnly ? "colunas_ativas" : "todas_colunas";
  const stamp = new Date().toISOString().slice(0, 16).replace("T", "_").replace(":", "-");
  downloadCSV(cols, rows, `entepriser_crm_${state.tab}_${suffix}_${stamp}.csv`);
  toast(`CSV exportado: ${rows.length} linhas.`);
}

function openDataMenu() {
  document.getElementById("data-dd")?.remove();
  const panel = document.createElement("div");
  panel.id = "data-dd";
  panel.className = "data-dd";
  panel.innerHTML = `
    <div class="dd-head"><span>Dados</span><span>CSV / WhatsApp</span></div>
    <div class="dd-head"><span>Exportar</span><span></span></div>
    <button class="dd-menu-btn" id="csv-active">CSV (Colunas Ativas)</button>
    <button class="dd-menu-btn" id="csv-all">CSV (Todas as Colunas)</button>
    <div class="dd-head"><span>Importar</span><span></span></div>
    <button class="dd-menu-btn" id="import-whatsapp">Conversa (.txt/.zip)</button>`;
  document.body.appendChild(panel);
  panel.querySelector("#csv-active").addEventListener("click", () => { panel.remove(); exportTableCSV(true); });
  panel.querySelector("#csv-all").addEventListener("click", () => { panel.remove(); exportTableCSV(false); });
  panel.querySelector("#import-whatsapp").addEventListener("click", () => {
    panel.remove();
    document.getElementById("import-file").click();
  });
  setTimeout(() => {
    const outside = (e) => {
      if (!panel.contains(e.target) && e.target.id !== "data-btn") {
        panel.remove();
        document.removeEventListener("mousedown", outside);
      }
    };
    document.addEventListener("mousedown", outside);
  }, 80);
}

function readFileAsArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

async function zipTextFromBuffer(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 66000); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("ZIP inválido.");
  const centralOffset = view.getUint32(eocd + 16, true);
  const entries = view.getUint16(eocd + 10, true);
  let pos = centralOffset;
  for (let i = 0; i < entries; i++) {
    if (view.getUint32(pos, true) !== 0x02014b50) break;
    const method = view.getUint16(pos + 10, true);
    const compressedSize = view.getUint32(pos + 20, true);
    const fileNameLength = view.getUint16(pos + 28, true);
    const extraLength = view.getUint16(pos + 30, true);
    const commentLength = view.getUint16(pos + 32, true);
    const localOffset = view.getUint32(pos + 42, true);
    const nameStart = pos + 46;
    const name = new TextDecoder().decode(bytes.slice(nameStart, nameStart + fileNameLength));
    if (name.toLowerCase().endsWith(".txt")) {
      const localNameLength = view.getUint16(localOffset + 26, true);
      const localExtraLength = view.getUint16(localOffset + 28, true);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const dataEnd = dataStart + compressedSize;
      const payload = bytes.slice(dataStart, dataEnd);
      if (method === 0) return new TextDecoder("utf-8").decode(payload);
      if (method === 8 && "DecompressionStream" in window) {
        const stream = new Blob([payload]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
        return await new Response(stream).text();
      }
      throw new Error("ZIP compactado em formato não suportado pelo navegador.");
    }
    pos += 46 + fileNameLength + extraLength + commentLength;
  }
  throw new Error("Nenhum arquivo .txt encontrado no ZIP.");
}

async function textFromImportFile(file) {
  const buffer = await readFileAsArrayBuffer(file);
  if (file.name.toLowerCase().endsWith(".zip")) return zipTextFromBuffer(buffer);
  return new TextDecoder("utf-8").decode(buffer);
}

function parseWhatsAppText(text, filename) {
  const cleanName = filename.replace(/\.(txt|zip)$/i, "").replace(/^Conversa do WhatsApp com\s+/i, "").trim();
  const fileLower = filename.toLowerCase();
  const source = fileLower.includes("reddit") ? "Reddit" : fileLower.includes("instagram") ? "Instagram" : "WhatsApp";
  const lines = text.replace(/\r/g, "").split("\n");
  const messages = [];
  const re = /^(\d{1,2}\/\d{1,2}\/\d{2,4})\s+(\d{1,2}:\d{2})\s+-\s+(?:(.*?):\s)?([\s\S]*)$/;
  for (const line of lines) {
    const m = line.match(re);
    if (m) {
      messages.push({ at: `${m[1]} ${m[2]}`, author: m[3] || "", text: m[4] || "" });
    } else if (messages.length && line.trim()) {
      messages[messages.length - 1].text += "\n" + line;
    }
  }
  const authorCount = {};
  messages.forEach((m) => {
    if (!m.author) return;
    authorCount[m.author] = (authorCount[m.author] || 0) + 1;
  });
  const contactName = cleanName || Object.keys(authorCount).sort((a, b) => authorCount[b] - authorCount[a])[0] || "Contato importado";
  const fullText = messages.map((m) => m.text).join("\n");
  const email = fullText.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || "";
  const phone = fullText.match(/(?:\+?\d{1,3}\s?)?(?:\(?\d{2}\)?\s?)?\d{4,5}[-\s]?\d{4}/)?.[0] || "";
  const amountRaw = fullText.match(/(?:R\$\s*)?\d{1,3}(?:\.\d{3})*,\d{2}/)?.[0] || "";
  const amount = amountRaw ? Number(amountRaw.replace(/[^\d,]/g, "").replace(",", ".")) : null;
  const relevant = messages.filter((m) => m.author && !/^<M[íi]dia oculta>|Mensagem apagada$/i.test(m.text)).slice(-8);
  const summary = relevant.map((m) => `${m.author}: ${m.text}`).join(" / ").slice(0, 360);
  return {
    id: crypto.randomUUID(),
    source,
    origin: "Importação",
    contact_name: contactName,
    contact: source === "WhatsApp" ? phone : cleanName,
    username: "",
    profile_url: "",
    chat_url: "",
    message_count: messages.length,
    first_at: messages[0]?.at || "",
    last_at: messages[messages.length - 1]?.at || "",
    email,
    phone,
    amount,
    title: `WhatsApp - ${contactName}`,
    summary,
    raw: text,
    messages,
    imported_at: new Date().toLocaleString("pt-BR"),
    status: "imported"
  };
}

async function importWhatsAppFile(file) {
  try {
    const text = await textFromImportFile(file);
    const row = parseWhatsAppText(text, file.name);
    const conversations = loadConversations();
    conversations.unshift(row);
    saveConversations(conversations);
    state.tab = "conversations";
    state.view = "table";
    state.q = "";
    document.getElementById("search").value = "";
    render();
    toast(`Conversa importada: ${row.contact_name}.`);
  } catch (err) {
    toast("Erro ao importar · " + err.message, true);
  }
}

function deleteImport(id) {
  const conversations = loadConversations().filter((row) => row.id !== id);
  state.selectedConversations.delete(id);
  saveConversations(conversations);
  render();
  toast("Conversa excluída.");
}

function openConversationPopup(id) {
  const row = findConversation(id);
  if (!row) return;
  const messages = row.messages || [];
  // "Minhas" mensagens são reconhecidas pelo nome cadastrado em
  // Configurações → Meus dados (sem isso configurado, nada é destacado).
  const myName = String(getCfg().myName || "").trim().toLowerCase();
  const body = messages.length
    ? messages.map((m) => {
      const mine = myName && String(m.author || "").toLowerCase().includes(myName);
      return `<div class="chat-msg${mine ? " mine" : ""}">
        <div class="meta">${esc(m.author || "Sistema")} · ${esc(m.at || "")}</div>
        <div class="txt">${esc(m.text || "")}</div>
      </div>`;
    }).join("")
    : `<div class="panel-list">${esc(row.raw || row.summary || "Sem conteúdo.")}</div>`;
  sidePanel(`Conversa · ${row.contact_name || "Contato"}`, `<div class="chat-log">${body}</div>`);
}

function openAssociateContactModal(ids = [...state.selectedConversations]) {
  const rows = ids.map(findConversation).filter(Boolean);
  if (!rows.length) { toast("Selecione uma conversa.", true); return; }
  const options = cache.contacts.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("");
  shell("Associar contato", `<div class="form">
      <div class="field full"><label>Pessoa</label><select id="associate-person">${options}</select></div>
    </div>
    <div class="panel-list" style="padding-top:0">${rows.length} conversa(s) selecionada(s).</div>
    <div class="modal-foot"><button class="btn" id="cancel">Cancelar</button>
      <button class="btn primary" id="save">Associar</button></div>`);
  document.getElementById("cancel").addEventListener("click", closeModal);
  document.getElementById("save").addEventListener("click", () => {
    const personId = document.getElementById("associate-person").value;
    const conversations = loadConversations();
    conversations.forEach((row) => {
      if (ids.includes(row.id)) row.contact_id = personId;
    });
    saveConversations(conversations);
    closeModal();
    state.selectedConversations.clear();
    render();
    toast("Contato associado.");
  });
}

async function convertImportToDeal(id) {
  const conversations = loadConversations();
  const row = conversations.find((item) => item.id === id);
  if (!row) return;
  try {
    let contact = row.contact_id ? cache.contacts.find((c) => c.id === row.contact_id) : null;
    if (!contact) {
      contact = cache.contacts.find((c) =>
        (row.email && String(c.email || "").toLowerCase().includes(row.email.toLowerCase())) ||
        (contactForConversation(row) && String(c.phone || c.whatsapp || "").includes(contactForConversation(row))) ||
        (row.source === "Reddit" && row.username && String(c.reddit || "").toLowerCase().includes(row.username.toLowerCase())) ||
        c.name === row.contact_name
      );
    }
    if (!contact) {
      contact = await createRow("contacts", {
        name: row.contact_name,
        phone: row.phone || row.contact || null,
        email: row.email || null,
        contact_type: "Importado",
        channel: row.source || "WhatsApp",
        whatsapp: String(row.source || "").toLowerCase().includes("whatsapp") ? (row.phone || row.contact || null) : null
      });
    }
    const firstPipeline = (cache.pipelines || [])[0];
    await createRow("deals", {
      title: row.title || `WhatsApp - ${row.contact_name}`,
      contact_id: contact.id,
      company_id: contact.company_id || null,
      product_id: null,
      owner_id: null,
      pipeline_id: firstPipeline?.id || null,
      stage: firstPipeline?.stages?.[0] || null,
      status: "open",
      lead_source: "WhatsApp",
      amount: row.amount || null,
      expected_close_date: null
    });
    row.status = "converted";
    row.contact_id = contact.id;
    saveConversations(conversations);
    state.selectedConversations.delete(id);
    closeModal();
    toast("Conversa transformada em negociação.");
    await init();
    state.tab = "deals";
    render();
  } catch (err) {
    toast("Erro ao criar negociação · " + err.message, true);
  }
}

async function createDealFromSelectedConversations() {
  const rows = selectedConversationRows();
  if (!rows.length) { toast("Selecione uma conversa.", true); return; }
  for (const row of rows) await convertImportToDeal(row.id);
}

function render() {
  if (!cache) return;
  refreshActivityCache();
  document.querySelector('[data-action="log"]')?.toggleAttribute("hidden", !currentUserIsAdmin());
  document.querySelector('[data-action="registrations"]')?.toggleAttribute("disabled", !currentUserIsAdmin());
  const hasConversationSelection = state.selectedConversations.size > 0;
  const isHome = state.tab === "home";
  document.querySelector(".subbar")?.classList.toggle("home-hidden", isHome);
  const requestedMode = VIEW_MODES.find((mode) => mode.id === state.view);
  if (!requestedMode || !viewModeAvailable(requestedMode)) state.view = "table";
  if (state.view === "matrix" || state.view === "dashboard") state.view = "table";
  document.getElementById("selection-actions").classList.toggle("show", hasConversationSelection);
  document.querySelectorAll(".view").forEach((v) => {
    v.hidden = isHome;
    const unavailable = v.dataset.view !== "table" || hasConversationSelection;
    v.disabled = unavailable;
    v.classList.toggle("locked", unavailable);
  });
  const viewMenuButton = document.getElementById("view-menu-btn");
  const activeMode = VIEW_MODES.find((mode) => mode.id === state.view) || VIEW_MODES[0];
  viewMenuButton.hidden = isHome;
  viewMenuButton.disabled = hasConversationSelection;
  viewMenuButton.classList.toggle("active", !isHome);
  document.getElementById("view-menu-label").textContent = activeMode.label.toLocaleUpperCase("pt-BR");
  document.getElementById("search").disabled = isHome;
  document.getElementById("new").disabled = isHome;
  document.getElementById("cols-btn").disabled = isHome;
  document.getElementById("data-btn").disabled = isHome;
  document.getElementById("filter-strip").classList.toggle("home-hidden", isHome);
  if (!isHome) renderActiveFilterBadges();

  if (isHome) renderHome(cache);
  else if (state.view === "kanban" && state.tab === "deals") renderKanban(cache);
  else if (state.view === "kanban" && state.tab === "activities") renderActivityKanban(cache);
  else if (state.view === "calendar") renderCalendar(cache);
  else if (state.view === "gantt") renderGantt(cache);
  else renderTable(cache);

  if (isHome) {
    document.getElementById("count").textContent = "Visão geral";
  } else {
  const total = (cache[state.tab] || []).length;
  const shown = rowsFor(state.tab, cache).length;
  document.getElementById("count").textContent = shown === total ? `${total} itens` : `${shown}/${total}`;
  }
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === state.tab));
  document.getElementById("brand-home")?.classList.toggle("active", isHome);
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.dataset.view === state.view));
}

// ---------- Modal genérico ----------
let modalCloseOverride = null;
let modalLayerStack = [];
function removeModalLayer(closeAction) {
  modalLayerStack = modalLayerStack.filter((item) => item !== closeAction);
}
function closeTopModalLayer() {
  const closeAction = modalLayerStack[modalLayerStack.length - 1];
  if (!closeAction) return false;
  closeAction();
  return true;
}
function escCloseHandler(e) {
  if (e.key !== "Escape") return;
  const registrationFilter = document.getElementById("registration-filter-dd");
  if (registrationFilter) { registrationFilter.remove(); e.preventDefault(); e.stopImmediatePropagation(); return; }
  const drawerOverlay = [...document.querySelectorAll(".activity-form-overlay")].at(-1);
  if (drawerOverlay) {
    const closeButton = drawerOverlay.querySelector(".modal-close-x");
    if (closeButton) closeButton.click();
    else drawerOverlay.remove();
    e.preventDefault();
    e.stopImmediatePropagation();
    return;
  }
  if (closeTopModalLayer()) { e.preventDefault(); e.stopImmediatePropagation(); return; }
  if (modalCloseOverride) modalCloseOverride();
  else closeModal();
  e.preventDefault();
  e.stopImmediatePropagation();
}
function closeModal() {
  document.getElementById("modal-root").innerHTML = "";
  document.getElementById("registration-filter-dd")?.remove();
  modalCloseOverride = null;
  modalLayerStack = [];
  document.removeEventListener("keydown", escCloseHandler);
}
function shell(title, inner, opts = {}) {
  const cls = "modal" + (opts.cls ? ` ${opts.cls}` : "");
  const overlayCls = opts.cls?.split(/\s+/).includes("full") ? "overlay full-overlay" : "overlay";
  const titleHtml = opts.titleHtml || esc(title);
  document.getElementById("modal-root").innerHTML =
    `<div class="${overlayCls}" id="ov"><div class="${cls}">
      <h3><span class="modal-title">${titleHtml}</span>${opts.headerCenter || ""}<span class="modal-header-actions">${opts.headerActions || ""}<button class="modal-close-x" id="shell-close" title="Fechar (Esc)">✕</button></span></h3>
      ${inner}
    </div></div>`;
  modalCloseOverride = typeof opts.onClose === "function" ? opts.onClose : null;
  const closeAction = () => modalCloseOverride ? modalCloseOverride() : closeModal();
  document.getElementById("shell-close").addEventListener("click", closeAction);
  document.getElementById("ov").addEventListener("click", (e) => { if (e.target.id === "ov") closeAction(); });
  document.addEventListener("keydown", escCloseHandler);
}
// Painel lateral (desliza da direita, altura cheia). Fecha pelo X no topo
// ou por ESC sempre; o clique fora só fecha quando opts.closeOnOverlay é
// true (a conversa não usa isso — só X/ESC — mas o form de negócio usa).
function sidePanel(title, inner, opts = {}) {
  modalCloseOverride = typeof opts.onClose === "function" ? opts.onClose : null;
  document.getElementById("modal-root").innerHTML =
    `<div class="overlay side" id="ov"><div class="modal side-panel">
      <h3>${esc(title)}<button class="modal-close-x" id="side-close" title="Fechar (Esc)">✕</button></h3>
      ${inner}
    </div></div>`;
  const closeAction = () => modalCloseOverride ? modalCloseOverride() : closeModal();
  document.getElementById("side-close").addEventListener("click", closeAction);
  document.addEventListener("keydown", escCloseHandler);
  if (opts.closeOnOverlay) {
    document.getElementById("ov").addEventListener("click", (e) => { if (e.target.id === "ov") closeAction(); });
  }
  return closeAction;
}

function nestedSidePanel(title, inner, opts = {}) {
  const overlay = document.createElement("div");
  overlay.className = "overlay side nested-modal-layer";
  overlay.innerHTML = `<div class="modal side-panel">
      <h3>${esc(title)}<button class="modal-close-x nested-side-close" title="Fechar (Esc)">✕</button></h3>
      ${inner}
    </div>`;
  let closed = false;
  const closeAction = () => {
    if (closed) return;
    closed = true;
    overlay.remove();
    removeModalLayer(closeAction);
    if (typeof opts.onClose === "function") opts.onClose();
  };
  document.getElementById("modal-root").appendChild(overlay);
  modalLayerStack.push(closeAction);
  overlay.querySelector(".nested-side-close").addEventListener("click", closeAction);
  if (opts.closeOnOverlay) overlay.addEventListener("click", (event) => { if (event.target === overlay) closeAction(); });
  return closeAction;
}

function nestedCenterModal(title, inner, opts = {}) {
  const overlay = document.createElement("div");
  overlay.className = `overlay${opts.cls?.split(/\s+/).includes("full") ? " full-overlay" : ""} nested-modal-layer`;
  overlay.innerHTML = `<div class="modal ${opts.cls || "wide"}">
      <h3><span>${esc(title)}</span><button class="modal-close-x nested-modal-close" title="Fechar (Esc)">✕</button></h3>
      ${inner}
    </div>`;
  let closed = false;
  const closeAction = () => {
    if (closed) return;
    closed = true;
    overlay.remove();
    removeModalLayer(closeAction);
    if (typeof opts.onClose === "function") opts.onClose();
  };
  document.getElementById("modal-root").appendChild(overlay);
  modalLayerStack.push(closeAction);
  overlay.querySelector(".nested-modal-close").addEventListener("click", closeAction);
  if (opts.closeOnOverlay) overlay.addEventListener("click", (event) => { if (event.target === overlay) closeAction(); });
  return closeAction;
}

function openForm(tab, id, opts = {}) {
  const c = cache;
  const record = id ? c[tab].find((r) => r[pk(tab)] === id) : null;
  const fs = fields(tab, c);
  if (tab === "deals") {
    const stageField = fs.find((f) => f.k === "stage");
    if (stageField) stageField.options = pipelineStageOptions(c, record?.pipeline_id);
  }
  const inputs = fs.map((f) => {
    let val = record ? record[f.k] : f.def ?? "";
    if (tab === "projects" && f.k === "name") val = deliveryGeneratedName(record?.client_name, record?.product_id);
    const isLocked = Boolean(f.generated);
    let ctrl;
    if (f.searchableRef) {
      const selected = f.options.find((option) => option.value === val);
      const listId = `search-${f.k}-options`;
      ctrl = `<input data-search-ref="${f.searchableRef}" data-search-target="${f.k}" list="${listId}" value="${esc(selected?.label || val || "")}" placeholder="Buscar empresa...">
        <input type="hidden" data-k="${f.k}" value="${esc(val || "")}">
        <datalist id="${listId}">${f.options.map((option) => `<option value="${esc(option.label)}"></option>`).join("")}</datalist>`;
    } else if (f.type === "select") {
      const opts = ['<option value="">—</option>']
        .concat(f.options.map((o) => `<option value="${esc(o.value)}"${o.value === val ? " selected" : ""}>${esc(o.label)}</option>`));
      ctrl = `<select data-k="${f.k}"${isLocked ? " disabled" : ""}>${opts.join("")}</select>`;
    } else if (f.type === "checkbox") {
      ctrl = `<input type="checkbox" data-k="${f.k}"${val ? " checked" : ""}${isLocked ? " disabled" : ""}>`;
    } else {
      const t = f.type === "number" ? "number" : f.type === "date" ? "date" : "text";
      const lockPk = id && f.k === pk(tab);
      const input = `<input type="${t}" data-k="${f.k}" value="${esc(val)}"${f.req ? " required" : ""}${(lockPk || isLocked) ? " readonly" : ""}>`;
      ctrl = f.lookup === "cnpj" && !lockPk
        ? `<div class="input-action-row">${input}<button class="btn" type="button" id="lookup-cnpj">Buscar dados</button></div>`
        : input;
    }
    const cls = "field" + (f.type === "checkbox" ? " check" : "") + (f.full ? " full" : "");
    if (f.type === "checkbox") return `<div class="${cls}">${ctrl}<label>${esc(f.label)}</label></div>`;
    return `<div class="${cls}"><label>${esc(f.label)}${f.req ? " *" : ""}</label>${ctrl}</div>`;
  }).join("");

  const title = (id ? "Editar " : "Novo ") + SINGULAR[tab];
  const generatedNotice = tab === "projects"
    ? `<div class="panel-list" style="padding:14px 18px 0">O nome da entrega é gerado automaticamente no padrão <b>EC365 | Cliente | Produto</b>.</div>`
    : "";
  const body = `${generatedNotice}<div class="form">${inputs}</div>
    <div class="modal-foot">
      <button class="btn" id="cancel">Cancelar</button>
      <button class="btn primary" id="save">${id ? "Salvar" : "Criar"}</button>
    </div>`;
  // Negócio e produto abrem em painel lateral (vindo da direita); os demais
  // cadastros continuam no modal central de sempre.
  const returnSection = opts.returnToRegistrations || null;
  const nestedRegistration = Boolean(returnSection && document.getElementById("registrations-root"));
  let returnToPrevious;
  if (nestedRegistration) returnToPrevious = nestedSidePanel(title, body, { closeOnOverlay: true });
  else {
    returnToPrevious = returnSection ? () => openRegistrationsModal(returnSection) : closeModal;
    if (SIDE_PANEL_TABS.has(tab)) sidePanel(title, body, { closeOnOverlay: true, onClose: returnSection ? returnToPrevious : null });
    else shell(title, body, { onClose: returnSection ? returnToPrevious : null });
  }
  opts.closeAction = returnToPrevious;

  document.getElementById("cancel").addEventListener("click", returnToPrevious);
  document.getElementById("save").addEventListener("click", () => saveForm(tab, id, fs, opts));
  document.querySelectorAll("#modal-root [data-search-ref]").forEach((input) => {
    const field = fs.find((item) => item.k === input.dataset.searchTarget);
    const hidden = document.querySelector(`#modal-root [data-k="${input.dataset.searchTarget}"]`);
    const syncValue = () => {
      const typed = input.value.trim().toLocaleLowerCase("pt-BR");
      const match = field?.options.find((option) => option.label.toLocaleLowerCase("pt-BR") === typed || String(option.value).toLocaleLowerCase("pt-BR") === typed);
      hidden.value = match?.value || "";
    };
    input.addEventListener("input", syncValue);
    input.addEventListener("change", syncValue);
  });
  if (tab === "companies" && !id) {
    const form = document.querySelector("#modal-root .form");
    const cnpjInput = form?.querySelector('[data-k="tax_id"]');
    const lookupButton = document.getElementById("lookup-cnpj");
    lookupButton?.addEventListener("click", () => lookupCompanyByCnpj(form, lookupButton));
    cnpjInput?.addEventListener("blur", () => {
      if (cnpjInput.value.replace(/\D/g, "").length === 14) lookupCompanyByCnpj(form, lookupButton);
    });
  }

  // Etapa depende do pipeline escolhido — repopula ao trocar.
  if (tab === "deals") {
    const form = document.querySelector("#modal-root .form");
    const pipelineEl = form?.querySelector('[data-k="pipeline_id"]');
    const stageEl = form?.querySelector('[data-k="stage"]');
    pipelineEl?.addEventListener("change", () => {
      const stages = pipelineStageOptions(c, pipelineEl.value);
      stageEl.innerHTML = ['<option value="">—</option>']
        .concat(stages.map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`)).join("");
    });
  }
  // Fim calculado a partir do início + duração do produto.
  if (tab === "projects") {
    const form = document.querySelector("#modal-root .form");
    const nameEl = form?.querySelector('[data-k="name"]');
    const clientEl = form?.querySelector('[data-k="client_name"]');
    const startEl = form?.querySelector('[data-k="start_date"]');
    const endEl = form?.querySelector('[data-k="end_date"]');
    const productEl = form?.querySelector('[data-k="product_id"]');
    const recalcName = () => { if (nameEl) nameEl.value = deliveryGeneratedName(clientEl?.value, productEl?.value); };
    const recalcEnd = () => {
      const prod = c.productById[productEl?.value];
      if (startEl?.value && prod?.duration_days) endEl.value = addDays(startEl.value, prod.duration_days);
    };
    startEl?.addEventListener("change", recalcEnd);
    clientEl?.addEventListener("input", recalcName);
    productEl?.addEventListener("change", () => { recalcEnd(); recalcName(); });
    recalcName();
  }
}

let lastCompanyLookup = "";
async function lookupCompanyByCnpj(form, button) {
  const input = form?.querySelector('[data-k="tax_id"]');
  const cnpj = input?.value.replace(/\D/g, "") || "";
  if (cnpj.length !== 14) { toast("Informe um CNPJ com 14 dígitos.", true); return; }
  if (lastCompanyLookup === cnpj && form.querySelector('[data-k="legal_name"]')?.value) return;
  const originalText = button?.textContent;
  if (button) { button.disabled = true; button.textContent = "Buscando..."; }
  try {
    const response = await fetch(`https://open.cnpja.com/office/${cnpj}`, { headers: { Accept: "application/json" } });
    if (response.status === 429) throw new Error("Limite de consultas atingido. Aguarde alguns segundos.");
    if (!response.ok) throw new Error(`CNPJ não encontrado (${response.status})`);
    const data = await response.json();
    const set = (key, value) => {
      const field = form.querySelector(`[data-k="${key}"]`);
      if (field && value != null && value !== "") field.value = value;
    };
    const taxId = String(data.taxId || cnpj).replace(/\D/g, "").replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
    const address = data.address || {};
    const addressText = [address.street, address.number, address.details, address.district].filter(Boolean).join(", ");
    const email = data.emails?.map((item) => typeof item === "string" ? item : item.address).filter(Boolean).join("; ") || "";
    const phone = data.phones?.map((item) => {
      if (typeof item === "string") return item;
      return [item.area, item.number].filter(Boolean).join(" ");
    }).filter(Boolean).join("; ") || "";
    const activity = data.mainActivity || data.company?.mainActivity;
    set("tax_id", taxId);
    set("legal_name", data.company?.name);
    set("trade_name", data.alias);
    set("email", email);
    set("phone", phone ? normalizePhoneList(phone) : "");
    set("headquarters", data.head === false ? "Filial" : "Matriz");
    set("founded_at", String(data.founded || data.openedAt || "").slice(0, 10));
    set("registration_status", data.status?.text || data.status?.name || data.status);
    set("activities", activity ? [activity.id, activity.text].filter(Boolean).join(" — ") : "");
    set("address", addressText);
    set("zip_code", address.zip);
    set("city", address.city);
    set("state", address.state);
    lastCompanyLookup = cnpj;
    toast("Dados da empresa preenchidos.");
  } catch (err) {
    lastCompanyLookup = "";
    toast("Erro ao consultar CNPJ · " + err.message, true);
  } finally {
    if (button) { button.disabled = false; button.textContent = originalText || "Buscar dados"; }
  }
}

async function saveForm(tab, id, fs, opts = {}) {
  const body = {};
  const form = document.querySelector("#modal-root .form");
  for (const f of fs) {
    const el = form?.querySelector(`[data-k="${f.k}"]`);
    if (!el) continue;
    let v;
    if (f.type === "checkbox") v = el.checked;
    else if (f.type === "number") v = el.value === "" ? null : Number(el.value);
    else v = el.value === "" ? null : el.value;
    body[f.k] = v;
  }
  if (tab === "projects") body.name = deliveryGeneratedName(body.client_name, body.product_id);
  const req = fs.find((f) => f.req && (body[f.k] == null || body[f.k] === ""));
  if (req) { toast(`Preencha: ${req.label}`, true); return; }
  if (tab === "contacts") {
    if (body.phone) body.phone = normalizePhoneList(body.phone);
    if (body.email) body.email = normalizeEmailList(body.email);
  }
  try {
    let saved;
    if (id) { saved = await updateRow(tab, id, body); toast("Atualizado."); }
    else { saved = await createRow(tab, body); toast("Criado."); }
    if (tab === "deals" && body.status === "won") {
      const dealId = id || saved?.id;
      if (dealId) await createProjectFromDeal({ id: dealId, company_id: body.company_id, contact_id: body.contact_id, product_id: body.product_id, title: body.title });
    }
    const deliveryForEmail = tab === "projects" && !id && saved?.id ? saved : null;
    await init();
    if (opts.returnToRegistrations && document.getElementById("registrations-root")) {
      opts.closeAction?.();
      renderRegistrationsSection();
    } else if (opts.returnToRegistrations) openRegistrationsModal(opts.returnToRegistrations);
    else closeModal();
    if (deliveryForEmail) provisionDeliveryEmail(deliveryForEmail);
  } catch (err) { toast("Erro ao salvar · " + err.message, true); }
}

function confirmDelete(tab, id) {
  const rec = cache[tab].find((r) => r[pk(tab)] === id);
  const nome = rec?.name || rec?.legal_name || rec?.title || "este registro";
  shell("Excluir", `<div class="panel-list">Excluir <b>${esc(nome)}</b>? Esta ação não pode ser desfeita.</div>
    <div class="modal-foot"><button class="btn" id="cancel">Cancelar</button>
    <button class="btn danger" id="ok">Excluir</button></div>`);
  document.getElementById("cancel").addEventListener("click", closeModal);
  document.getElementById("ok").addEventListener("click", async () => {
    try { await deleteRow(tab, id); toast("Excluído."); closeModal(); await init(); }
    catch (err) { toast("Erro ao excluir · " + err.message, true); }
  });
}

// ---------- Canto de ações ----------
function setTheme(light) {
  document.body.classList.toggle("light", light);
  localStorage.setItem("crm_theme", light ? "light" : "dark");
  const sun = `<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="3.4"/><path d="M10 2v2M10 16v2M2 10h2M16 10h2M4.5 4.5l1.4 1.4M14.1 14.1l1.4 1.4M15.5 4.5l-1.4 1.4M5.9 14.1l-1.4 1.4"/></svg>`;
  const moon = `<svg viewBox="0 0 20 20"><path d="M16 11.5A6.5 6.5 0 1 1 8.5 4a5 5 0 0 0 7.5 7.5z"/></svg>`;
  document.getElementById("theme-btn").innerHTML = light ? moon : sun;
}

function openSettings() {
  const c = getCfg();
  const privacySettings = IS_EXTENSION_CONTEXT ? `<div class="help-content" style="padding-bottom:0"><h4>Privacidade da extensão</h4>
      <p><a href="privacy-policy.html" target="_blank" rel="noopener">Ler a Política de Privacidade</a> ou revogar o consentimento da extensão.</p>
    </div>` : "";
  const privacyButton = IS_EXTENSION_CONTEXT ? '<button class="btn danger" id="privacy-revoke" type="button">Revogar consentimento</button>' : "";
  sidePanel("Configurações", `<div class="help-content" style="padding-bottom:0">
      <h4 style="margin-top:0">Meus dados</h4>
      <p>Usado pra te identificar nas conversas importadas ou sincronizadas pela extensão.</p>
    </div>
    <div class="form">
      <div class="field full"><label>Meu nome (como aparece nas conversas)</label>
        <input data-k="myName" value="${esc(c.myName || "")}" placeholder="Ex.: Ulisses Ferreira"></div>
      <div class="field full"><label>Meu usuário no Reddit</label>
        <input data-k="myRedditUsername" value="${esc(c.myRedditUsername || "")}" placeholder="sem o u/"></div>
    </div>
    <div class="help-content" style="padding-bottom:0">
      <h4>Conexão Supabase</h4>
    </div>
    <div class="form">
      <div class="field full"><label>Supabase Project URL</label>
        <input data-k="url" value="${esc(c.url)}" placeholder="https://xxxx.supabase.co"></div>
      <div class="field full"><label>anon public key</label>
        <input data-k="anonKey" value="${esc(c.anonKey)}" placeholder="eyJhbGci..."></div>
    </div>
    <div class="panel-list" style="padding-top:0">Deixe URL/key em branco para usar dados de exemplo.</div>
    ${privacySettings}
    <div class="modal-foot">${privacyButton}<button class="btn primary" id="save">Salvar e conectar</button></div>`, { closeOnOverlay: true });
  document.getElementById("privacy-revoke")?.addEventListener("click", async () => {
    if (!window.confirm("Revogar o consentimento da extensão? Será necessário aceitar novamente para usá-la.")) return;
    await savePrivacyConsent(null);
    closeModal();
    await startApp();
  });
  document.getElementById("save").addEventListener("click", async () => {
    const forms = document.querySelectorAll("#modal-root .form");
    const val = (k) => { for (const f of forms) { const el = f.querySelector(`[data-k="${k}"]`); if (el) return el.value.trim(); } return ""; };
    const cfg = {
      ...c,
      myName: val("myName"),
      myRedditUsername: val("myRedditUsername"),
      url: val("url").replace(/\/$/, ""),
      anonKey: val("anonKey")
    };
    localStorage.setItem("crm_cfg", JSON.stringify(cfg));
    closeModal(); toast(cfg.url && cfg.anonKey ? "Conectando…" : "Usando dados de exemplo."); await init();
  });
}

// ---------- Ajuda ----------
function helpContentHtml() {
  const platformText = IS_EXTENSION_CONTEXT
    ? "Você está usando a extensão Chrome, que acrescenta captura de WhatsApp Web e Reddit Chat e importação do Google Contatos."
    : "Você está usando a versão web. Captura automática de WhatsApp Web e Reddit Chat e importação do Google Contatos permanecem exclusivas da extensão Chrome.";
  return `<div class="help-content">
    <div class="help-intro"><strong>ENTERPRISER • CRM</strong><span>Manual das funções disponíveis</span></div>
    <p>O CRM reúne relacionamento comercial, vendas e execução das entregas. ${platformText}</p>
    <nav class="help-index" aria-label="Índice da ajuda">
      <a href="#help-start">Acesso e navegação</a><a href="#help-modules">Módulos</a><a href="#help-tables">Tabelas e filtros</a>
      <a href="#help-sales">Vendas</a><a href="#help-catalog">Cadastros</a><a href="#help-deliveries">Entregas</a>
      <a href="#help-conversations">Conversas</a><a href="#help-tools">Ferramentas</a><a href="#help-admin">Administração</a>
    </nav>

    <section class="help-section" id="help-start"><h4>Acesso e navegação</h4>
      <div class="help-columns"><div><b>Login e dados</b><p>Na web, o acesso usa a conta do Supabase fornecida pelo administrador. Apenas perfis ativos entram no CRM. O tema claro ou escuro fica salvo neste navegador.</p></div>
      <div><b>Cabeçalho e rodapé</b><p>O logo retorna à Home. Os módulos ficam no centro; à direita estão notificações, integrações, tema, configurações e sair. No rodapé ficam LOG, AJUDA, CADASTROS, FERRAMENTAS e ATUALIZAÇÕES.</p></div></div>
      <p class="help-note">Notificações ainda não possuem automação ativa. O LOG aparece apenas para administradores.</p>
    </section>

    <section class="help-section" id="help-modules"><h4>Módulos principais</h4><ul>
      <li><b>Home:</b> totais de pessoas, empresas, negócios, produtos e entregas, além de tarefas pendentes, atrasadas e próximas.</li>
      <li><b>Pessoas:</b> contatos, telefones, e-mails, empresa, cargo, canal, CPF, nascimento, redes sociais e grupos.</li>
      <li><b>Empresas:</b> CNPJ, razão social, nome fantasia, contatos, endereço, situação cadastral, atividades e observações. A consulta pelo CNPJ preenche dados públicos disponíveis.</li>
      <li><b>Conversas:</b> histórico importado ou capturado, associação a pessoas e conversão individual ou em lote para negócio.</li>
      <li><b>Negócios:</b> empresa, contato, produto, responsável, pipeline, etapa, origem, valor, previsão e situação aberto, ganho ou perdido.</li>
      <li><b>Entregas:</b> projetos e serviços pós-venda com cliente, produto, período, status, tarefas, objetivos e metas.</li>
      <li><b>Tarefas:</b> visão consolidada de todas as entregas com origem, prioridade, dependências, checklist, objetivo, responsáveis, prazo e status.</li>
    </ul></section>

    <section class="help-section" id="help-tables"><h4>Tabelas, busca e filtros</h4><ul>
      <li>A busca central filtra imediatamente os registros da tela atual.</li>
      <li>Clique no título de uma coluna para ordenar; use <b>Ctrl+clique</b> no título para escolher valores de filtro.</li>
      <li>Filtros ativos aparecem na faixa acima da tabela, na ordem das colunas. Clique no × de uma badge para removê-la ou use <b>Limpar tudo</b>.</li>
      <li>O botão <b>⊞</b> permite mostrar, ocultar e arrastar colunas. A preferência fica salva neste navegador.</li>
      <li>O botão <b>⬆⬇</b> exporta CSV usando colunas visíveis ou todas as colunas e abre a importação de conversas quando disponível.</li>
      <li>As tabelas longas têm paginação e rolagem horizontal. Em módulos compatíveis, o menu de visualização oferece Tabela, Quadro, Calendário ou Gantt.</li>
    </ul></section>

    <section class="help-section" id="help-sales"><h4>Negócios e pipelines</h4>
      <p>Cadastre até cinco pipelines, cada um com nome e etapas próprias, em <b>Cadastros → Pipeline</b>. No Quadro de Negócios, arraste cartões entre etapas, Ganho e Perdido.</p>
      <p><b>Negócio ganho:</b> ao marcar um negócio como ganho, o CRM cria a Entrega vinculada ao cliente e ao produto. O nome, período e tipo são formados a partir dos dados comerciais e do produto.</p>
      <p><b>Automação do produto:</b> tarefas, objetivos e metas configurados no produto são copiados para a nova entrega, preservando responsáveis, recorrências, checklists e dependências.</p>
    </section>

    <section class="help-section" id="help-catalog"><h4>Cadastros</h4><ul>
      <li><b>Produtos:</b> categoria, descrição, preços, página de vendas, duração e status. O ícone de configuração abre Tarefas, Objetivos e Metas do produto.</li>
      <li><b>Tarefas do produto:</b> grupo, setor, canal, tipo, prioridade, informação, recorrência, checklist, objetivo, responsáveis e dependências. É possível ordenar, clonar e reaproveitar tarefas prontas.</li>
      <li><b>Objetivos:</b> critério de conclusão, prazo sugerido, responsável e dependência de outros objetivos e/ou tarefas.</li>
      <li><b>Metas:</b> indicador, comparação, valor-alvo, unidade, prazo, responsável e dependência de outras metas e/ou tarefas.</li>
      <li><b>Pipeline:</b> criação e edição dos fluxos comerciais e suas etapas.</li>
      <li><b>Usuários:</b> nome, e-mail, telefone, perfil, função, cargo, status e acesso ao login.</li>
    </ul><p class="help-note">Dependências cíclicas são bloqueadas. Uma tarefa, objetivo ou meta dependente só avança quando os itens anteriores forem concluídos.</p></section>

    <section class="help-section" id="help-deliveries"><h4>Detalhes da entrega</h4>
      <p>Abra uma entrega para acessar as abas <b>Tarefas</b>, <b>Objetivos</b> e <b>Metas</b>. Todas possuem busca, seleção de colunas e os modos Tabela, Matriz e Dashboard.</p><ul>
      <li><b>Tarefas:</b> crie tarefas do dia a dia, altere status e prazo, acompanhe checklists, notas, responsáveis e bloqueios.</li>
      <li><b>Objetivos:</b> acompanhe progresso calculado pelas tarefas vinculadas, responsável, prazo, dependências e status.</li>
      <li><b>Metas:</b> atualize valor atual, indicador, valor-alvo, prazo, dependências e status. Metas atingidas podem ser concluídas.</li>
      <li><b>Matriz:</b> distribui itens por A fazer, Em andamento e Concluído. <b>Dashboard:</b> resume andamento, concluídos, atrasados e bloqueados.</li>
    </ul></section>

    <section class="help-section" id="help-conversations"><h4>Conversas e integrações</h4>
      <p>Na web, importe arquivos <b>.txt</b> ou <b>.zip</b> exportados do WhatsApp. Abra o histórico dentro do CRM, associe a uma pessoa ou selecione várias conversas para criar uma negociação em lote.</p>
      <p>Na extensão Chrome, WhatsApp Web e Reddit Chat podem alimentar a fila automaticamente. Google Contatos permite selecionar pessoas, criar ou atualizar contatos e criar empresas identificadas pelos dados do Google.</p>
      <p>O painel Integrações mostra o que está ativo e o que permanece em desenvolvimento.</p>
    </section>

    <section class="help-section" id="help-tools"><h4>Ferramentas</h4><ul>
      <li><b>Arquivos:</b> catálogo de atalhos para pastas, como links do Google Drive, com nome e descrição. O CRM guarda o link, não copia os arquivos.</li>
      <li><b>E-mails:</b> ao criar uma entrega, o CRM cria automaticamente na HostGator uma conta formada pela raiz do CNPJ em <b>@ecommerce365.com.br</b>. A senha pode ser revelada ou copiada nesta tela.</li>
      <li><b>Processos:</b> biblioteca de procedimentos para treinamento, com área, sistema, público, responsável, nível, tempo estimado, material de apoio e passo a passo ordenado. O botão de fluxo transforma as etapas em um diagrama visual para consulta e apresentação.</li>
      <li>Busca, classificação, filtros e seleção de colunas funcionam nas tabelas de E-mails e Processos.</li>
    </ul><p class="help-note"><b>Segurança:</b> as credenciais de e-mail são compartilhadas entre os usuários ativos do CRM e a senha permanece criptografada no Supabase. Processos podem ser consultados por usuários ativos e alterados apenas por administradores. Os links de Arquivos continuam salvos somente neste navegador.</p></section>

    <section class="help-section" id="help-admin"><h4>Administração e suporte</h4><ul>
      <li><b>LOG:</b> administradores consultam as alterações recentes registradas nas principais entidades.</li>
      <li><b>Usuários:</b> o administrador cria ou atualiza acessos, define perfil e pode inativar colaboradores.</li>
      <li><b>Configurações:</b> guarda identificação usada em conversas e a conexão Supabase. URL e chave vazias ativam os dados de demonstração.</li>
      <li><b>Atualizações:</b> mostra um resumo da versão instalada.</li>
      <li><b>Sair:</b> encerra a sessão local do usuário.</li>
    </ul><p class="help-note">Na versão web não existe tela obrigatória de aceite. O consentimento permanece na extensão por causa das funções de captura automática.</p></section>
  </div>`;
}
function openHelpModal() {
  shell("Ajuda · Como usar o ENTERPRISER • CRM", `${helpContentHtml()}
    <div class="modal-foot"><button class="btn" id="cancel">Fechar</button></div>`, { cls: "full" });
  document.getElementById("cancel").addEventListener("click", closeModal);
}

// ---------- Pipelines (fluxos de negociação) ----------
// Modal cheio, com estado próprio (lista <-> formulário) dentro do MESMO
// shell — não abre um segundo modal por cima, senão a troca de tela
// substituiria o modal-root inteiro e a lista se perderia.
let pmState = { mode: "list" };
function openPipelinesModal(editId = null, returnToRegistrations = false) {
  const pipeline = editId && editId !== "new" ? cache.pipelines.find((item) => item.id === editId) : null;
  pmState = editId
    ? { mode: "form", editId: pipeline?.id || null, name: pipeline?.name || "", stages: pipeline ? [...pipeline.stages] : [""] }
    : { mode: "list" };
  shell("Pipelines · Fluxos de negociação", `<div id="pm-body" class="full-body"></div>`, {
    cls: "full",
    onClose: returnToRegistrations ? () => openRegistrationsModal("pipelines") : null
  });
  renderPipelinesModal();
}
function renderPipelinesModal() {
  const el = document.getElementById("pm-body");
  if (!el) return;
  el.innerHTML = pmState.mode === "list" ? pipelinesListHtml() : pipelineFormHtml();
  wirePipelinesModal();
}
function pipelinesListHtml() {
  const list = cache?.pipelines || [];
  const rows = list.map((p) => `<div class="entity-row">
      <div class="entity-main"><b>${esc(p.name)}</b><span class="muted"> · ${p.stages.length} etapa(s)</span>
        <div class="muted" style="margin-top:4px">${p.stages.map(esc).join(" → ")} → <b>Ganho</b> / <b>Perdido</b></div></div>
      <div class="entity-actions">
        <button class="rowbtn edit" data-id="${esc(p.id)}" title="Editar">✎</button>
        <button class="rowbtn del" data-id="${esc(p.id)}" title="Excluir">🗑</button>
      </div></div>`).join("");
  const canAdd = list.length < MAX_PIPELINES;
  return `<div class="modal-toolbar">
      <span class="muted">${list.length}/${MAX_PIPELINES} pipelines</span>
      <button class="btn primary plus" id="new-pipeline" title="Novo pipeline"${canAdd ? "" : " disabled"}>+</button>
    </div>
    <div class="entity-list">${rows || '<div class="empty">Nenhum pipeline criado ainda.</div>'}</div>`;
}
function pipelineFormHtml() {
  const stagesHtml = pmState.stages.map((s, i) => `<div class="stage-row">
      <input type="text" class="stage-input" data-i="${i}" value="${esc(s)}" placeholder="Nome da etapa">
      <button class="rowbtn del-stage" data-i="${i}" title="Remover etapa">✕</button>
    </div>`).join("");
  return `<div class="form" style="grid-template-columns:1fr">
      <div class="field full"><label>Nome do pipeline</label><input id="pipeline-name" value="${esc(pmState.name)}" placeholder="Ex.: Vendas B2B"></div>
      <div class="field full"><label>Etapas (na ordem do funil)</label>
        <div id="stage-list">${stagesHtml}</div>
        <button class="btn" id="add-stage" style="margin-top:8px">+ Etapa</button>
      </div>
    </div>
    <div class="panel-list" style="padding-top:0"><b>Ganho</b> e <b>Perdido</b> são fixos — não precisa cadastrar, todo pipeline já termina com essas duas colunas.</div>
    <div class="modal-foot">
      <button class="btn" id="cancel-form">Voltar</button>
      <button class="btn primary" id="save-pipeline">${pmState.editId ? "Salvar" : "Criar"}</button>
    </div>`;
}
function wirePipelinesModal() {
  if (pmState.mode === "list") {
    document.getElementById("new-pipeline")?.addEventListener("click", () => {
      if ((cache.pipelines || []).length >= MAX_PIPELINES) return;
      pmState = { mode: "form", editId: null, name: "", stages: [""] };
      renderPipelinesModal();
    });
    document.querySelectorAll("#pm-body .rowbtn.edit").forEach((b) =>
      b.addEventListener("click", () => {
        const p = cache.pipelines.find((x) => x.id === b.dataset.id);
        if (!p) return;
        pmState = { mode: "form", editId: p.id, name: p.name, stages: [...p.stages] };
        renderPipelinesModal();
      }));
    document.querySelectorAll("#pm-body .rowbtn.del").forEach((b) =>
      b.addEventListener("click", async () => {
        if (!window.confirm("Excluir este pipeline? Os negócios que estavam nele ficam sem pipeline.")) return;
        try { await deleteRow("pipelines", b.dataset.id); await init(); renderPipelinesModal(); toast("Pipeline excluído."); }
        catch (err) { toast("Erro ao excluir · " + err.message, true); }
      }));
  } else {
    document.getElementById("cancel-form")?.addEventListener("click", () => { pmState = { mode: "list" }; renderPipelinesModal(); });
    document.getElementById("add-stage")?.addEventListener("click", () => { pmState.stages.push(""); renderPipelinesModal(); });
    document.querySelectorAll("#pm-body .del-stage").forEach((b) =>
      b.addEventListener("click", () => { pmState.stages.splice(Number(b.dataset.i), 1); renderPipelinesModal(); }));
    document.querySelectorAll("#pm-body .stage-input").forEach((inp) =>
      inp.addEventListener("input", () => { pmState.stages[Number(inp.dataset.i)] = inp.value; }));
    document.getElementById("pipeline-name")?.addEventListener("input", (e) => { pmState.name = e.target.value; });
    document.getElementById("save-pipeline")?.addEventListener("click", async () => {
      const name = document.getElementById("pipeline-name").value.trim();
      const stages = pmState.stages.map((s) => s.trim()).filter(Boolean);
      if (!name) { toast("Dê um nome ao pipeline.", true); return; }
      if (!stages.length) { toast("Adicione ao menos uma etapa.", true); return; }
      try {
        if (pmState.editId) await updateRow("pipelines", pmState.editId, { name, stages });
        else await createRow("pipelines", { name, stages });
        toast("Pipeline salvo.");
        await init();
        pmState = { mode: "list" };
        renderPipelinesModal();
      } catch (err) { toast("Erro ao salvar pipeline · " + err.message, true); }
    });
  }
}

// ---------- Usuários (responsáveis pelos negócios) ----------
const ROLE_LABEL = { admin: "Administrador", developer: "Desenvolvedor", user: "Usuário" };
let umState = { mode: "list" };
let umReturnToRegistrations = false;
let umCloseAction = null;
function generateStrongPassword() {
  const groups = ["ABCDEFGHJKLMNPQRSTUVWXYZ", "abcdefghijkmnopqrstuvwxyz", "23456789", "!@#$%&*"];
  const randomFrom = (chars) => chars[crypto.getRandomValues(new Uint32Array(1))[0] % chars.length];
  const chars = groups.map(randomFrom);
  const all = groups.join("");
  while (chars.length < 16) chars.push(randomFrom(all));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}
async function copyText(value) {
  try { await navigator.clipboard.writeText(value); }
  catch (e) {
    const input = document.createElement("textarea");
    input.value = value; input.style.position = "fixed"; input.style.opacity = "0";
    document.body.appendChild(input); input.select(); document.execCommand("copy"); input.remove();
  }
}
function openUsersModal(editId = null, returnToRegistrations = false) {
  if (!requireCurrentUserAdmin("Usuários")) return;
  const user = editId && editId !== "new" ? cache.users.find((item) => item.id === editId) : null;
  umReturnToRegistrations = returnToRegistrations;
  if (user) umState = { mode: "form", editId: user.id, full_name: user.full_name || user.name || "", email: user.email || "", phone: user.phone || "", role: user.role || "user", function_name: user.function_name || "", job_title: user.job_title || "", status: user.status || "active", password: "", hasAccess: Boolean(user.auth_user_id) };
  else if (editId === "new") umState = { mode: "form", editId: null, full_name: "", email: "", phone: "", role: "user", function_name: "", job_title: "", status: "active", password: generateStrongPassword(), hasAccess: false };
  else umState = { mode: "list" };
  const title = user ? "Editar usuário" : editId === "new" ? "Novo usuário" : "Usuários · Responsáveis";
  const nestedRegistration = Boolean(returnToRegistrations && document.getElementById("registrations-root"));
  umCloseAction = nestedRegistration
    ? nestedSidePanel(title, `<div id="um-body"></div>`, { closeOnOverlay: true })
    : sidePanel(title, `<div id="um-body"></div>`, {
      closeOnOverlay: true,
      onClose: returnToRegistrations ? () => openRegistrationsModal("users") : null
    });
  renderUsersModal();
}
function closeUsersModal() {
  if (umReturnToRegistrations && document.getElementById("registrations-root")) {
    umCloseAction?.();
    renderRegistrationsSection();
  } else if (umReturnToRegistrations) openRegistrationsModal("users");
  else { umState = { mode: "list" }; renderUsersModal(); }
}
function renderUsersModal() {
  const el = document.getElementById("um-body");
  if (!el) return;
  el.innerHTML = umState.mode === "list" ? usersListHtml() : umState.mode === "credentials" ? userCredentialsHtml() : userFormHtml();
  if (umState.mode === "form") {
    const emailInput = document.getElementById("u-email");
    if (emailInput) emailInput.value = umState.email || "";
  }
  wireUsersModal();
}
function usersListHtml() {
  const list = cache?.users || [];
  const rows = list.map((u) => `<div class="entity-row">
      <div class="entity-main"><b>${esc(u.full_name || u.name || "—")}</b><span class="muted"> · ${esc(u.email || "sem e-mail")}</span>
        <div class="muted" style="margin-top:4px">Perfil: ${esc(ROLE_LABEL[u.role] || u.role || "—")} · Função: ${esc(u.function_name || "—")} · Cargo: ${esc(u.job_title || "—")}</div>
        <div class="muted" style="margin-top:3px">${u.status === "active" ? "Ativo" : "Inativo"} · ${u.auth_user_id ? "Login ativo" : "Sem login"}</div></div>
      <div class="entity-actions">
        <button class="rowbtn edit" data-id="${esc(u.id)}" title="Editar">✎</button>
        <button class="rowbtn del" data-id="${esc(u.id)}" title="Excluir">🗑</button>
      </div></div>`).join("");
  return `<div class="modal-toolbar">
      <span class="muted">${list.length} usuário(s)</span>
      <button class="btn primary plus" id="new-user" title="Novo usuário">+</button>
    </div>
    <div class="entity-list">${rows || '<div class="empty">Nenhum usuário cadastrado.</div>'}</div>`;
}
function userFormHtml() {
  return `<div class="form">
      <div class="field full"><label>Nome completo</label><input id="u-name" value="${esc(umState.full_name)}"></div>
      <div class="field"><label>E-mail de acesso</label><input id="u-email" type="email" autocomplete="off" value="${esc(umState.email)}"></div>
      <div class="field"><label>Telefone</label><input id="u-phone" value="${esc(umState.phone)}"></div>
      <div class="field"><label>Perfil</label><select id="u-role">
        ${Object.entries(ROLE_LABEL).map(([v, l]) => `<option value="${v}"${umState.role === v ? " selected" : ""}>${l}</option>`).join("")}
      </select></div>
      <div class="field"><label>Função</label><input id="u-function" value="${esc(umState.function_name)}" placeholder="Ex.: Gestão de projetos"></div>
      <div class="field"><label>Cargo</label><input id="u-job-title" value="${esc(umState.job_title)}" placeholder="Ex.: Analista de implantação"></div>
      <div class="field"><label>Status</label><select id="u-status">
        <option value="active"${umState.status === "active" ? " selected" : ""}>Ativo</option>
        <option value="inactive"${umState.status === "inactive" ? " selected" : ""}>Inativo</option>
      </select></div>
      <div class="field full"><label>${umState.hasAccess ? "Nova senha (deixe em branco para manter a atual)" : "Senha de acesso"}</label>
        <div class="input-action-row"><input id="u-password" type="text" value="${esc(umState.password)}" readonly placeholder="Gere uma senha segura">
          <button class="btn" type="button" id="generate-password">Gerar</button><button class="btn" type="button" id="copy-password"${umState.password ? "" : " disabled"}>Copiar</button></div>
        <small class="muted">A senha é salva com segurança no Supabase Auth e não fica disponível depois.</small>
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn" id="cancel-form">Voltar</button>
      <button class="btn primary" id="save-user">${umState.editId ? "Salvar" : "Criar"}</button>
    </div>`;
}
function userCredentialsHtml() {
  const access = `ENTERPRISER • CRM\nE-mail: ${umState.email}\nSenha: ${umState.password}`;
  return `<div class="panel-list"><b>Acesso salvo</b><p>Copie os dados agora. Por segurança, a senha não poderá ser consultada depois.</p></div>
    <div class="form">
      <div class="field full"><label>E-mail</label><input value="${esc(umState.email)}" readonly></div>
      <div class="field full"><label>Senha</label><div class="input-action-row"><input value="${esc(umState.password)}" readonly><button class="btn primary" id="copy-access" type="button">Copiar acesso</button></div></div>
    </div>
    <div class="modal-foot"><button class="btn primary" id="credentials-done">Concluir</button></div>
    <textarea id="credentials-value" hidden>${esc(access)}</textarea>`;
}
function wireUsersModal() {
  if (umState.mode === "list") {
    document.getElementById("new-user")?.addEventListener("click", () => {
      umState = { mode: "form", editId: null, full_name: "", email: "", phone: "", role: "user", function_name: "", job_title: "", status: "active", password: generateStrongPassword(), hasAccess: false };
      renderUsersModal();
    });
    document.querySelectorAll("#um-body .rowbtn.edit").forEach((b) =>
      b.addEventListener("click", () => {
        const u = cache.users.find((x) => x.id === b.dataset.id);
        if (!u) return;
        umState = { mode: "form", editId: u.id, full_name: u.full_name || u.name || "", email: u.email || "", phone: u.phone || "", role: u.role || "user", function_name: u.function_name || "", job_title: u.job_title || "", status: u.status || "active", password: "", hasAccess: Boolean(u.auth_user_id) };
        renderUsersModal();
      }));
    document.querySelectorAll("#um-body .rowbtn.del").forEach((b) =>
      b.addEventListener("click", async () => {
        if (!window.confirm("Excluir este usuário?")) return;
        try {
          if (isLive()) await callUserAdmin("delete-user", { profile_id: b.dataset.id });
          else await deleteRow("users", b.dataset.id);
          await init(); renderUsersModal(); toast("Usuário excluído.");
        }
        catch (err) { toast("Erro ao excluir · " + err.message, true); }
      }));
  } else if (umState.mode === "credentials") {
    document.getElementById("copy-access")?.addEventListener("click", async () => {
      await copyText(document.getElementById("credentials-value").value); toast("Acesso copiado.");
    });
    document.getElementById("credentials-done")?.addEventListener("click", () => {
      closeUsersModal();
    });
  } else {
    document.getElementById("cancel-form")?.addEventListener("click", () => {
      closeUsersModal();
    });
    document.getElementById("generate-password")?.addEventListener("click", () => {
      umState.password = generateStrongPassword();
      document.getElementById("u-password").value = umState.password;
      document.getElementById("copy-password").disabled = false;
    });
    document.getElementById("copy-password")?.addEventListener("click", async () => {
      const password = document.getElementById("u-password").value;
      if (password) { await copyText(password); toast("Senha copiada."); }
    });
    document.getElementById("save-user")?.addEventListener("click", async () => {
      const full_name = document.getElementById("u-name").value.trim();
      if (!full_name) { toast("Informe o nome.", true); return; }
      const email = (document.getElementById("u-email").value.trim() || umState.email || "").toLowerCase();
      if (!email) { toast("Informe o e-mail de acesso.", true); return; }
      const password = document.getElementById("u-password").value;
      if (!umState.hasAccess && !password) { toast("Gere uma senha para ativar o acesso.", true); return; }
      const body = {
        full_name,
        email,
        phone: document.getElementById("u-phone").value.trim() || null,
        role: document.getElementById("u-role").value,
        function_name: document.getElementById("u-function").value.trim() || null,
        job_title: document.getElementById("u-job-title").value.trim() || null,
        password,
        status: document.getElementById("u-status").value
      };
      try {
        if (isLive()) await callUserAdmin("save-user", { profile_id: umState.editId, ...body });
        else {
          const { password: ignoredPassword, ...profileBody } = body;
          if (umState.editId) await updateRow("users", umState.editId, { ...profileBody, auth_user_id: umState.hasAccess ? "demo-auth" : crypto.randomUUID() });
          else await createRow("users", { ...profileBody, auth_user_id: crypto.randomUUID() });
        }
        toast("Usuário salvo.");
        await init();
        if (password) {
          umState = { mode: "credentials", email, password };
          renderUsersModal();
        } else if (umReturnToRegistrations) closeUsersModal();
        else { umState = { mode: "list" }; renderUsersModal(); }
      } catch (err) { toast("Erro ao salvar usuário · " + err.message, true); }
    });
  }
}

// ---------- Cadastros centrais ----------
const REGISTRATION_LABEL = {
  products: "Produtos",
  pipelines: "Pipeline",
  users: "Usuários",
  activities: "Tarefas",
  goals: "Metas",
  objectives: "Objetivos"
};
let registrationsState = { section: "products", tables: {} };

function openRegistrationsModal(section = "products") {
  if (!requireCurrentUserAdmin("Cadastros")) return;
  registrationsState = { section, tables: {} };
  const headerCenter = `<div class="modal-header-tabs" role="tablist" aria-label="Cadastros">
    ${Object.entries(REGISTRATION_LABEL).map(([id, label]) => `<button class="modal-header-tab${id === section ? " active" : ""}" data-registration-tab="${id}" role="tab">${label}</button>`).join("")}
  </div>`;
  const disabledFooter = `<div class="registrations-footer" aria-disabled="true">
    ${currentUserIsAdmin() ? '<button class="foot-btn" disabled>LOG</button>' : ""}
    <button class="foot-btn" disabled>AJUDA</button>
    <button class="foot-btn" disabled>CADASTROS</button>
    <button class="foot-btn" disabled>FERRAMENTAS</button>
    <button class="foot-btn" disabled>ATUALIZAÇÕES</button>
  </div>`;
  shell("Cadastros", `<div id="registrations-root" class="full-body registrations-root"></div>${disabledFooter}`, {
    cls: "full registrations-modal",
    headerCenter,
    titleHtml: '<span class="registration-brand">ENTERPRISER <b>• CRM</b><em>Cadastros</em></span>'
  });
  document.querySelectorAll("[data-registration-tab]").forEach((button) => button.addEventListener("click", () => {
    document.getElementById("registration-filter-dd")?.remove();
    registrationsState.section = button.dataset.registrationTab;
    document.querySelectorAll("[data-registration-tab]").forEach((tab) => tab.classList.toggle("active", tab === button));
    renderRegistrationsSection();
  }));
  renderRegistrationsSection();
}

function registrationProductName(productId) {
  return cache.productById?.[productId]?.name || cache.products.find((product) => product.id === productId)?.name || "Produto não encontrado";
}

function renderRegistrationsSection() {
  const root = document.getElementById("registrations-root");
  if (!root) return;
  const section = registrationsState.section;
  if (section === "products") {
    const rows = cache.products.map((product) => `<tr>
      <td><div class="registrations-product"><strong>${esc(product.name || "—")}</strong><small>${esc(product.description || "Sem descrição")}</small></div></td>
      <td>${esc(product.category || "—")}</td><td>${esc(product.status || "—")}</td>
      <td>${Number(product.price || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}</td>
      <td>${product.duration_days ? `${esc(product.duration_days)} dia(s)` : "—"}</td>
      <td class="act"><button class="rowbtn reg-product-setup" data-id="${esc(product.id)}" title="Configurar tarefas, metas e objetivos">☷</button><button class="rowbtn edit reg-product-edit" data-id="${esc(product.id)}" title="Editar produto">✎</button></td>
    </tr>`).join("");
    root.innerHTML = `<div class="modal-toolbar"><span class="muted">${cache.products.length} produto(s)</span><button class="btn primary" id="registration-add">+ Produto</button></div>
      <div class="product-activity-list"><table><thead><tr><th>Produto</th><th>Categoria</th><th>Status</th><th>Valor</th><th>Duração</th><th>Ações</th></tr></thead><tbody>${rows || '<tr><td colspan="6" class="empty">Nenhum produto cadastrado.</td></tr>'}</tbody></table></div>`;
    document.getElementById("registration-add")?.addEventListener("click", () => openForm("products", null, { returnToRegistrations: "products" }));
    root.querySelectorAll(".reg-product-setup").forEach((button) => button.addEventListener("click", () => openProductActivities(button.dataset.id, { returnToRegistrations: "products" })));
    root.querySelectorAll(".reg-product-edit").forEach((button) => button.addEventListener("click", () => openForm("products", button.dataset.id, { returnToRegistrations: "products" })));
    wireRegistrationTable();
    return;
  }
  if (section === "pipelines") {
    const pipelines = cache.pipelines || [];
    const rows = pipelines.map((pipeline) => {
      const stages = Array.isArray(pipeline.stages) ? pipeline.stages : [];
      return `<tr><td><strong>${esc(pipeline.name || "—")}</strong></td><td>${stages.length}</td><td>${esc(stages.join(" → ") || "—")}</td><td class="act"><button class="rowbtn edit reg-pipeline-edit" data-id="${esc(pipeline.id)}" title="Editar pipeline">✎</button></td></tr>`;
    }).join("");
    root.innerHTML = `<div class="modal-toolbar"><span class="muted">${pipelines.length}/${MAX_PIPELINES} pipeline(s)</span><button class="btn primary" id="registration-add"${pipelines.length >= MAX_PIPELINES ? " disabled" : ""}>+ Pipeline</button></div>
      <div class="product-activity-list"><table><thead><tr><th>Pipeline</th><th>Etapas</th><th>Fluxo</th><th>Ações</th></tr></thead><tbody>${rows || '<tr><td colspan="4" class="empty">Nenhum pipeline cadastrado.</td></tr>'}</tbody></table></div>`;
    document.getElementById("registration-add")?.addEventListener("click", () => openPipelinesModal("new", true));
    root.querySelectorAll(".reg-pipeline-edit").forEach((button) => button.addEventListener("click", () => openPipelinesModal(button.dataset.id, true)));
    wireRegistrationTable();
    return;
  }
  if (section === "users") {
    const users = cache.users || [];
    const rows = users.map((user) => `<tr><td><strong>${esc(user.full_name || user.name || "—")}</strong></td><td>${esc(user.email || "—")}</td><td>${esc(user.phone || "—")}</td><td>${esc(ROLE_LABEL[user.role] || user.role || "—")}</td><td>${esc(user.function_name || "—")}</td><td>${esc(user.job_title || "—")}</td><td>${user.status === "active" ? "Ativo" : "Inativo"}</td><td>${user.auth_user_id ? "Login ativo" : "Sem login"}</td><td class="act"><button class="rowbtn edit reg-user-edit" data-id="${esc(user.id)}" title="Editar usuário">✎</button></td></tr>`).join("");
    root.innerHTML = `<div class="modal-toolbar"><span class="muted">${users.length} usuário(s)</span><button class="btn primary" id="registration-add">+ Usuário</button></div>
      <div class="product-activity-list"><table><thead><tr><th>Usuário</th><th>E-mail</th><th>Telefone</th><th>Perfil</th><th>Função</th><th>Cargo</th><th>Status</th><th>Acesso</th><th>Ações</th></tr></thead><tbody>${rows || '<tr><td colspan="9" class="empty">Nenhum usuário cadastrado.</td></tr>'}</tbody></table></div>`;
    document.getElementById("registration-add")?.addEventListener("click", () => openUsersModal("new", true));
    root.querySelectorAll(".reg-user-edit").forEach((button) => button.addEventListener("click", () => openUsersModal(button.dataset.id, true)));
    wireRegistrationTable();
    return;
  }
  if (section === "activities") {
    const items = loadProductActivities();
    const groups = new Map();
    items.forEach((item) => {
      const key = item.template_group_id || item.id;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    });
    const rows = [...groups.values()].map((linked) => {
      const item = linked[0];
      const products = [...new Set(linked.map((candidate) => registrationProductName(candidate.product_id)))].join(", ");
      const owners = [...new Set(linked.map((candidate) => responsibilityNames(
        candidate.default_assignee_ids, candidate.default_owner_id, candidate.default_assignee_job_titles
      )).filter((value) => value !== "—"))].join(", ") || "—";
      const objectives = [...new Set(linked.map((candidate) => loadProductObjectives().find((objective) => objective.id === candidate.objective_template_id)?.name).filter(Boolean))].join(", ") || "—";
      const dependencies = [...new Set(linked.flatMap((candidate) => normalizeIdList(candidate.dependency_template_ids, candidate.depends_on_template_id)).map((id) => activityDisplayName(items.find((other) => other.id === id))).filter((name) => name !== "—"))].join(", ") || "—";
      return `<tr><td><strong>${esc(activityDisplayName(item))}</strong></td><td>${esc(products)}</td><td>${esc(item.group || "—")}</td><td>${esc(item.sector || "—")}</td><td>${esc(item.channel || "—")}</td><td>${esc(item.type || "—")}</td><td>${priorityBadge(item.priority)}</td><td>${esc(RECURRENCE_LABEL[item.recurrence] || "Única")}</td><td>${esc(item.information || "—")}</td><td>${normalizeChecklist(item.checklist).length} item(ns)</td><td>${esc(objectives)}</td><td>${esc(owners)}</td><td>${esc(dependencies)}</td><td class="act"><button class="rowbtn reg-template-clone" data-id="${esc(item.id)}" data-product="${esc(item.product_id)}" title="Clonar tarefa">⧉</button><button class="rowbtn edit reg-template-edit" data-id="${esc(item.id)}" data-product="${esc(item.product_id)}" title="Editar tarefa">✎</button></td></tr>`;
    }).join("");
    root.innerHTML = registrationTemplateTable("tarefa", groups.size, "Tarefa", "<th>Produtos</th><th>Grupo</th><th>Setor</th><th>Canal</th><th>Tipo</th><th>Prioridade</th><th>Recorrência</th><th>Informação</th><th>Checklist</th><th>Objetivo</th><th>Responsáveis padrão</th><th>Depende de</th>", rows, 14);
  } else if (section === "goals") {
    const items = loadProductGoals();
    const activities = loadProductActivities();
    const rows = items.map((item) => {
      const dependencies = [
        ...normalizeIdList(item.dependency_goal_template_ids).map((id) => items.find((goal) => goal.id === id)?.name),
        ...normalizeIdList(item.dependency_activity_template_ids).map((id) => activities.find((activity) => activity.id === id)).filter(Boolean).map(activityDisplayName)
      ].filter(Boolean).join(", ") || "—";
      return `<tr><td><strong>${esc(item.name || "—")}</strong></td><td>${esc(registrationProductName(item.product_id))}</td><td>${esc(item.metric || "—")}</td><td>${esc(`${GOAL_COMPARISON_LABEL[item.comparison] || "No mínimo"} ${Number(item.target_value || 0).toLocaleString("pt-BR")} ${item.unit || ""}`.trim())}</td><td>${esc(dependencies)}</td><td>${esc(cache.userById[item.default_owner_id]?.full_name || cache.userById[item.default_owner_id]?.name || "—")}</td><td class="act"><button class="rowbtn edit reg-template-edit" data-id="${esc(item.id)}" data-product="${esc(item.product_id)}" title="Editar meta">✎</button></td></tr>`;
    }).join("");
    root.innerHTML = registrationTemplateTable("meta", items.length, "Meta", "<th>Produto</th><th>Indicador</th><th>Valor-alvo</th><th>Depende de</th><th>Responsável padrão</th>", rows, 7);
  } else {
    const items = loadProductObjectives();
    const activities = loadProductActivities();
    const rows = items.map((item) => {
      const dependencies = [
        ...normalizeIdList(item.dependency_objective_template_ids).map((id) => items.find((objective) => objective.id === id)?.name),
        ...normalizeIdList(item.dependency_activity_template_ids).map((id) => activities.find((activity) => activity.id === id)).filter(Boolean).map(activityDisplayName)
      ].filter(Boolean).join(", ") || "—";
      return `<tr><td><strong>${esc(item.name || "—")}</strong></td><td>${esc(registrationProductName(item.product_id))}</td><td>${esc(item.completion_criteria || "—")}</td><td>${esc(dependencies)}</td><td>${item.target_days == null ? "—" : `${esc(item.target_days)} dia(s)`}</td><td>${esc(cache.userById[item.default_owner_id]?.full_name || cache.userById[item.default_owner_id]?.name || "—")}</td><td class="act"><button class="rowbtn edit reg-template-edit" data-id="${esc(item.id)}" data-product="${esc(item.product_id)}" title="Editar objetivo">✎</button></td></tr>`;
    }).join("");
    root.innerHTML = registrationTemplateTable("objetivo", items.length, "Objetivo", "<th>Produto</th><th>Critério de conclusão</th><th>Depende de</th><th>Prazo sugerido</th><th>Responsável padrão</th>", rows, 7);
  }
  document.getElementById("registration-add")?.addEventListener("click", () => {
    if (section === "activities") {
      const firstProduct = cache.products?.[0];
      if (!firstProduct) { toast("Cadastre um produto antes de criar tarefas.", true); return; }
      productActivityState = { productId: firstProduct.id, editId: null, objectiveEditId: null, goalEditId: null, tab: "activities" };
      openProductActivityDrawer();
      return;
    }
    openRegistrationProductPicker(section);
  });
  root.querySelectorAll(".reg-template-edit").forEach((button) => button.addEventListener("click", () => openRegistrationTemplateEditor(section, button.dataset.product, button.dataset.id)));
  root.querySelectorAll(".reg-template-clone").forEach((button) => button.addEventListener("click", () => {
    productActivityState = { productId: button.dataset.product, editId: null, objectiveEditId: null, goalEditId: null, tab: "activities" };
    openProductActivityDrawer(null, button.dataset.id);
  }));
  wireRegistrationTable();
}

function registrationTableState() {
  if (!registrationsState.tables[registrationsState.section]) {
    registrationsState.tables[registrationsState.section] = { sortKey: null, sortDir: 1, filters: {}, search: "", page: 1, pageSize: 50 };
  }
  return registrationsState.tables[registrationsState.section];
}

function registrationTableRows(table) {
  return [...table.querySelectorAll("tbody tr")].filter((row) => row.children.length > 1 && !row.querySelector(".empty"));
}

function wireRegistrationTable() {
  const root = document.getElementById("registrations-root");
  const table = root?.querySelector("table");
  if (!table) return;
  if (registrationsState.section === "activities") table.classList.add("registration-activities-table");
  setupRegistrationToolbar(root, table);
  const container = table.parentElement;
  if (container?.classList.contains("product-activity-list") && !container.classList.contains("paginated-registration-table")) {
    container.classList.add("paginated-registration-table");
    const scroll = document.createElement("div");
    scroll.className = "registration-table-scroll";
    container.insertBefore(scroll, table);
    scroll.appendChild(table);
    const footer = document.createElement("div");
    footer.className = "table-pagination registration-pagination";
    container.appendChild(footer);
  }
  const headers = [...table.querySelectorAll("thead th")];
  headers.forEach((header, index) => {
    if (header.textContent.trim().toLocaleUpperCase("pt-BR") === "AÇÕES") return;
    const key = `c${index}`;
    header.dataset.registrationKey = key;
    header.dataset.registrationLabel = header.textContent.trim();
    registrationTableRows(table).forEach((row) => {
      const cell = row.children[index];
      if (cell) cell.dataset.registrationKey = key;
    });
    header.title = "Clique para ordenar. Ctrl+clique para filtrar.";
    header.addEventListener("click", (event) => {
      if (event.ctrlKey || event.metaKey) {
        openRegistrationColumnFilter(header, table, key);
        return;
      }
      const tableState = registrationTableState();
      if (tableState.sortKey === key) tableState.sortDir *= -1;
      else { tableState.sortKey = key; tableState.sortDir = 1; }
      tableState.page = 1;
      applyRegistrationTableState(table);
    });
  });
  applyRegistrationColumnPreferences(table);
  applyRegistrationTableState(table);
  wireSecondaryTableSelection(table, `registrations:${registrationsState.section}`);
}

function setupRegistrationToolbar(root, table) {
  const toolbar = root.querySelector(".modal-toolbar");
  if (!toolbar || toolbar.classList.contains("registration-toolbar")) return;
  const count = toolbar.querySelector(".muted");
  const addButton = toolbar.querySelector("#registration-add");
  const tableState = registrationTableState();
  toolbar.classList.add("registration-toolbar");
  const left = document.createElement("div");
  left.className = "registration-toolbar-left";
  const center = document.createElement("div");
  center.className = "registration-toolbar-center";
  const right = document.createElement("div");
  right.className = "registration-toolbar-right";
  if (count) left.appendChild(count);
  center.innerHTML = `<input class="search registration-toolbar-search" placeholder="Buscar..." value="${esc(tableState.search || "")}">`;
  if (addButton) {
    const originalLabel = addButton.textContent.trim().replace(/^\+\s*/, "");
    addButton.classList.add("plus");
    addButton.textContent = "+";
    addButton.title = originalLabel ? `Adicionar ${originalLabel.toLocaleLowerCase("pt-BR")}` : "Adicionar";
    center.appendChild(addButton);
  }
  right.innerHTML = `<button class="btn registration-cols-btn" type="button" title="Selecionar colunas">⊞</button><button class="view active" type="button">Tabela</button><button class="view" type="button" disabled>Matriz</button><button class="view" type="button" disabled>Dashboard</button>`;
  toolbar.replaceChildren(left, center, right);
  const filterStrip = document.createElement("div");
  filterStrip.className = "registration-filter-strip";
  filterStrip.innerHTML = `<div class="registration-filter-badges"></div><button class="filter-clear-all registration-filter-clear-all" type="button" hidden><span aria-hidden="true">×</span> Limpar tudo</button>`;
  toolbar.after(filterStrip);
  center.querySelector(".registration-toolbar-search").addEventListener("input", (event) => {
    tableState.search = event.target.value.trim();
    tableState.page = 1;
    applyRegistrationTableState(table);
  });
  right.querySelector(".registration-cols-btn").addEventListener("click", (event) => {
    event.stopPropagation();
    openRegistrationColumnManager(table);
  });
}

function registrationColumnDefinitions(table) {
  return [...table.querySelectorAll("thead th[data-registration-key]")]
    .map((header) => ({ k: header.dataset.registrationKey, h: header.dataset.registrationLabel }))
    .sort((a, b) => Number(a.k.slice(1)) - Number(b.k.slice(1)));
}

function registrationCell(row, key) {
  return row.querySelector(`td[data-registration-key="${CSS.escape(key)}"]`);
}

function applyRegistrationColumnPreferences(table) {
  const scope = `registrations:${registrationsState.section}`;
  const prefs = secondaryColumnPrefs(scope);
  const definitions = registrationColumnDefinitions(table);
  const ordered = orderedColumnDefinitions(definitions, prefs);
  const headRow = table.tHead?.rows?.[0];
  if (!headRow) return;
  const headerByKey = Object.fromEntries([...headRow.cells].filter((cell) => cell.dataset.registrationKey).map((cell) => [cell.dataset.registrationKey, cell]));
  const fixedHeaders = [...headRow.cells].filter((cell) => !cell.dataset.registrationKey);
  ordered.forEach((col) => headRow.appendChild(headerByKey[col.k]));
  const selectionHeader = fixedHeaders.find((cell) => cell.classList.contains("select-head"));
  if (selectionHeader) headRow.insertBefore(selectionHeader, headRow.firstChild);
  fixedHeaders.filter((cell) => cell !== selectionHeader).forEach((cell) => headRow.appendChild(cell));
  registrationTableRows(table).forEach((row) => {
    const cellByKey = Object.fromEntries([...row.cells].filter((cell) => cell.dataset.registrationKey).map((cell) => [cell.dataset.registrationKey, cell]));
    const fixedCells = [...row.cells].filter((cell) => !cell.dataset.registrationKey);
    ordered.forEach((col) => { if (cellByKey[col.k]) row.appendChild(cellByKey[col.k]); });
    const selectionCell = fixedCells.find((cell) => cell.classList.contains("select-cell"));
    if (selectionCell) row.insertBefore(selectionCell, row.firstChild);
    fixedCells.filter((cell) => cell !== selectionCell).forEach((cell) => row.appendChild(cell));
  });
  ordered.forEach((col) => {
    const visible = prefs[col.k] !== false;
    headerByKey[col.k].hidden = !visible;
    registrationTableRows(table).forEach((row) => {
      const cell = registrationCell(row, col.k);
      if (cell) cell.hidden = !visible;
    });
  });
}

function openRegistrationColumnManager(table) {
  const definitions = registrationColumnDefinitions(table);
  openSecondaryColumnManager({
    scope: `registrations:${registrationsState.section}`,
    label: REGISTRATION_LABEL[registrationsState.section] || "Cadastros",
    definitions,
    onChange: () => {
      applyRegistrationColumnPreferences(table);
      applyRegistrationTableState(table);
    }
  });
}

function applyRegistrationTableState(table) {
  const tableState = registrationTableState();
  table.querySelector(".registration-filter-empty")?.remove();
  const rows = registrationTableRows(table);
  const query = String(tableState.search || "").toLocaleLowerCase("pt-BR");
  const filteredRows = rows.filter((row) => (!query || row.textContent.toLocaleLowerCase("pt-BR").includes(query))
    && Object.entries(tableState.filters).every(([key, selected]) => {
      if (!selected?.size) return true;
      return selected.has(registrationCell(row, key)?.textContent.trim() || "—");
    }));
  if (tableState.sortKey) {
    const compare = (a, b) => (registrationCell(a, tableState.sortKey)?.textContent.trim() || "").localeCompare(
      registrationCell(b, tableState.sortKey)?.textContent.trim() || "", "pt-BR", { numeric: true, sensitivity: "base" }
    ) * tableState.sortDir;
    rows.sort(compare).forEach((row) => table.tBodies[0].appendChild(row));
    filteredRows.sort(compare);
  }
  const totalPages = Math.max(1, Math.ceil(filteredRows.length / tableState.pageSize));
  tableState.page = Math.min(Math.max(1, tableState.page || 1), totalPages);
  const start = (tableState.page - 1) * tableState.pageSize;
  const pageRows = new Set(filteredRows.slice(start, start + tableState.pageSize));
  rows.forEach((row) => { row.hidden = !pageRows.has(row); });
  if (rows.length && !filteredRows.length) {
    const empty = document.createElement("tr");
    empty.className = "registration-filter-empty";
    empty.innerHTML = `<td colspan="${table.querySelectorAll("thead th").length}" class="empty">Nenhum registro corresponde aos filtros.</td>`;
    table.tBodies[0].appendChild(empty);
  }
  table.querySelectorAll("thead th[data-registration-key]").forEach((header) => {
    header.classList.toggle("filtered", Boolean(tableState.filters[header.dataset.registrationKey]?.size));
    header.querySelector(".registration-sort-arrow")?.remove();
    if (tableState.sortKey === header.dataset.registrationKey) {
      header.insertAdjacentHTML("beforeend", `<span class="arrow registration-sort-arrow">${tableState.sortDir > 0 ? "▲" : "▼"}</span>`);
    }
  });
  renderRegistrationFilterBadges(table);
  renderRegistrationPagination(table, filteredRows.length, totalPages);
  table._refreshSecondarySelection?.();
}

function renderRegistrationPagination(table, total, totalPages) {
  const footer = table.closest(".paginated-registration-table")?.querySelector(".registration-pagination");
  if (!footer) return;
  const tableState = registrationTableState();
  const start = total ? (tableState.page - 1) * tableState.pageSize + 1 : 0;
  const end = Math.min(tableState.page * tableState.pageSize, total);
  footer.innerHTML = `<span>${total ? `${start}-${end} de ${total}` : "0 registros"}</span><div><button class="btn reg-page-prev"${tableState.page <= 1 ? " disabled" : ""}>‹</button><span>Página ${tableState.page} de ${totalPages}</span><button class="btn reg-page-next"${tableState.page >= totalPages ? " disabled" : ""}>›</button></div>`;
  footer.querySelector(".reg-page-prev").addEventListener("click", () => { tableState.page -= 1; applyRegistrationTableState(table); });
  footer.querySelector(".reg-page-next").addEventListener("click", () => { tableState.page += 1; applyRegistrationTableState(table); });
}

function renderRegistrationFilterBadges(table) {
  const strip = document.querySelector("#registrations-root .registration-filter-strip");
  const badges = strip?.querySelector(".registration-filter-badges");
  const clearAll = strip?.querySelector(".registration-filter-clear-all");
  if (!strip || !badges || !clearAll) return;
  const tableState = registrationTableState();
  const orderedKeys = registrationColumnDefinitions(table).map((column) => column.k);
  const active = [
    ...orderedKeys.map((key) => [key, tableState.filters[key]]),
    ...Object.entries(tableState.filters).filter(([key]) => !orderedKeys.includes(key))
  ].filter(([, values]) => values?.size);
  const labels = new Map([...table.querySelectorAll("thead th[data-registration-key]")].map((header) => [header.dataset.registrationKey, header.dataset.registrationLabel]));
  badges.innerHTML = active.map(([key, values]) => `<button class="registration-filter-badge" data-key="${key}" title="Limpar filtro"><span>${esc(labels.get(key) || "Coluna")}: ${esc([...values].join(", "))}</span><b>×</b></button>`).join("");
  badges.querySelectorAll(".registration-filter-badge").forEach((badge) => badge.addEventListener("click", () => {
    delete tableState.filters[badge.dataset.key];
    tableState.page = 1;
    applyRegistrationTableState(table);
  }));
  clearAll.hidden = active.length < 2;
  clearAll.onclick = active.length < 2 ? null : () => {
    tableState.filters = {};
    tableState.page = 1;
    applyRegistrationTableState(table);
  };
}

function openRegistrationColumnFilter(header, table, key) {
  document.getElementById("registration-filter-dd")?.remove();
  const tableState = registrationTableState();
  const values = [...new Set(registrationTableRows(table).map((row) => registrationCell(row, key)?.textContent.trim() || "—"))]
    .sort((a, b) => a.localeCompare(b, "pt-BR", { numeric: true, sensitivity: "base" }));
  const selected = new Set(tableState.filters[key] || []);
  const rect = header.getBoundingClientRect();
  const panel = document.createElement("div");
  panel.id = "registration-filter-dd";
  panel.className = "filter-dd";
  panel.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 330))}px`;
  panel.style.top = `${Math.min(rect.bottom + 4, window.innerHeight - 360)}px`;
  panel.innerHTML = `<div class="dd-head"><span>Filtrar · ${esc(header.dataset.registrationLabel)}</span><span>${values.length}</span></div>
    <div class="dd-search"><input placeholder="Buscar..."></div><div class="dd-list"></div>
    <div class="dd-foot"><button class="btn reg-filter-all">Todos</button><button class="btn danger reg-filter-clear">Limpar</button><button class="btn primary reg-filter-apply">Aplicar</button></div>`;
  document.body.appendChild(panel);
  const list = panel.querySelector(".dd-list");
  const draw = () => {
    const query = panel.querySelector("input").value.trim().toLocaleLowerCase("pt-BR");
    list.innerHTML = values.filter((value) => !query || value.toLocaleLowerCase("pt-BR").includes(query)).map((value) => `<label class="dd-item${selected.has(value) ? " on" : ""}" data-value="${esc(value)}"><span class="dd-check">${selected.has(value) ? "✓" : ""}</span><span>${esc(value)}</span></label>`).join("");
    list.querySelectorAll(".dd-item").forEach((item) => item.addEventListener("click", () => {
      const value = item.dataset.value;
      if (selected.has(value)) selected.delete(value); else selected.add(value);
      draw();
    }));
  };
  draw();
  panel.querySelector("input").addEventListener("input", draw);
  panel.querySelector(".reg-filter-all").addEventListener("click", () => {
    if (selected.size === values.length) selected.clear();
    else values.forEach((value) => selected.add(value));
    draw();
  });
  panel.querySelector(".reg-filter-clear").addEventListener("click", () => { selected.clear(); delete tableState.filters[key]; tableState.page = 1; panel.remove(); applyRegistrationTableState(table); });
  panel.querySelector(".reg-filter-apply").addEventListener("click", () => {
    if (selected.size && selected.size < values.length) tableState.filters[key] = selected;
    else delete tableState.filters[key];
    tableState.page = 1;
    panel.remove();
    applyRegistrationTableState(table);
  });
  panel.querySelector("input").focus();
  setTimeout(() => {
    const outside = (event) => {
      if (!panel.contains(event.target) && !header.contains(event.target)) {
        panel.remove();
        document.removeEventListener("mousedown", outside);
      }
    };
    document.addEventListener("mousedown", outside);
  }, 50);
}

function registrationTemplateTable(singular, count, firstColumn, extraHeaders, rows, colspan) {
  return `<div class="modal-toolbar"><span class="muted">${count} ${singular}(s) cadastrada(s) nos produtos</span><button class="btn primary" id="registration-add">+ ${firstColumn}</button></div>
    <div class="product-activity-list"><table><thead><tr><th>${firstColumn}</th>${extraHeaders}<th>Ações</th></tr></thead><tbody>${rows || `<tr><td colspan="${colspan}" class="empty">Nenhum registro cadastrado.</td></tr>`}</tbody></table></div>`;
}

function openRegistrationTemplateEditor(section, productId, itemId = null) {
  if (!productId) return;
  productActivityState = { productId, editId: null, objectiveEditId: null, goalEditId: null, tab: section };
  if (section === "activities") {
    openProductActivityDrawer(itemId);
    return;
  }
  if (section === "objectives") {
    openProductObjectiveDrawer(itemId);
  } else if (section === "goals") {
    openProductGoalDrawer(itemId);
  }
}

function openRegistrationProductPicker(section) {
  const modal = document.querySelector("#ov .modal.full");
  if (!modal) return;
  const overlay = document.createElement("div");
  overlay.id = "registration-product-picker";
  overlay.className = "activity-form-overlay";
  const label = REGISTRATION_LABEL[section]?.replace(/s$/, "") || "Cadastro";
  overlay.innerHTML = `<aside class="activity-form-drawer"><h3>Selecionar produto<button class="modal-close-x" id="registration-picker-close" title="Fechar">✕</button></h3>
    <div class="form product-activity-form"><div class="field"><label>Produto</label><select id="registration-product">${cache.products.map((product) => `<option value="${esc(product.id)}">${esc(product.name)}</option>`).join("")}</select></div><div class="panel-list">O ${label.toLocaleLowerCase("pt-BR")} será vinculado ao produto escolhido.</div></div>
    <div class="modal-foot"><button class="btn" id="registration-picker-cancel">Cancelar</button><button class="btn primary" id="registration-picker-next">Continuar</button></div></aside>`;
  modal.appendChild(overlay);
  const close = () => overlay.remove();
  document.getElementById("registration-picker-close").addEventListener("click", close);
  document.getElementById("registration-picker-cancel").addEventListener("click", close);
  overlay.addEventListener("click", (event) => { if (event.target === overlay) close(); });
  document.getElementById("registration-picker-next").addEventListener("click", () => {
    const productId = document.getElementById("registration-product").value;
    if (!productId) { toast("Cadastre um produto primeiro.", true); return; }
    close();
    openRegistrationTemplateEditor(section, productId);
  });
}

// ---------- Integrações ----------
const INTEGRATION_GROUPS = [
  { group: "META", items: [
    { name: "WhatsApp", active: IS_EXTENSION_CONTEXT },
    { name: "Facebook", active: false },
    { name: "Instagram", active: false },
    { name: "Meta Ads", active: false }
  ] },
  { group: "REDDIT", items: [{ name: "Reddit", active: IS_EXTENSION_CONTEXT }] },
  { group: "LINKEDIN", items: [{ name: "LinkedIn", active: false }] },
  { group: "TELEGRAM", items: [{ name: "Telegram", active: false }] }
];

let googleContactsState = { people: [], account: null };

function googleOAuthClientId() {
  return globalThis.chrome?.runtime?.getManifest?.().oauth2?.client_id || "";
}

function googleOAuthConfigured() {
  const clientId = googleOAuthClientId();
  return clientId.endsWith(".apps.googleusercontent.com") && !clientId.startsWith("YOUR_");
}

function storedGoogleAccount() {
  try { return JSON.parse(localStorage.getItem("crm_google_account") || "null"); }
  catch (e) { return null; }
}

function getGoogleAuthToken(interactive = true) {
  return new Promise((resolve, reject) => {
    const chromeApi = globalThis.chrome;
    if (!chromeApi?.identity?.getAuthToken) { reject(new Error("A API de identidade do Chrome não está disponível.")); return; }
    chromeApi.identity.getAuthToken({ interactive }, (result) => {
      const error = chromeApi.runtime.lastError;
      if (error) { reject(new Error(error.message)); return; }
      const token = typeof result === "string" ? result : result?.token;
      if (!token) { reject(new Error("O Google não retornou um token de acesso.")); return; }
      resolve(token);
    });
  });
}

async function googleApiJson(url, token) {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Google API ${response.status}${detail ? ` · ${detail.slice(0, 140)}` : ""}`);
  }
  return response.json();
}

async function fetchGooglePeople(token) {
  const people = [];
  let pageToken = "";
  do {
    const params = new URLSearchParams({
      personFields: "names,emailAddresses,phoneNumbers,organizations,birthdays,urls,userDefined,metadata",
      pageSize: "1000",
      sortOrder: "FIRST_NAME_ASCENDING"
    });
    if (pageToken) params.set("pageToken", pageToken);
    const data = await googleApiJson(`https://people.googleapis.com/v1/people/me/connections?${params}`, token);
    people.push(...(data.connections || []).filter((person) => {
      if (person.metadata?.deleted) return false;
      return ["names", "emailAddresses", "phoneNumbers", "organizations", "urls", "userDefined"]
        .some((field) => Array.isArray(person[field]) && person[field].length);
    }));
    pageToken = data.nextPageToken || "";
  } while (pageToken);
  return people;
}

function googlePersonPrimary(person, field) {
  const values = person?.[field] || [];
  return values.find((item) => item.metadata?.primary) || values[0] || null;
}

function normalizeCompanyName(value) {
  return String(value || "").trim().toLocaleLowerCase("pt-BR").replace(/\s+/g, " ");
}

function normalizeTaxId(value) {
  return String(value || "").replace(/\D/g, "");
}

function formatImportedCnpj(value) {
  const digits = normalizeTaxId(value);
  if (digits.length !== 14) return digits;
  return digits.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
}

function looksLikeLegalCompanyName(value) {
  const text = String(value || "").trim();
  return /\bLTDA\b/i.test(text) || /^\d{2}\.?\d{3}\.?\d{3}\b/.test(text);
}

function deduplicateCompanyNames(tradeName, legalName) {
  const trade = String(tradeName || "").trim();
  const legal = String(legalName || "").trim();
  if (trade && legal && normalizeCompanyName(trade) !== normalizeCompanyName(legal)) {
    return { trade_name: trade, legal_name: legal };
  }
  const duplicated = legal || trade;
  return looksLikeLegalCompanyName(duplicated)
    ? { trade_name: "", legal_name: duplicated }
    : { trade_name: duplicated, legal_name: "" };
}

function parseGoogleCompany(person) {
  const organization = googlePersonPrimary(person, "organizations") || {};
  const customValues = (person.userDefined || []).map((item) => item.value).filter(Boolean);
  const displayName = googlePersonPrimary(person, "names")?.displayName || "";
  const candidates = [organization.name, ...customValues, displayName].map((value) => String(value || "").trim()).filter(Boolean);
  const descriptor = candidates.find((value) => value.includes("|") && value.split("|").some((part) => normalizeTaxId(part).length >= 12))
    || candidates.find((value) => value.includes("|"))
    || organization.name || "";
  const parts = String(descriptor).split("|").map((part) => part.trim()).filter(Boolean);
  const taxPart = [...parts].reverse().find((part) => {
    const length = normalizeTaxId(part).length;
    return length >= 12 && length <= 14;
  });
  const taxId = taxPart ? formatImportedCnpj(taxPart) : "";
  const names = parts.filter((part) => part !== taxPart);
  if (names.length >= 2) {
    return { ...deduplicateCompanyNames(names[0], names[1]), tax_id: taxId, raw: descriptor };
  }
  const companyName = names[0] || String(organization.name || "").trim();
  return { ...deduplicateCompanyNames(companyName, companyName), tax_id: taxId, raw: descriptor };
}

function findImportedCompany(companyData) {
  if (!companyData) return null;
  const taxDigits = normalizeTaxId(companyData.tax_id);
  return (cache.companies || []).find((item) => taxDigits && normalizeTaxId(item.tax_id) === taxDigits)
    || (cache.companies || []).find((item) => {
      const names = [item.trade_name, item.legal_name].map(normalizeCompanyName);
      return [companyData.trade_name, companyData.legal_name].map(normalizeCompanyName).filter(Boolean).some((name) => names.includes(name));
    }) || null;
}

function googlePersonToContact(person) {
  const emails = (person.emailAddresses || []).map((item) => item.value).filter(Boolean);
  const phones = (person.phoneNumbers || []).map((item) => item.value).filter(Boolean);
  const organization = googlePersonPrimary(person, "organizations") || {};
  const googleCompany = parseGoogleCompany(person);
  const emailName = emails[0]?.split("@")[0]?.replace(/[._-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()) || "";
  const name = googlePersonPrimary(person, "names")?.displayName || emailName || googleCompany.trade_name || "Contato Google";
  const birthday = googlePersonPrimary(person, "birthdays")?.date;
  const birthDate = birthday?.year && birthday?.month && birthday?.day
    ? `${birthday.year}-${String(birthday.month).padStart(2, "0")}-${String(birthday.day).padStart(2, "0")}` : "";
  const urls = person.urls || [];
  const social = (domain) => urls.find((item) => String(item.value || "").toLowerCase().includes(domain))?.value || "";
  const company = findImportedCompany(googleCompany);
  return {
    name,
    phone: normalizePhoneList(phones.join("; ")),
    email: normalizeEmailList(emails.join("; ")),
    contact_type: "Contato Google",
    channel: "Google",
    job_title: organization.title || "",
    company_id: company?.tax_id || null,
    linkedin: social("linkedin.com"),
    facebook: social("facebook.com"),
    instagram: social("instagram.com"),
    reddit: social("reddit.com"),
    youtube: social("youtube.com"),
    birth_date: birthDate || null,
    google_resource_name: person.resourceName,
    google_etag: person.etag || null,
    google_synced_at: new Date().toISOString(),
    google_company: googleCompany
  };
}

function googleContactDatabaseBody(mapped) {
  const { google_company: _googleCompany, ...body } = mapped;
  return body;
}

async function ensureGoogleCompany(companyData) {
  if (!companyData) return null;
  const existing = findImportedCompany(companyData);
  if (existing) return existing;
  if (!companyData.tax_id || (!companyData.legal_name && !companyData.trade_name)) return null;
  const body = {
    tax_id: companyData.tax_id,
    legal_name: companyData.legal_name || null,
    trade_name: companyData.trade_name || null,
    registration_status: "Importada do Google",
    notes: `Importada do Google Contatos: ${companyData.raw || companyData.legal_name}`
  };
  const saved = await createRow("companies", body);
  cache.companies.push(saved);
  cache.companyById[saved.tax_id] = saved;
  return saved;
}

function existingContactForGoogle(person) {
  const email = googlePersonPrimary(person, "emailAddresses")?.value?.toLowerCase();
  return (cache.contacts || []).find((item) => item.google_resource_name === person.resourceName)
    || (email ? (cache.contacts || []).find((item) => String(item.email || "").toLowerCase().split(/[;,]/).map((v) => v.trim()).includes(email)) : null);
}

function integrationsHtml() {
  const googleAccount = storedGoogleAccount();
  const groups = INTEGRATION_GROUPS.map((g) => `<div class="integrations-group">
      <h4>${esc(g.group)}</h4>
      ${g.items.map((it) => `<div class="integration-row">
          <span>${esc(it.name)}</span>
          <span class="integration-status ${it.active ? "active" : "soon"}">${it.active ? "Ativo" : "Em breve"}</span>
        </div>`).join("")}
    </div>`).join("");
  const googleStatus = IS_EXTENSION_CONTEXT
    ? (!googleOAuthConfigured() ? "Configuração pendente" : googleAccount ? googleAccount.email || "Conectado" : "Desconectado")
    : "Disponível na extensão Chrome";
  return `${groups}<div class="integrations-group"><h4>Google</h4>
    <div class="integration-row google-integration-row">
      <div><strong>Google Contatos</strong><div class="muted">${esc(googleStatus)}</div></div>
      <div class="integration-actions">
        ${googleAccount ? '<button class="btn" id="google-disconnect">Desconectar</button>' : ""}
        <button class="btn primary" id="google-connect"${IS_EXTENSION_CONTEXT ? "" : " disabled"}>${IS_EXTENSION_CONTEXT ? (googleAccount ? "Importar contatos" : googleOAuthConfigured() ? "Conectar" : "Configurar") : "Usar extensão"}</button>
      </div>
    </div>
  </div><div class="panel-list">${IS_EXTENSION_CONTEXT
    ? "WhatsApp e Reddit capturam conversas. O Google Contatos importa somente os contatos selecionados para Pessoas."
    : "A versão web mantém o CRM, login, cadastros, negócios, entregas, tarefas e importação manual de conversas. Captura automática e Google Contatos ficam na extensão Chrome."}</div>`;
}

function wireIntegrations() {
  document.getElementById("google-connect")?.addEventListener("click", openGoogleContactsImport);
  document.getElementById("google-disconnect")?.addEventListener("click", disconnectGoogleAccount);
}

function showGoogleOAuthSetup() {
  const extensionId = globalThis.chrome?.runtime?.id || "Disponível após carregar a extensão no Chrome";
  sidePanel("Configurar Google", `<div class="google-setup">
    <div class="field"><label>ID desta extensão</label><input value="${esc(extensionId)}" readonly></div>
    <ol><li>Ative a People API no Google Cloud.</li><li>Crie um cliente OAuth do tipo Extensão do Chrome usando o ID acima.</li><li>Informe o Client ID para substituir o valor pendente no manifest.json.</li></ol>
    <div class="panel-list">Depois, recarregue a extensão em chrome://extensions e clique em Conectar.</div>
  </div>`, { closeOnOverlay: true });
}

async function openGoogleContactsImport() {
  if (!googleOAuthConfigured()) { showGoogleOAuthSetup(); return; }
  try {
    const button = document.getElementById("google-connect");
    if (button) { button.disabled = true; button.textContent = "Conectando..."; }
    const token = await getGoogleAuthToken(true);
    const [account, people] = await Promise.all([
      googleApiJson("https://www.googleapis.com/oauth2/v2/userinfo", token),
      fetchGooglePeople(token)
    ]);
    googleContactsState = { people, account };
    localStorage.setItem("crm_google_account", JSON.stringify({ email: account.email, name: account.name || "", picture: account.picture || "" }));
    renderGoogleContactsPreview();
  } catch (err) {
    toast("Não foi possível conectar ao Google · " + err.message, true);
    sidePanel("Integrações", integrationsHtml(), { closeOnOverlay: true });
    wireIntegrations();
  }
}

function renderGoogleContactsPreview() {
  const people = googleContactsState.people || [];
  const rows = people.map((person, index) => {
    const mapped = googlePersonToContact(person);
    const existing = existingContactForGoogle(person);
    const company = mapped.google_company || {};
    return `<tr><td class="select-cell"><input class="google-contact-check" type="checkbox" data-index="${index}" checked></td>
      <td>${esc(mapped.name)}</td><td>${esc(mapped.email || "—")}</td><td>${esc(mapped.phone || "—")}</td><td>${esc(mapped.job_title || "—")}</td>
      <td>${esc(company.trade_name || "—")}</td><td>${esc(company.legal_name || "—")}</td><td>${esc(company.tax_id || "—")}</td>
      <td>${existing ? '<span class="badge b-lead">Atualizar</span>' : '<span class="badge b-open">Novo</span>'}</td></tr>`;
  }).join("");
  shell("Importar contatos do Google", `<div class="google-import-head">
      <div><strong>${esc(googleContactsState.account?.email || "Conta Google")}</strong><div class="muted">${people.length} contato(s) encontrado(s)</div></div>
      <label class="google-select-all"><input type="checkbox" id="google-select-all" checked> Selecionar todos</label>
    </div>
    <div class="google-import-fields"><strong>Dados importados</strong><span>Nome, e-mails, telefones, cargo, empresa, razão social, CNPJ, nascimento e redes sociais disponíveis no contato Google.</span></div>
    <div class="google-contact-list"><table><thead><tr><th></th><th>Nome</th><th>E-mail(s)</th><th>Telefone(s)</th><th>Cargo</th><th>Nome fantasia</th><th>Razão social</th><th>CNPJ</th><th>Situação</th></tr></thead><tbody>${rows || '<tr><td colspan="9" class="empty">Nenhum contato encontrado.</td></tr>'}</tbody></table></div>
    <div class="modal-foot"><button class="btn" id="google-import-cancel">Cancelar</button><button class="btn primary" id="google-import-confirm"${people.length ? "" : " disabled"}>Importar selecionados</button></div>`, { cls: "full" });
  document.getElementById("google-select-all")?.addEventListener("change", (event) => {
    document.querySelectorAll(".google-contact-check").forEach((input) => { input.checked = event.target.checked; });
  });
  document.getElementById("google-import-cancel")?.addEventListener("click", closeModal);
  document.getElementById("google-import-confirm")?.addEventListener("click", importSelectedGoogleContacts);
}

async function importSelectedGoogleContacts() {
  const indexes = [...document.querySelectorAll(".google-contact-check:checked")].map((input) => Number(input.dataset.index));
  if (!indexes.length) { toast("Selecione ao menos um contato.", true); return; }
  const button = document.getElementById("google-import-confirm");
  button.disabled = true;
  let created = 0;
  let updated = 0;
  let companiesCreated = 0;
  try {
    for (const index of indexes) {
      const person = googleContactsState.people[index];
      const mapped = googlePersonToContact(person);
      const existing = existingContactForGoogle(person);
      const companyBefore = findImportedCompany(mapped.google_company);
      const company = await ensureGoogleCompany(mapped.google_company);
      if (!companyBefore && company) companiesCreated++;
      const contactBody = googleContactDatabaseBody(mapped);
      if (company) contactBody.company_id = company.tax_id;
      if (existing) {
        const patch = {
          google_resource_name: contactBody.google_resource_name,
          google_etag: contactBody.google_etag,
          google_synced_at: contactBody.google_synced_at
        };
        ["name", "phone", "email", "job_title", "company_id", "linkedin", "facebook", "instagram", "reddit", "youtube", "birth_date"].forEach((key) => {
          if (contactBody[key]) patch[key] = contactBody[key];
        });
        const saved = await updateRow("contacts", existing.id, patch);
        Object.assign(existing, saved || patch);
        updated++;
      } else {
        const saved = await createRow("contacts", contactBody);
        cache.contacts.push(saved);
        created++;
      }
      button.textContent = `Importando ${created + updated}/${indexes.length}`;
    }
    await init();
    state.tab = "contacts";
    state.view = "table";
    closeModal();
    render();
    toast(`${created} contato(s) criado(s), ${updated} atualizado(s) e ${companiesCreated} empresa(s) criada(s).`);
  } catch (err) {
    button.disabled = false;
    button.textContent = "Importar selecionados";
    toast("Erro ao importar contatos · " + err.message, true);
  }
}

async function disconnectGoogleAccount() {
  try {
    const token = await getGoogleAuthToken(false);
    await new Promise((resolve) => globalThis.chrome.identity.removeCachedAuthToken({ token }, resolve));
  } catch (e) {}
  localStorage.removeItem("crm_google_account");
  sidePanel("Integrações", integrationsHtml(), { closeOnOverlay: true });
  wireIntegrations();
  toast("Conta Google desconectada desta extensão.");
}

function currentUserIsAdmin() {
  return !isLive() || currentProfile?.role === "admin";
}

function currentSessionLabel() {
  const session = readAuthSession();
  return currentProfile?.full_name || currentProfile?.email || session?.user?.email || "conta não identificada";
}

function requireCurrentUserAdmin(area = "Esta área") {
  if (currentUserIsAdmin()) return true;
  toast(`${area} disponível apenas para administradores. Sessão atual: ${currentSessionLabel()}.`, true);
  return false;
}

const TOOL_FOLDERS_KEY = "crm_tool_folders";
const TOOL_EMAILS_KEY = "crm_tool_emails";
const TOOL_COLUMN_DEFS = {
  files: [{ k: "name", h: "Nome" }, { k: "description", h: "Descrição" }, { k: "url", h: "Link" }],
  emails: [{ k: "cnpj", h: "CNPJ" }, { k: "client", h: "Cliente" }, { k: "email", h: "Email" }, { k: "password", h: "Senha" }, { k: "tags", h: "Tags" }],
  processes: [
    { k: "title", h: "Processo" }, { k: "area", h: "Área" }, { k: "system_name", h: "Sistema" },
    { k: "audience", h: "Público" }, { k: "difficulty", h: "Nível" }, { k: "status", h: "Status" },
    { k: "steps", h: "Etapas" }, { k: "version", h: "Versão" }, { k: "updated_at", h: "Atualizado em" }
  ]
};
let toolsState = { section: "files", search: "", tables: {} };
let remoteToolEmails = [];
let remoteToolEmailsLoaded = false;
let remoteToolEmailsLoading = false;
let remoteToolEmailsError = "";
let remoteToolProcesses = [];
let remoteToolProcessesLoaded = false;
let remoteToolProcessesLoading = false;
let remoteToolProcessesError = "";

function readToolRows(key) {
  try {
    const rows = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(rows) ? rows : [];
  } catch (e) {
    return [];
  }
}

function saveToolRows(key, rows) {
  localStorage.setItem(key, JSON.stringify(rows));
}

function toolsDisabledFooter() {
  return `<div class="registrations-footer" aria-disabled="true">
    ${currentUserIsAdmin() ? '<button class="foot-btn" disabled>LOG</button>' : ""}
    <button class="foot-btn" disabled>AJUDA</button>
    <button class="foot-btn" disabled>CADASTROS</button>
    <button class="foot-btn" disabled>FERRAMENTAS</button>
    <button class="foot-btn" disabled>ATUALIZAÇÕES</button>
  </div>`;
}

function openToolsModal(section = "files") {
  if (toolsState.section !== section) toolsState.search = "";
  toolsState.section = section;
  const headerCenter = `<div class="modal-header-tabs" role="tablist" aria-label="Ferramentas">
    <button class="modal-header-tab${section === "files" ? " active" : ""}" data-tools-tab="files" role="tab">Arquivos</button>
    <button class="modal-header-tab${section === "emails" ? " active" : ""}" data-tools-tab="emails" role="tab">Emails</button>
    <button class="modal-header-tab${section === "processes" ? " active" : ""}" data-tools-tab="processes" role="tab">Processos</button>
  </div>`;
  shell("Ferramentas", `<div id="tools-root" class="tools-root"></div>${toolsDisabledFooter()}`, {
    cls: "full registrations-modal",
    headerCenter,
    titleHtml: '<span class="registration-brand">ENTERPRISER <b>• CRM</b><em>Ferramentas</em></span>'
  });
  document.querySelectorAll("[data-tools-tab]").forEach((button) => button.addEventListener("click", () => {
    toolsState.section = button.dataset.toolsTab;
    toolsState.search = "";
    document.querySelectorAll("[data-tools-tab]").forEach((tab) => tab.classList.toggle("active", tab === button));
    renderToolsSection();
  }));
  renderToolsSection();
}

function visibleToolColumns(section = toolsState.section) {
  const prefs = secondaryColumnPrefs(`tools:${section}`);
  return orderedColumnDefinitions(TOOL_COLUMN_DEFS[section], prefs).filter((col) => prefs[col.k] !== false);
}

function toolTableState(section = toolsState.section) {
  if (!toolsState.tables[section]) toolsState.tables[section] = { sortKey: null, sortDir: 1, filters: {} };
  return toolsState.tables[section];
}

function toolEmailValue(account, key) {
  if (key === "password") return account.password ? "Disponível" : "Não disponível";
  if (key === "tags") return (account.tags || []).join(", ");
  return String(account[key] || "—");
}

function toolsToolbarHtml(count, addTitle, addId, canAdd = true) {
  return `<div class="tools-toolbar">
    <div class="registration-toolbar-left"><span class="muted">${count} item(ns)</span></div>
    <div class="registration-toolbar-center"><input class="search registration-toolbar-search tools-search" placeholder="Buscar..." value="${esc(toolsState.search || "")}">${canAdd ? `<button class="btn primary plus" id="${addId}" title="${esc(addTitle)}">+</button>` : ""}</div>
    <div class="registration-toolbar-right"><button class="btn tools-cols-btn" type="button" title="Selecionar colunas">⊞</button><button class="view active" type="button">Tabela</button><button class="view" type="button" disabled>Matriz</button><button class="view" type="button" disabled>Dashboard</button></div>
  </div>`;
}

function wireToolsToolbar(root) {
  const input = root.querySelector(".tools-search");
  input?.addEventListener("input", (event) => {
    toolsState.search = event.target.value;
    renderToolsSection();
    const next = document.querySelector("#tools-root .tools-search");
    next?.focus();
    next?.setSelectionRange(next.value.length, next.value.length);
  });
  root.querySelector(".tools-cols-btn")?.addEventListener("click", (event) => {
    event.stopPropagation();
    openSecondaryColumnManager({
      scope: `tools:${toolsState.section}`,
      label: toolsState.section === "files" ? "Arquivos" : toolsState.section === "emails" ? "Emails" : "Processos",
      definitions: TOOL_COLUMN_DEFS[toolsState.section],
      onChange: renderToolsSection
    });
  });
}

function renderToolsSection() {
  const root = document.getElementById("tools-root");
  if (!root) return;
  if (toolsState.section === "emails") renderToolEmails(root);
  else if (toolsState.section === "processes") renderToolProcesses(root);
  else renderToolFolders(root);
}

function renderToolFolders(root) {
  const allFolders = readToolRows(TOOL_FOLDERS_KEY);
  const query = toolsState.search.trim().toLocaleLowerCase("pt-BR");
  const folders = allFolders.filter((folder) => !query || [folder.name, folder.description, folder.url].some((value) => String(value || "").toLocaleLowerCase("pt-BR").includes(query)));
  const visible = new Set(visibleToolColumns("files").map((col) => col.k));
  const cards = folders.length ? folders.map((folder) => `<article class="tool-folder">
    <div class="tool-folder-icon" aria-hidden="true">📁</div>
    <div class="tool-folder-main">
      ${visible.has("name") ? `<div class="tool-folder-name">${esc(folder.name)}</div>` : ""}
      ${visible.has("description") ? `<div class="tool-folder-description">${esc(folder.description || "Sem descrição")}</div>` : ""}
      ${visible.has("url") ? `<div class="tool-folder-description">${esc(folder.url || "Sem link")}</div>` : ""}
    </div>
    <div class="tool-folder-actions">
      ${folder.url ? `<button class="tool-icon-btn tool-folder-open" data-id="${esc(folder.id)}" title="Abrir pasta">↗</button>` : ""}
      <button class="tool-icon-btn tool-folder-edit" data-id="${esc(folder.id)}" title="Editar pasta">✎</button>
      <button class="tool-icon-btn tool-folder-delete" data-id="${esc(folder.id)}" title="Excluir pasta">×</button>
    </div>
  </article>`).join("") : '<div class="tool-empty">Nenhuma pasta cadastrada.</div>';
  root.innerHTML = `${toolsToolbarHtml(folders.length, "Adicionar pasta", "tool-folder-add")}<div class="tool-folder-grid">${cards}</div>`;
  wireToolsToolbar(root);
  document.getElementById("tool-folder-add").addEventListener("click", () => openToolFolderForm());
  root.querySelectorAll(".tool-folder-open").forEach((button) => button.addEventListener("click", () => openToolFolder(button.dataset.id)));
  root.querySelectorAll(".tool-folder-edit").forEach((button) => button.addEventListener("click", () => openToolFolderForm(button.dataset.id)));
  root.querySelectorAll(".tool-folder-delete").forEach((button) => button.addEventListener("click", () => deleteToolFolder(button.dataset.id)));
}

function openToolFolder(id) {
  const folder = readToolRows(TOOL_FOLDERS_KEY).find((item) => item.id === id);
  if (!folder?.url) return;
  try {
    const url = new URL(folder.url);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("invalid");
    window.open(url.href, "_blank", "noopener,noreferrer");
  } catch (e) {
    toast("Link da pasta inválido.", true);
  }
}

function openToolFolderForm(id = null) {
  const current = readToolRows(TOOL_FOLDERS_KEY).find((item) => item.id === id) || {};
  sidePanel(id ? "Editar pasta" : "Nova pasta", `<div class="form">
    <div class="field full"><label>Nome da pasta</label><input id="tool-folder-name" value="${esc(current.name || "")}" autofocus></div>
    <div class="field full"><label>Link da pasta</label><input id="tool-folder-url" type="url" value="${esc(current.url || "")}" placeholder="https://drive.google.com/..."></div>
    <div class="field full"><label>Descrição</label><textarea id="tool-folder-description" rows="4">${esc(current.description || "")}</textarea></div>
  </div><div class="modal-foot"><button class="btn" id="tool-folder-cancel">Cancelar</button><button class="btn primary" id="tool-folder-save">Salvar</button></div>`, {
    closeOnOverlay: true,
    onClose: () => openToolsModal("files")
  });
  document.getElementById("tool-folder-cancel").addEventListener("click", () => openToolsModal("files"));
  document.getElementById("tool-folder-save").addEventListener("click", () => {
    const name = document.getElementById("tool-folder-name").value.trim();
    if (!name) { toast("Informe o nome da pasta.", true); return; }
    const rows = readToolRows(TOOL_FOLDERS_KEY);
    const item = {
      id: current.id || crypto.randomUUID(),
      name,
      url: document.getElementById("tool-folder-url").value.trim(),
      description: document.getElementById("tool-folder-description").value.trim(),
      updated_at: new Date().toISOString()
    };
    const index = rows.findIndex((row) => row.id === item.id);
    if (index >= 0) rows[index] = item;
    else rows.unshift(item);
    saveToolRows(TOOL_FOLDERS_KEY, rows);
    toast("Pasta salva.");
    openToolsModal("files");
  });
}

function deleteToolFolder(id) {
  const rows = readToolRows(TOOL_FOLDERS_KEY);
  const folder = rows.find((item) => item.id === id);
  if (!folder || !window.confirm(`Excluir a pasta "${folder.name}"?`)) return;
  saveToolRows(TOOL_FOLDERS_KEY, rows.filter((item) => item.id !== id));
  renderToolsSection();
  toast("Pasta excluída.");
}

const PROCESS_DIFFICULTY_LABEL = { basic: "Básico", intermediate: "Intermediário", advanced: "Avançado" };
const PROCESS_STATUS_LABEL = { draft: "Rascunho", active: "Ativo", archived: "Arquivado" };

function normalizeProcessSteps(value) {
  let steps = value;
  if (typeof steps === "string") {
    try { steps = JSON.parse(steps); } catch (e) { steps = []; }
  }
  return Array.isArray(steps) ? steps.map((step, index) => ({
    id: String(step?.id || crypto.randomUUID()),
    title: String(step?.title || `Etapa ${index + 1}`).trim(),
    instruction: String(step?.instruction || "").trim()
  })) : [];
}

function toolProcessRows() {
  return isLive() ? remoteToolProcesses : (DEMO.processes || []);
}

function toolProcessValue(process, key) {
  if (key === "difficulty") return PROCESS_DIFFICULTY_LABEL[process.difficulty] || process.difficulty || "—";
  if (key === "status") return PROCESS_STATUS_LABEL[process.status] || process.status || "—";
  if (key === "steps") return String(normalizeProcessSteps(process.steps).length);
  if (key === "tags") return normalizeTextList(process.tags).join(", ");
  if (key === "updated_at") return process.updated_at ? new Date(process.updated_at).toLocaleDateString("pt-BR") : "—";
  return String(process[key] || "—");
}

async function loadRemoteToolProcesses() {
  if (!isLive() || remoteToolProcessesLoading) return;
  remoteToolProcessesLoading = true;
  remoteToolProcessesError = "";
  try {
    remoteToolProcesses = await fetchTable("processes");
    remoteToolProcessesLoaded = true;
  } catch (err) {
    remoteToolProcessesError = err.message;
  } finally {
    remoteToolProcessesLoading = false;
    const root = document.getElementById("tools-root");
    if (root && toolsState.section === "processes") renderToolProcesses(root);
  }
}

function processFilterStrip(tableState) {
  const activeFilters = Object.entries(tableState.filters).filter(([, values]) => values?.size);
  return `<div class="registration-filter-strip"><div class="registration-filter-badges">${activeFilters.map(([key, values]) => {
    const label = TOOL_COLUMN_DEFS.processes.find((col) => col.k === key)?.h || key;
    return `<button class="registration-filter-badge tool-filter-badge" data-key="${esc(key)}" title="Limpar filtro"><span>${esc(label)}: ${esc([...values].join(", "))}</span><b>×</b></button>`;
  }).join("")}</div><button class="filter-clear-all tool-filter-clear-all" type="button"${activeFilters.length < 2 ? " hidden" : ""}><span aria-hidden="true">×</span> Limpar tudo</button></div>`;
}

function renderToolProcesses(root) {
  if (isLive() && !remoteToolProcessesLoaded && !remoteToolProcessesLoading && !remoteToolProcessesError) loadRemoteToolProcesses();
  const allProcesses = toolProcessRows();
  const query = toolsState.search.trim().toLocaleLowerCase("pt-BR");
  const tableState = toolTableState("processes");
  const processes = allProcesses.filter((process) => {
    const searchable = [process.title, process.area, process.system_name, process.objective, process.audience,
      process.responsible_job_title, process.reference_url, ...normalizeTextList(process.tags)];
    const matchesSearch = !query || searchable.some((value) => String(value || "").toLocaleLowerCase("pt-BR").includes(query));
    return matchesSearch && Object.entries(tableState.filters).every(([key, selected]) =>
      !selected?.size || selected.has(toolProcessValue(process, key))
    );
  });
  if (tableState.sortKey) {
    processes.sort((a, b) => toolProcessValue(a, tableState.sortKey).localeCompare(
      toolProcessValue(b, tableState.sortKey), "pt-BR", { numeric: true, sensitivity: "base" }
    ) * tableState.sortDir);
  }
  const columns = visibleToolColumns("processes");
  const rows = processes.length ? processes.map((process) => `<tr data-id="${esc(process.id)}">
    ${columns.map((col) => {
      if (col.k === "title") return `<td><button class="process-open-link" data-id="${esc(process.id)}">${esc(process.title || "—")}</button><div class="muted process-row-objective">${esc(process.objective || "Sem objetivo informado")}</div></td>`;
      if (col.k === "difficulty") return `<td>${badge(process.difficulty === "advanced" ? "proposal" : process.difficulty === "intermediate" ? "qualification" : "lead", toolProcessValue(process, col.k))}</td>`;
      if (col.k === "status") return `<td>${badge(process.status === "active" ? "won" : process.status === "archived" ? "lost" : "lead", toolProcessValue(process, col.k))}</td>`;
      if (col.k === "steps") return `<td>${normalizeProcessSteps(process.steps).length} etapa(s)</td>`;
      if (col.k === "version") return `<td>v${esc(process.version || 1)}</td>`;
      return `<td>${esc(toolProcessValue(process, col.k))}</td>`;
    }).join("")}
    <td><span class="tool-row-actions"><button class="tool-icon-btn tool-process-flow" data-id="${esc(process.id)}" title="Ver fluxo visual">⇢</button><button class="tool-icon-btn tool-process-open" data-id="${esc(process.id)}" title="Abrir processo">◉</button>${currentUserIsAdmin() ? `<button class="tool-icon-btn tool-process-edit" data-id="${esc(process.id)}" title="Editar processo">✎</button><button class="tool-icon-btn tool-process-delete" data-id="${esc(process.id)}" title="Excluir processo">×</button>` : ""}</span></td>
  </tr>`).join("") : `<tr><td colspan="${columns.length + 1}" class="tool-empty">Nenhum processo cadastrado.</td></tr>`;
  const feedback = remoteToolProcessesLoading ? '<div class="tool-empty">Carregando processos...</div>'
    : remoteToolProcessesError ? `<div class="tool-empty">Não foi possível carregar os processos: ${esc(remoteToolProcessesError)}</div>` : "";
  root.innerHTML = `${toolsToolbarHtml(processes.length, "Adicionar processo", "tool-process-add", currentUserIsAdmin())}${processFilterStrip(tableState)}${feedback}<div class="table-wrap tools-table-wrap"><table><thead><tr>${columns.map((col) => `<th data-tool-key="${esc(col.k)}" title="Clique para ordenar. Ctrl+clique para filtrar.">${esc(col.h)}${tableState.sortKey === col.k ? ` <span class="arrow">${tableState.sortDir > 0 ? "▲" : "▼"}</span>` : ""}</th>`).join("")}<th>Ações</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  wireToolsToolbar(root);
  wireSecondaryTableSelection(root.querySelector("table"), "tools:processes");
  document.getElementById("tool-process-add")?.addEventListener("click", () => openToolProcessForm());
  root.querySelectorAll(".tool-process-flow").forEach((button) => button.addEventListener("click", () => openToolProcessFlow(button.dataset.id)));
  root.querySelectorAll(".process-open-link,.tool-process-open").forEach((button) => button.addEventListener("click", () => openToolProcess(button.dataset.id)));
  root.querySelectorAll(".tool-process-edit").forEach((button) => button.addEventListener("click", () => openToolProcessForm(button.dataset.id)));
  root.querySelectorAll(".tool-process-delete").forEach((button) => button.addEventListener("click", () => deleteToolProcess(button.dataset.id)));
  root.querySelectorAll("th[data-tool-key]").forEach((header) => header.addEventListener("click", (event) => {
    const key = header.dataset.toolKey;
    if (event.ctrlKey || event.metaKey) { openToolColumnFilter(header, key, allProcesses, toolProcessValue, "processes"); return; }
    if (tableState.sortKey === key) tableState.sortDir *= -1;
    else { tableState.sortKey = key; tableState.sortDir = 1; }
    renderToolsSection();
  }));
  root.querySelectorAll(".tool-filter-badge").forEach((filter) => filter.addEventListener("click", () => {
    delete tableState.filters[filter.dataset.key]; renderToolsSection();
  }));
  root.querySelector(".tool-filter-clear-all")?.addEventListener("click", () => { tableState.filters = {}; renderToolsSection(); });
}

function closeToolProcessPanel(closePanel) {
  closePanel?.();
  if (document.getElementById("tools-root")) renderToolsSection();
  else openToolsModal("processes");
}

function openToolProcess(id) {
  const process = toolProcessRows().find((item) => item.id === id);
  if (!process) return;
  const steps = normalizeProcessSteps(process.steps);
  const reference = safeHttpUrl(process.reference_url);
  const content = `<div class="process-detail">
    <div class="process-detail-meta"><span>${esc(process.area || "Sem área")}</span><span>${esc(process.system_name || "Sem sistema")}</span><span>${esc(PROCESS_DIFFICULTY_LABEL[process.difficulty] || process.difficulty)}</span><span>v${esc(process.version || 1)}</span>${process.estimated_minutes ? `<span>${esc(process.estimated_minutes)} min</span>` : ""}</div>
    <section><h4>Objetivo</h4><p>${esc(process.objective || "Não informado.")}</p></section>
    <section><h4>Público e responsabilidade</h4><p>${esc(process.audience || "Todos")} · ${esc(process.responsible_job_title || "Cargo não definido")}</p></section>
    ${reference ? `<a class="btn process-reference" href="${esc(reference)}" target="_blank" rel="noopener">Abrir material de apoio ↗</a>` : ""}
    <section><h4>Passo a passo</h4><ol class="process-steps-view">${steps.map((step) => `<li><strong>${esc(step.title)}</strong>${step.instruction ? `<p>${esc(step.instruction)}</p>` : ""}</li>`).join("") || "<li>Nenhuma etapa cadastrada.</li>"}</ol></section>
    ${normalizeTextList(process.tags).length ? `<section><h4>Tags</h4><div class="tool-tags">${normalizeTextList(process.tags).map((tag) => `<span class="tool-tag">${esc(tag)}</span>`).join("")}</div></section>` : ""}
  </div><div class="modal-foot"><button class="btn" id="tool-process-close">Fechar</button><button class="btn" id="tool-process-detail-flow">⇢ Fluxo visual</button>${currentUserIsAdmin() ? '<button class="btn primary" id="tool-process-detail-edit">Editar</button>' : ""}</div>`;
  const closePanel = document.getElementById("tools-root")
    ? nestedSidePanel(process.title, content, { closeOnOverlay: true })
    : sidePanel(process.title, content, { closeOnOverlay: true, onClose: () => openToolsModal("processes") });
  document.getElementById("tool-process-close").addEventListener("click", () => closeToolProcessPanel(closePanel));
  document.getElementById("tool-process-detail-flow").addEventListener("click", () => openToolProcessFlow(id));
  document.getElementById("tool-process-detail-edit")?.addEventListener("click", () => { closePanel(); openToolProcessForm(id); });
}

function openToolProcessFlow(id) {
  const process = toolProcessRows().find((item) => item.id === id);
  if (!process) return;
  const steps = normalizeProcessSteps(process.steps);
  const nodes = steps.map((step, index) => `<article class="process-flow-node">
    <div class="process-flow-node-head"><span class="process-flow-number">${index + 1}</span><strong>${esc(step.title)}</strong></div>
    <p>${esc(step.instruction || "Sem instrução adicional.")}</p>
  </article>`);
  const sequence = [];
  nodes.forEach((node, index) => {
    sequence.push(node);
    if (index < nodes.length - 1) sequence.push('<div class="process-flow-connector" aria-hidden="true"><span>→</span></div>');
  });
  const content = `<div class="process-flow-view">
    <div class="process-flow-summary">
      <div><span>Área</span><strong>${esc(process.area || "Não informada")}</strong></div>
      <div><span>Sistema</span><strong>${esc(process.system_name || "Não informado")}</strong></div>
      <div><span>Etapas</span><strong>${steps.length}</strong></div>
      <div><span>Tempo estimado</span><strong>${process.estimated_minutes ? `${esc(process.estimated_minutes)} min` : "Não informado"}</strong></div>
    </div>
    ${process.objective ? `<p class="process-flow-objective">${esc(process.objective)}</p>` : ""}
    <div class="process-flow-scroll">
      <div class="process-flow-track">
        <div class="process-flow-terminal start"><span>Início</span></div>
        ${steps.length ? '<div class="process-flow-connector" aria-hidden="true"><span>→</span></div>' : ""}
        ${sequence.join("")}
        ${steps.length ? '<div class="process-flow-connector" aria-hidden="true"><span>→</span></div>' : ""}
        <div class="process-flow-terminal end"><span>Fim</span></div>
      </div>
    </div>
  </div><div class="modal-foot"><button class="btn" id="tool-process-flow-close">Fechar</button></div>`;
  const closeFlow = nestedCenterModal(`Fluxo · ${process.title}`, content, { cls: "full process-flow-modal", closeOnOverlay: true });
  document.getElementById("tool-process-flow-close").addEventListener("click", closeFlow);
}

function processStepEditorHtml(steps) {
  return steps.map((step, index) => `<div class="process-step-editor" data-index="${index}">
    <div class="process-step-number">${index + 1}</div><div class="process-step-fields"><input class="process-step-title" value="${esc(step.title)}" placeholder="Título da etapa"><textarea class="process-step-instruction" rows="3" placeholder="Explique como executar esta etapa">${esc(step.instruction)}</textarea></div>
    <div class="process-step-actions"><button class="tool-icon-btn process-step-up" type="button" title="Subir">↑</button><button class="tool-icon-btn process-step-down" type="button" title="Descer">↓</button><button class="tool-icon-btn process-step-remove" type="button" title="Excluir">×</button></div>
  </div>`).join("");
}

function openToolProcessForm(id = null) {
  if (!requireCurrentUserAdmin("Processos")) return;
  const current = toolProcessRows().find((item) => item.id === id) || {};
  let draftSteps = normalizeProcessSteps(current.steps);
  if (!draftSteps.length) draftSteps = [{ id: crypto.randomUUID(), title: "", instruction: "" }];
  const content = `<div class="form process-form">
    <div class="field full"><label>Nome do processo *</label><input id="tool-process-title" value="${esc(current.title || "")}" placeholder="Ex.: Criar pedido de venda no Bling"></div>
    <div class="field"><label>Área</label><input id="tool-process-area" value="${esc(current.area || "")}" placeholder="Ex.: Operações"></div>
    <div class="field"><label>Sistema</label><input id="tool-process-system" value="${esc(current.system_name || "")}" placeholder="Ex.: Bling"></div>
    <div class="field full"><label>Objetivo</label><textarea id="tool-process-objective" rows="3" placeholder="O que este processo entrega e quando deve ser usado">${esc(current.objective || "")}</textarea></div>
    <div class="field"><label>Público</label><input id="tool-process-audience" value="${esc(current.audience || "")}" placeholder="Ex.: Novos analistas"></div>
    <div class="field"><label>Cargo responsável</label><input id="tool-process-role" value="${esc(current.responsible_job_title || "")}" placeholder="Ex.: Analista de operações"></div>
    <div class="field"><label>Nível</label><select id="tool-process-difficulty">${Object.entries(PROCESS_DIFFICULTY_LABEL).map(([value, label]) => `<option value="${value}"${(current.difficulty || "basic") === value ? " selected" : ""}>${label}</option>`).join("")}</select></div>
    <div class="field"><label>Status</label><select id="tool-process-status">${Object.entries(PROCESS_STATUS_LABEL).map(([value, label]) => `<option value="${value}"${(current.status || "draft") === value ? " selected" : ""}>${label}</option>`).join("")}</select></div>
    <div class="field"><label>Tempo estimado (minutos)</label><input id="tool-process-time" type="number" min="1" max="1440" value="${esc(current.estimated_minutes || "")}"></div>
    <div class="field"><label>Tags</label><input id="tool-process-tags" value="${esc(normalizeTextList(current.tags).join(", "))}" placeholder="Bling, Nota fiscal, Financeiro"></div>
    <div class="field full"><label>Link de apoio</label><input id="tool-process-reference" type="url" value="${esc(current.reference_url || "")}" placeholder="https://..."></div>
    <div class="field full"><div class="process-steps-head"><label>Passo a passo *</label><button class="btn" id="tool-process-step-add" type="button">+ Etapa</button></div><div id="tool-process-steps" class="process-steps-editor"></div></div>
  </div><div class="modal-foot"><button class="btn" id="tool-process-cancel">Cancelar</button><button class="btn primary" id="tool-process-save">Salvar</button></div>`;
  const closePanel = document.getElementById("tools-root")
    ? nestedSidePanel(id ? "Editar processo" : "Novo processo", content, { closeOnOverlay: true })
    : sidePanel(id ? "Editar processo" : "Novo processo", content, { closeOnOverlay: true, onClose: () => openToolsModal("processes") });
  const stepsRoot = document.getElementById("tool-process-steps");
  const drawSteps = () => {
    stepsRoot.innerHTML = processStepEditorHtml(draftSteps);
    stepsRoot.querySelectorAll(".process-step-title,.process-step-instruction").forEach((input) => input.addEventListener("input", () => {
      const index = Number(input.closest(".process-step-editor").dataset.index);
      draftSteps[index][input.classList.contains("process-step-title") ? "title" : "instruction"] = input.value;
    }));
    stepsRoot.querySelectorAll(".process-step-remove").forEach((button) => button.addEventListener("click", () => { draftSteps.splice(Number(button.closest(".process-step-editor").dataset.index), 1); drawSteps(); }));
    stepsRoot.querySelectorAll(".process-step-up").forEach((button) => button.addEventListener("click", () => { const index = Number(button.closest(".process-step-editor").dataset.index); if (index > 0) { [draftSteps[index - 1], draftSteps[index]] = [draftSteps[index], draftSteps[index - 1]]; drawSteps(); } }));
    stepsRoot.querySelectorAll(".process-step-down").forEach((button) => button.addEventListener("click", () => { const index = Number(button.closest(".process-step-editor").dataset.index); if (index < draftSteps.length - 1) { [draftSteps[index + 1], draftSteps[index]] = [draftSteps[index], draftSteps[index + 1]]; drawSteps(); } }));
  };
  drawSteps();
  document.getElementById("tool-process-step-add").addEventListener("click", () => { draftSteps.push({ id: crypto.randomUUID(), title: "", instruction: "" }); drawSteps(); stepsRoot.lastElementChild?.scrollIntoView({ behavior: "smooth", block: "nearest" }); });
  document.getElementById("tool-process-cancel").addEventListener("click", () => closeToolProcessPanel(closePanel));
  document.getElementById("tool-process-save").addEventListener("click", async () => {
    const title = document.getElementById("tool-process-title").value.trim();
    const referenceUrl = document.getElementById("tool-process-reference").value.trim();
    const steps = draftSteps.map((step) => ({ ...step, title: step.title.trim(), instruction: step.instruction.trim() })).filter((step) => step.title || step.instruction);
    if (!title) { toast("Informe o nome do processo.", true); return; }
    if (referenceUrl && !safeHttpUrl(referenceUrl)) { toast("Informe um link de apoio válido, começando com http:// ou https://.", true); return; }
    if (!steps.length || steps.some((step) => !step.title)) { toast("Cadastre ao menos uma etapa com título.", true); return; }
    const button = document.getElementById("tool-process-save");
    button.disabled = true; button.textContent = "Salvando...";
    const body = {
      title,
      area: document.getElementById("tool-process-area").value.trim() || null,
      system_name: document.getElementById("tool-process-system").value.trim() || null,
      objective: document.getElementById("tool-process-objective").value.trim() || null,
      audience: document.getElementById("tool-process-audience").value.trim() || null,
      responsible_job_title: document.getElementById("tool-process-role").value.trim() || null,
      difficulty: document.getElementById("tool-process-difficulty").value,
      status: document.getElementById("tool-process-status").value,
      estimated_minutes: Number(document.getElementById("tool-process-time").value) || null,
      tags: normalizeTextList(document.getElementById("tool-process-tags").value),
      reference_url: referenceUrl || null,
      steps,
      version: id ? Number(current.version || 1) + 1 : 1,
      updated_at: new Date().toISOString()
    };
    try {
      const saved = id ? await updateRow("processes", id, body) : await createRow("processes", body);
      if (isLive()) {
        const index = remoteToolProcesses.findIndex((item) => item.id === saved.id);
        if (index >= 0) remoteToolProcesses[index] = saved; else remoteToolProcesses.unshift(saved);
        remoteToolProcessesLoaded = true;
      }
      toast("Processo salvo.");
      closeToolProcessPanel(closePanel);
    } catch (err) {
      button.disabled = false; button.textContent = "Salvar";
      toast("Erro ao salvar processo · " + err.message, true);
    }
  });
}

async function deleteToolProcess(id) {
  if (!requireCurrentUserAdmin("Processos")) return;
  const process = toolProcessRows().find((item) => item.id === id);
  if (!process || !window.confirm(`Excluir o processo "${process.title}"?`)) return;
  try {
    await deleteRow("processes", id);
    if (isLive()) remoteToolProcesses = remoteToolProcesses.filter((item) => item.id !== id);
    renderToolsSection();
    toast("Processo excluído.");
  } catch (err) { toast("Erro ao excluir processo · " + err.message, true); }
}

function toolEmailRows() {
  return APP_VARIANT === "web" && isLive() ? remoteToolEmails : readToolRows(TOOL_EMAILS_KEY);
}

async function loadRemoteToolEmails() {
  if (APP_VARIANT !== "web" || !isLive() || remoteToolEmailsLoading) return;
  remoteToolEmailsLoading = true;
  remoteToolEmailsError = "";
  try {
    const result = await emailAccountsRequest();
    remoteToolEmails = Array.isArray(result.accounts) ? result.accounts : [];
    remoteToolEmailsLoaded = true;
  } catch (err) {
    remoteToolEmailsError = err.message;
  } finally {
    remoteToolEmailsLoading = false;
    const root = document.getElementById("tools-root");
    if (root && toolsState.section === "emails") renderToolEmails(root);
  }
}

function renderToolEmails(root) {
  const usesServer = APP_VARIANT === "web" && isLive();
  if (usesServer && !remoteToolEmailsLoaded && !remoteToolEmailsLoading && !remoteToolEmailsError) loadRemoteToolEmails();
  const allAccounts = toolEmailRows();
  const query = toolsState.search.trim().toLocaleLowerCase("pt-BR");
  const tableState = toolTableState("emails");
  const accounts = allAccounts.filter((account) => {
    const matchesSearch = !query || [account.cnpj, account.client, account.email, ...(account.tags || [])]
      .some((value) => String(value || "").toLocaleLowerCase("pt-BR").includes(query));
    return matchesSearch && Object.entries(tableState.filters).every(([key, selected]) =>
      !selected?.size || selected.has(toolEmailValue(account, key))
    );
  });
  if (tableState.sortKey) {
    accounts.sort((a, b) => toolEmailValue(a, tableState.sortKey).localeCompare(
      toolEmailValue(b, tableState.sortKey), "pt-BR", { numeric: true, sensitivity: "base" }
    ) * tableState.sortDir);
  }
  const columns = visibleToolColumns("emails");
  const rows = accounts.length ? accounts.map((account) => `<tr>
    ${columns.map((col) => {
      if (col.k === "client") return `<td><strong>${esc(account.client || "—")}</strong></td>`;
      if (col.k === "password") return account.password
        ? `<td><span class="tool-secret"><span class="tool-secret-value" data-secret-id="${esc(account.id)}">••••••••</span><button class="tool-icon-btn tool-email-reveal" data-id="${esc(account.id)}" title="Mostrar senha">◉</button><button class="tool-icon-btn tool-email-copy" data-id="${esc(account.id)}" title="Copiar senha">⧉</button></span></td>`
        : '<td><span class="muted">Não disponível</span></td>';
      if (col.k === "tags") return `<td><span class="tool-tags">${(account.tags || []).map((tag) => `<span class="tool-tag">${esc(tag)}</span>`).join("") || '<span class="muted">—</span>'}</span></td>`;
      return `<td>${esc(account[col.k] || "—")}</td>`;
    }).join("")}
    <td><span class="tool-row-actions"><button class="tool-icon-btn tool-email-edit" data-id="${esc(account.id)}" title="Editar senha local e tags">✎</button>${usesServer ? "" : `<button class="tool-icon-btn tool-email-delete" data-id="${esc(account.id)}" title="Excluir">×</button>`}</span></td>
  </tr>`).join("") : `<tr><td colspan="${columns.length + 1}" class="tool-empty">Nenhum e-mail cadastrado.</td></tr>`;
  const feedback = usesServer && remoteToolEmailsLoading ? '<div class="tool-empty">Carregando e-mails...</div>'
    : usesServer && remoteToolEmailsError ? `<div class="tool-empty">Não foi possível carregar os e-mails: ${esc(remoteToolEmailsError)}</div>` : "";
  const activeFilters = Object.entries(tableState.filters).filter(([, values]) => values?.size);
  const filterStrip = `<div class="registration-filter-strip"><div class="registration-filter-badges">${activeFilters.map(([key, values]) => {
    const label = TOOL_COLUMN_DEFS.emails.find((col) => col.k === key)?.h || key;
    return `<button class="registration-filter-badge tool-filter-badge" data-key="${esc(key)}" title="Limpar filtro"><span>${esc(label)}: ${esc([...values].join(", "))}</span><b>×</b></button>`;
  }).join("")}</div><button class="filter-clear-all tool-filter-clear-all" type="button"${activeFilters.length < 2 ? " hidden" : ""}><span aria-hidden="true">×</span> Limpar tudo</button></div>`;
  root.innerHTML = `${toolsToolbarHtml(accounts.length, "Criar e-mail pelo CNPJ", "tool-email-add")}${filterStrip}${feedback}<div class="table-wrap tools-table-wrap"><table><thead><tr>${columns.map((col) => `<th data-tool-key="${esc(col.k)}" title="Clique para ordenar. Ctrl+clique para filtrar.">${esc(col.h)}${tableState.sortKey === col.k ? ` <span class="arrow">${tableState.sortDir > 0 ? "▲" : "▼"}</span>` : ""}</th>`).join("")}<th>Ações</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  wireToolsToolbar(root);
  wireSecondaryTableSelection(root.querySelector("table"), "tools:emails");
  document.getElementById("tool-email-add").addEventListener("click", () => openToolEmailForm());
  root.querySelectorAll(".tool-email-reveal").forEach((button) => button.addEventListener("click", () => toggleToolEmailSecret(button.dataset.id)));
  root.querySelectorAll(".tool-email-copy").forEach((button) => button.addEventListener("click", () => copyToolEmailSecret(button.dataset.id)));
  root.querySelectorAll(".tool-email-edit").forEach((button) => button.addEventListener("click", () => openToolEmailForm(button.dataset.id)));
  root.querySelectorAll(".tool-email-delete").forEach((button) => button.addEventListener("click", () => deleteToolEmail(button.dataset.id)));
  root.querySelectorAll("th[data-tool-key]").forEach((header) => header.addEventListener("click", (event) => {
    const key = header.dataset.toolKey;
    if (event.ctrlKey || event.metaKey) { openToolColumnFilter(header, key, allAccounts, toolEmailValue, "emails"); return; }
    if (tableState.sortKey === key) tableState.sortDir *= -1;
    else { tableState.sortKey = key; tableState.sortDir = 1; }
    renderToolsSection();
  }));
  root.querySelectorAll(".tool-filter-badge").forEach((badge) => badge.addEventListener("click", () => {
    delete tableState.filters[badge.dataset.key];
    renderToolsSection();
  }));
  root.querySelector(".tool-filter-clear-all")?.addEventListener("click", () => {
    tableState.filters = {};
    renderToolsSection();
  });
}

function openToolColumnFilter(header, key, rows, valueFn, section = toolsState.section) {
  document.getElementById("tool-filter-dd")?.remove();
  const values = [...new Set(rows.map((row) => valueFn(row, key)))].sort((a, b) =>
    a.localeCompare(b, "pt-BR", { numeric: true, sensitivity: "base" })
  );
  const tableState = toolTableState(section);
  let selected = new Set(tableState.filters[key] || []);
  const rect = header.getBoundingClientRect();
  const panel = document.createElement("div");
  panel.id = "tool-filter-dd";
  panel.className = "filter-dd";
  panel.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 300))}px`;
  panel.style.top = `${rect.bottom + 4}px`;
  panel.style.maxHeight = `${Math.max(220, window.innerHeight - rect.bottom - 20)}px`;
  panel.innerHTML = `<div class="dd-head"><span>Filtrar · ${esc(TOOL_COLUMN_DEFS[section].find((col) => col.k === key)?.h || key)}</span><span>${values.length}</span></div>
    <div class="dd-search"><input placeholder="Buscar..."></div><div class="dd-list"></div>
    <div class="dd-foot"><button class="btn tool-filter-all">Todos</button><button class="btn danger tool-filter-clear">Limpar</button><button class="btn primary tool-filter-apply">Aplicar</button></div>`;
  document.body.appendChild(panel);
  const list = panel.querySelector(".dd-list");
  const draw = () => {
    const query = panel.querySelector("input").value.trim().toLocaleLowerCase("pt-BR");
    list.innerHTML = values.filter((value) => !query || value.toLocaleLowerCase("pt-BR").includes(query)).map((value) => `<label class="dd-item${selected.has(value) ? " on" : ""}" data-value="${esc(value)}"><span class="dd-check">${selected.has(value) ? "✓" : ""}</span><span>${esc(value)}</span></label>`).join("");
    list.querySelectorAll(".dd-item").forEach((item) => item.addEventListener("click", () => {
      const value = item.dataset.value;
      if (selected.has(value)) selected.delete(value); else selected.add(value);
      draw();
    }));
  };
  draw();
  panel.querySelector("input").addEventListener("input", draw);
  panel.querySelector(".tool-filter-all").addEventListener("click", () => {
    if (selected.size === values.length) selected.clear(); else values.forEach((value) => selected.add(value));
    draw();
  });
  panel.querySelector(".tool-filter-clear").addEventListener("click", () => {
    delete tableState.filters[key]; panel.remove(); renderToolsSection();
  });
  panel.querySelector(".tool-filter-apply").addEventListener("click", () => {
    if (selected.size && selected.size < values.length) tableState.filters[key] = selected;
    else delete tableState.filters[key];
    panel.remove(); renderToolsSection();
  });
  panel.querySelector("input").focus();
  setTimeout(() => {
    const outside = (event) => {
      if (!panel.contains(event.target) && !header.contains(event.target)) {
        panel.remove();
        document.removeEventListener("mousedown", outside);
      }
    };
    document.addEventListener("mousedown", outside);
  }, 50);
}

function openToolEmailForm(id = null) {
  const usesServer = APP_VARIANT === "web" && isLive();
  const current = toolEmailRows().find((item) => item.id === id) || {};
  const editingServer = usesServer && Boolean(id);
  const editorHtml = editingServer ? `<div class="form">
    <div class="field full"><label>E-mail</label><input value="${esc(current.email || "")}" disabled></div>
    <div class="field full"><label>Senha registrada no CRM</label><input id="tool-email-password" type="password" value="" autocomplete="new-password" placeholder="Deixe em branco para manter a atual"></div>
    <div class="field full"><label>Tags</label><input id="tool-email-tags" value="${esc((current.tags || []).join(", "))}" placeholder="Excluir, Alterar senha"></div>
    <div class="field full"><div class="panel-list"><strong>Atenção</strong><span>Alterar a senha aqui atualiza apenas o registro do CRM. A senha da conta no painel da HostGator não será modificada.</span></div></div>
  </div><div class="modal-foot"><button class="btn" id="tool-email-cancel">Cancelar</button><button class="btn primary" id="tool-email-save">Salvar no CRM</button></div>` : `<div class="form">
    <div class="field full"><label>CNPJ</label><input id="tool-email-cnpj" value="${esc(current.cnpj || "")}"></div>
    <div class="field full"><label>Cliente</label><input id="tool-email-client" value="${esc(current.client || "")}"></div>
    ${usesServer ? '<div class="field full"><span class="muted">O endereço usará a raiz do CNPJ e a senha será gerada automaticamente.</span></div>' : `<div class="field full"><label>Email</label><input id="tool-email-address" type="email" value="${esc(current.email || "")}"></div><div class="field full"><label>Senha</label><input id="tool-email-password" type="password" value="${esc(current.password || "")}" autocomplete="new-password"></div>`}
  </div><div class="modal-foot"><button class="btn" id="tool-email-cancel">Cancelar</button><button class="btn primary" id="tool-email-save">${usesServer ? "Criar na HostGator" : "Salvar"}</button></div>`;
  const toolsModalOpen = Boolean(document.getElementById("tools-root"));
  const closeEditor = toolsModalOpen
    ? nestedSidePanel(id ? "Editar e-mail" : "Novo e-mail", editorHtml, { closeOnOverlay: true })
    : sidePanel(id ? "Editar e-mail" : "Novo e-mail", editorHtml, { closeOnOverlay: true, onClose: () => openToolsModal("emails") });
  const returnToEmails = () => {
    closeEditor();
    if (document.getElementById("tools-root")) renderToolsSection();
    else openToolsModal("emails");
  };
  document.getElementById("tool-email-cancel").addEventListener("click", returnToEmails);
  if (editingServer) {
    document.getElementById("tool-email-save").addEventListener("click", async () => {
      const button = document.getElementById("tool-email-save");
      button.disabled = true;
      button.textContent = "Salvando...";
      try {
        const password = document.getElementById("tool-email-password").value;
        const tags = document.getElementById("tool-email-tags").value.split(",").map((tag) => tag.trim()).filter(Boolean);
        const result = await emailAccountsRequest("PATCH", { email: current.email, ...(password ? { password } : {}), tags });
        const index = remoteToolEmails.findIndex((account) => account.email === result.account.email);
        if (index >= 0) remoteToolEmails[index] = result.account;
        else remoteToolEmails.unshift(result.account);
        toast("Dados salvos no CRM. A senha da HostGator não foi alterada.");
        returnToEmails();
      } catch (err) {
        button.disabled = false;
        button.textContent = "Salvar no CRM";
        toast("Erro ao atualizar e-mail · " + err.message, true);
      }
    });
    return;
  }
  const cnpjInput = document.getElementById("tool-email-cnpj");
  cnpjInput.addEventListener("blur", () => {
    const digits = cnpjInput.value.replace(/\D/g, "");
    const company = cache?.companies?.find((item) => String(item.tax_id || "").replace(/\D/g, "") === digits);
    if (company && !document.getElementById("tool-email-client").value.trim()) {
      document.getElementById("tool-email-client").value = company.trade_name || company.legal_name || "";
    }
  });
  document.getElementById("tool-email-save").addEventListener("click", async () => {
    const client = document.getElementById("tool-email-client").value.trim();
    const cnpj = document.getElementById("tool-email-cnpj").value.trim();
    if (usesServer) {
      const digits = cnpj.replace(/\D/g, "");
      const company = cache?.companies?.find((item) => String(item.tax_id || "").replace(/\D/g, "") === digits);
      if (!company) { toast("Informe o CNPJ de uma empresa cadastrada.", true); return; }
      const button = document.getElementById("tool-email-save");
      button.disabled = true;
      button.textContent = "Criando...";
      try {
        const result = await emailAccountsRequest("POST", { companyId: company.tax_id });
        const index = remoteToolEmails.findIndex((account) => account.id === result.account.id);
        if (index >= 0) remoteToolEmails[index] = result.account;
        else remoteToolEmails.unshift(result.account);
        remoteToolEmailsLoaded = true;
        toast(result.status === "created"
          ? `E-mail ${result.account.email} criado.`
          : result.status === "existing_unmanaged"
            ? `E-mail ${result.account.email} já existe. A senha anterior não pode ser recuperada.`
            : `E-mail ${result.account.email} já estava criado.`);
        returnToEmails();
      } catch (err) {
        button.disabled = false;
        button.textContent = "Criar na HostGator";
        toast("Erro ao criar e-mail · " + err.message, true);
      }
      return;
    }
    const email = document.getElementById("tool-email-address").value.trim();
    const password = document.getElementById("tool-email-password").value;
    if (!client || !email || !password) { toast("Preencha cliente, email e senha.", true); return; }
    const rows = readToolRows(TOOL_EMAILS_KEY);
    const item = {
      id: current.id || crypto.randomUUID(),
      cnpj: document.getElementById("tool-email-cnpj").value.trim(),
      client,
      email,
      password,
      updated_at: new Date().toISOString()
    };
    const index = rows.findIndex((row) => row.id === item.id);
    if (index >= 0) rows[index] = item;
    else rows.unshift(item);
    saveToolRows(TOOL_EMAILS_KEY, rows);
    toast("E-mail salvo.");
    returnToEmails();
  });
}

function toggleToolEmailSecret(id) {
  const account = toolEmailRows().find((item) => item.id === id);
  const value = document.querySelector(`[data-secret-id="${CSS.escape(id)}"]`);
  if (!account?.password || !value) return;
  const revealed = value.dataset.revealed === "true";
  value.textContent = revealed ? "••••••••" : account.password;
  value.dataset.revealed = String(!revealed);
}

async function copyToolEmailSecret(id) {
  const account = toolEmailRows().find((item) => item.id === id);
  if (!account?.password) { toast("A senha dessa conta não está registrada no CRM.", true); return; }
  try {
    await navigator.clipboard.writeText(account.password);
    toast("Senha copiada.");
  } catch (e) {
    toast("Não foi possível copiar a senha.", true);
  }
}

function deleteToolEmail(id) {
  const rows = readToolRows(TOOL_EMAILS_KEY);
  const account = rows.find((item) => item.id === id);
  if (!account || !window.confirm(`Excluir o e-mail "${account.email}"?`)) return;
  saveToolRows(TOOL_EMAILS_KEY, rows.filter((item) => item.id !== id));
  renderToolsSection();
  toast("E-mail excluído.");
}

function openUpdatesModal() {
  sidePanel("Atualizações", `<div class="panel-list">
    <div><strong>Versão web 0.1.0</strong></div>
    <div class="muted">Dependências entre metas, objetivos e tarefas; ajustes de modais; integração por usuário; e navegação de Cadastros revisada.</div>
  </div>`, { closeOnOverlay: true });
}

function openAdminLog() {
  if (!currentUserIsAdmin()) { toast("LOG disponível apenas para administradores.", true); return; }
  const sources = {
    companies: "Empresa",
    contacts: "Contato",
    deals: "Negociação",
    projects: "Entrega",
    activityRecords: "Tarefa",
    goals: "Meta",
    objectives: "Objetivo",
    products: "Produto",
    users: "Usuário"
  };
  const rows = Object.entries(sources).flatMap(([key, type]) =>
    (cache[key] || []).map((item) => ({
      type,
      name: item.name || item.title || item.trade_name || item.legal_name || item.full_name || item.contact_name || item.id || "Registro",
      at: item.updated_at || item.created_at || ""
    }))
  ).filter((item) => item.at).sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 100);
  const body = rows.length
    ? rows.map((item) => `<tr><td>${esc(item.type)}</td><td><strong>${esc(item.name)}</strong></td><td>${esc(new Date(item.at).toLocaleString("pt-BR"))}</td></tr>`).join("")
    : '<tr><td colspan="3" class="empty">Nenhuma alteração registrada.</td></tr>';
  shell("Log · Alterações recentes", `<div class="table-wrap"><table><thead><tr><th>Tipo</th><th>Registro</th><th>Data</th></tr></thead><tbody>${body}</tbody></table></div>
    <div class="modal-foot"><button class="btn" id="log-close">Fechar</button></div>`, { cls: "wide" });
  document.getElementById("log-close").addEventListener("click", closeModal);
}

function handleAction(action) {
  if (action === "theme") { setTheme(!document.body.classList.contains("light")); return; }
  if (action === "settings") { openSettings(); return; }
  if (action === "help") { openHelpModal(); return; }
  if (action === "log") { openAdminLog(); return; }
  if (action === "tools" || action === "files") { openToolsModal(); return; }
  if (action === "updates") { openUpdatesModal(); return; }
  if (action === "pipeline") { openPipelinesModal(); return; }
  if (action === "registrations") { if (requireCurrentUserAdmin("Cadastros")) openRegistrationsModal(); return; }
  if (action === "users") { openUsersModal(); return; }
  if (action === "notifications") {
    sidePanel("Notificações", `<div class="panel-list">Nenhuma notificação por enquanto.</div>`, { closeOnOverlay: true });
    return;
  }
  if (action === "integrations") {
    sidePanel("Integrações", integrationsHtml(), { closeOnOverlay: true });
    wireIntegrations();
    return;
  }
  if (action === "logout") {
    if (window.confirm("Deseja sair do ENTERPRISER CRM?")) signOut();
    return;
  }
}

// ---------- Eventos globais ----------
document.getElementById("login-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = document.getElementById("login-submit");
  const error = document.getElementById("login-error");
  button.disabled = true; button.textContent = "Entrando..."; error.textContent = "";
  try {
    const email = document.getElementById("login-email").value.trim().toLowerCase();
    const password = document.getElementById("login-password").value;
    storeAuthSession(await authRequest("token?grant_type=password", { email, password }));
    await init();
  } catch (err) {
    storeAuthSession(null);
    error.textContent = err.message === "Invalid login credentials" ? "E-mail ou senha inválidos." : err.message;
  } finally {
    button.disabled = false; button.textContent = "Entrar";
  }
});
document.getElementById("brand-home")?.addEventListener("click", () => {
  closeFloaters();
  state.tab = "home"; state.sortK = null; state.sortDir = 1; state.q = ""; state.view = "table";
  state.selectedConversations.clear();
  document.getElementById("search").value = "";
  render();
});
document.querySelectorAll(".tab").forEach((t) =>
  t.addEventListener("click", () => {
    closeFloaters();
    state.tab = t.dataset.tab; state.sortK = null; state.sortDir = 1; state.q = "";
    state.view = "table";
    if (state.tab !== "conversations") state.selectedConversations.clear();
    document.getElementById("search").value = ""; render();
  }));
document.querySelectorAll(".view").forEach((v) =>
  v.addEventListener("click", () => {
    if (v.disabled) return;
    closeFloaters();
    state.view = v.dataset.view; render();
  }));
document.getElementById("search").addEventListener("input", (e) => {
  state.q = e.target.value.trim();
  if (state.pages[state.tab]) state.pages[state.tab] = 1;
  closeFloaters();
  render();
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  const floater = document.getElementById("filter-dd") || document.getElementById("cols-dd") || document.getElementById("csv-dd") || document.getElementById("data-dd") || document.getElementById("view-dd");
  if (floater) closeFloaters();
});
document.getElementById("new").addEventListener("click", () => {
  if (state.tab === "conversations") document.getElementById("import-file").click();
  else if (state.tab === "activities") openTaskDeliveryPicker();
  else openForm(state.tab, null);
});
document.getElementById("cols-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  document.getElementById("filter-dd")?.remove();
  document.getElementById("csv-dd")?.remove();
  openColumnManager();
});
document.getElementById("view-menu-btn").addEventListener("click", (event) => {
  event.stopPropagation();
  if (document.getElementById("view-dd")) closeFloaters();
  else openViewMenu();
});
document.getElementById("data-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  document.getElementById("filter-dd")?.remove();
  document.getElementById("cols-dd")?.remove();
  openDataMenu();
});
document.getElementById("import-file").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (file) await importWhatsAppFile(file);
});
document.getElementById("associate-contact").addEventListener("click", () => openAssociateContactModal());
document.getElementById("create-deal-from-selection").addEventListener("click", () => createDealFromSelectedConversations());
document.querySelectorAll(".ico, .foot-btn").forEach((b) =>
  b.addEventListener("click", () => handleAction(b.dataset.action)));

// ---------- Bootstrap ----------
function setConn() {
  const el = document.getElementById("conn");
  if (!el) return;
  const live = isLive();
  el.classList.toggle("live", live);
  document.getElementById("conn-label").textContent = live ? "Conectado ao Supabase" : "Dados de exemplo";
}

if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.erc_reddit_events_queue || changes.erc_reddit_profiles || changes.erc_reddit_room_urls) syncRedditQueue();
    if (changes.erc_whatsapp_events_queue || changes.erc_whatsapp_contacts) syncWhatsAppQueue();
  });
}

async function init() {
  setConn();
  try {
    await loadAll();
    if (isLive()) {
      const session = readAuthSession();
      currentProfile = cache.users.find((user) => user.auth_user_id === session?.user?.id)
        || cache.users.find((user) => String(user.email || "").toLowerCase() === String(session?.user?.email || "").toLowerCase());
      if (!currentProfile || currentProfile.status !== "active") {
        storeAuthSession(null);
        showLogin("Este usuário não possui um perfil ativo no CRM.");
        return;
      }
    }
    syncRedditQueue();
    syncWhatsAppQueue();
    hideLogin();
    render();
    document.getElementById("boot-gate")?.setAttribute("hidden", "");
  } catch (err) {
    document.getElementById("main").innerHTML =
      `<div class="empty">Falha ao carregar do Supabase.<br><span class="muted">${esc(err.message)}</span><br><br>` +
      `Confira URL / anon key em Configurações e as políticas de RLS.</div>`;
    const conn = document.getElementById("conn");
    if (conn) {
      conn.classList.remove("live");
      document.getElementById("conn-label").textContent = "Erro de conexão";
    }
    hideLogin();
    document.getElementById("boot-gate")?.setAttribute("hidden", "");
  }
}

async function startApp() {
  await ensurePrivacyConsent();
  if (!isLive()) { hideLogin(); await init(); return; }
  const token = await getAccessToken();
  if (!token) { showLogin(); return; }
  await init();
}

setTheme(localStorage.getItem("crm_theme") === "light");
startApp();
