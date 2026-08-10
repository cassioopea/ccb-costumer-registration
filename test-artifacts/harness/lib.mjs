/**
 * @homolog — Harness de validação de integração REAL (Sinqia HML / BJ21M05).
 *
 * NUNCA roda no CI: não é referenciado por nenhum script npm e depende de
 * `.env.test` (fora do repo) + da janela comercial da Sinqia.
 *
 * SEGURANÇA: as credenciais são lidas de `.env.test` e usadas SOMENTE no corpo
 * do POST /api/login do BFF local. Nenhum valor é impresso, logado ou gravado
 * em evidência — apenas os NOMES das variáveis aparecem em qualquer saída.
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const RAIZ = path.resolve(import.meta.dirname, "..", "..");
export const API = process.env.HOMOLOG_API ?? "http://127.0.0.1:3333";
export const DIR_EVID = path.join(RAIZ, "test-artifacts", "evidencias");

/** Parser mínimo de .env (sem dependência) — devolve mapa, nunca imprime valores. */
function lerEnvArquivo(arquivo) {
  const texto = readFileSync(arquivo, "utf8");
  const mapa = {};
  for (const linha of texto.split(/\r?\n/)) {
    const t = linha.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0) continue;
    const chave = t.slice(0, i).trim();
    let valor = t.slice(i + 1).trim();
    if (
      (valor.startsWith('"') && valor.endsWith('"')) ||
      (valor.startsWith("'") && valor.endsWith("'"))
    ) {
      valor = valor.slice(1, -1);
    }
    mapa[chave] = valor;
  }
  return mapa;
}

const NOMES = {
  A: ["SINQIA_HOMOLOG_USER_A", "SINQIA_HOMOLOG_PASS_A"],
  B: ["SINQIA_HOMOLOG_USER_B", "SINQIA_HOMOLOG_PASS_B"],
};

/** Credenciais dos dois operadores. Falha com o NOME da variável ausente. */
export function credenciais() {
  const env = lerEnvArquivo(path.join(RAIZ, ".env.test"));
  const out = {};
  for (const [perfil, [nomeUser, nomePass]] of Object.entries(NOMES)) {
    const user = env[nomeUser];
    const pass = env[nomePass];
    if (!user || !pass) {
      throw new Error(
        `Credencial ausente em .env.test: ${!user ? nomeUser : nomePass} está vazia. ` +
          "Peça ao PM para preencher (nunca informe valores no chat).",
      );
    }
    out[perfil] = { user, pass };
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Cliente HTTP do BFF com cookie jar por operador                     */
/* ------------------------------------------------------------------ */

const jar = new Map(); // perfil -> sid

function cookieDe(perfil) {
  const sid = jar.get(perfil);
  return sid ? { cookie: `sid=${sid}` } : {};
}

export async function login(perfil) {
  const { user, pass } = credenciais()[perfil];
  const res = await fetch(`${API}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: user, password: pass }),
  });
  const corpo = await res.json().catch(() => null);
  const setCookie = res.headers.getSetCookie?.() ?? [];
  const sid = setCookie
    .map((c) => /(?:^|;\s*)sid=([^;]+)/.exec(c)?.[1])
    .find(Boolean);
  if (res.status === 200 && sid) jar.set(perfil, sid);
  return {
    perfil,
    status: res.status,
    ok: res.status === 200 && !!sid,
    // `username` do corpo é o login do operador — identidade, não credencial.
    username: corpo?.username ?? null,
    tokenFormato: corpo?.tokenFormato ?? null,
    tokenTtlSegundos: corpo?.tokenTtlSegundos ?? null,
    erro: res.status === 200 ? null : corpo?.error ?? null,
  };
}

/** Login de A e B. Devolve o resumo sem qualquer valor sensível. */
export async function loginAmbos() {
  return { A: await login("A"), B: await login("B") };
}

/** Chamada ao BFF na sessão de um operador. */
/** Header `cookie` da jar de um operador — usado nos uploads multipart. */
export function cookieHeader(perfil) {
  const sid = jar.get(perfil);
  if (!sid) throw new Error(`Operador ${perfil} sem sessão — chame login("${perfil}") antes.`);
  return `sid=${sid}`;
}

/** Upload multipart (arquivo + campo `control`) na sessão de um operador. */
export async function upload(perfil, rota, nomeArquivo, conteudo, control) {
  const fd = new FormData();
  fd.append("file", new Blob([conteudo], { type: "text/csv" }), nomeArquivo);
  if (control !== undefined) fd.append("control", JSON.stringify(control));
  const res = await fetch(`${API}${rota}`, {
    method: "POST",
    body: fd,
    headers: { cookie: cookieHeader(perfil) },
  });
  const texto = await res.text();
  let json = null;
  try {
    json = texto ? JSON.parse(texto) : null;
  } catch {
    /* resposta não-JSON */
  }
  return { status: res.status, json, texto: json ? undefined : texto };
}

export async function api(perfil, metodo, rota, corpo) {
  const res = await fetch(`${API}${rota}`, {
    method: metodo,
    headers: {
      ...(corpo !== undefined ? { "content-type": "application/json" } : {}),
      ...cookieDe(perfil),
    },
    ...(corpo !== undefined ? { body: JSON.stringify(corpo) } : {}),
  });
  const texto = await res.text();
  let json = null;
  try {
    json = texto ? JSON.parse(texto) : null;
  } catch {
    /* resposta não-JSON (CSV/stream) fica em `texto` */
  }
  return { status: res.status, json, texto: json ? undefined : texto };
}

/**
 * Lê o PRIMEIRO evento `snapshot` de um stream SSE de job e encerra a conexão.
 * Serve de polling: cada conexão nova devolve o progresso atual do job.
 */
export async function snapshotJob(perfil, rota) {
  const ctrl = new AbortController();
  const res = await fetch(`${API}${rota}`, {
    headers: { cookie: cookieHeader(perfil), accept: "text/event-stream" },
    signal: ctrl.signal,
  });
  if (res.status !== 200) {
    const t = await res.text().catch(() => "");
    return { status: res.status, snapshot: null, erro: t.slice(0, 300) };
  }
  const leitor = res.body.getReader();
  const dec = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await leitor.read();
      if (done) break;
      buffer += dec.decode(value, { stream: true });
      const m = /event: snapshot\r?\ndata: (.+)\r?\n/.exec(buffer);
      if (m) {
        ctrl.abort();
        return { status: 200, snapshot: JSON.parse(m[1]) };
      }
    }
  } catch {
    /* abort esperado */
  } finally {
    try {
      ctrl.abort();
    } catch {
      /* ok */
    }
  }
  return { status: 200, snapshot: null };
}

export const get = (p, rota) => api(p, "GET", rota);
export const post = (p, rota, corpo) => api(p, "POST", rota, corpo ?? {});

/* ------------------------------------------------------------------ */
/* Evidência                                                           */
/* ------------------------------------------------------------------ */

/**
 * Redação obrigatória: os LOGINS dos operadores (valores de
 * SINQIA_HOMOLOG_USER_A/B) viram <OPERADOR_A>/<OPERADOR_B) em toda evidência e
 * em todo log — a trilha de auditoria do BFF devolve o login em `ator`/
 * `requisitante`, e nada disso pode vazar para arquivo ou terminal.
 */
/**
 * A troca é por IGUALDADE de valor (não por substring): o login de um dos
 * operadores pode ser uma palavra comum — trocar substring corromperia hosts,
 * nomes de variáveis e mensagens. Senhas, por serem distintivas e de risco
 * máximo, são removidas também como substring.
 */
const CHAVES_IDENTIDADE = new Set([
  "ator",
  "requisitante",
  "username",
  "usuario",
  "decididoPor",
  "criadoPor",
  "aprovador",
  "nmLogin",
  "nmUsr",
  "nmUsuario",
]);

/** Rótulo do operador a partir do login (identidade → <OPERADOR_A/B>). */
export function rotuloOperador(login) {
  if (typeof login !== "string" || !login.trim()) return login;
  const { A, B } = credenciais();
  const n = login.trim().toLowerCase();
  if (n === A.user.trim().toLowerCase()) return "<OPERADOR_A>";
  if (n === B.user.trim().toLowerCase()) return "<OPERADOR_B>";
  return login;
}

function semSenhas(texto) {
  const { A, B } = credenciais();
  let t = texto;
  for (const senha of [A.pass, B.pass]) {
    if (senha) t = t.split(senha).join("<SENHA_REDIGIDA>");
  }
  return t;
}

/**
 * Um login DISTINTIVO (com ponto ou razoavelmente longo) é trocado também como
 * SUBSTRING: ele aparece dentro de frases inteiras vindas do BFF ("criada por
 * X em ...") e do CLI ("por X. Mudança auditada"), onde a troca por igualdade
 * de campo não alcança. Login curto e genérico (ex.: uma palavra que também é
 * o nome do fornecedor) NÃO entra nessa regra — trocá-lo como substring
 * corromperia hosts e mensagens; nesses casos vale a troca por campo de
 * identidade e os padrões "por <login>" abaixo.
 */
function ehDistintivo(login) {
  return typeof login === "string" && (login.includes(".") || login.trim().length >= 8);
}

function semLoginsEmProsa(texto) {
  const { A, B } = credenciais();
  let t = texto;
  for (const [login, rotulo] of [
    [A.user, "<OPERADOR_A>"],
    [B.user, "<OPERADOR_B>"],
  ]) {
    if (!login) continue;
    const alvo = login.trim();
    if (ehDistintivo(alvo)) {
      for (const forma of [alvo, alvo.toLowerCase(), alvo.toUpperCase()]) {
        t = t.split(forma).join(rotulo);
      }
      continue;
    }
    // Login genérico: troca só onde a posição é claramente de identidade.
    const esc = alvo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    t = t.replace(new RegExp(`(por|ator|criada por|decidida por|·)\\s+${esc}\\b`, "gi"), `$1 ${rotulo}`);
  }
  return t;
}

/** Redige recursivamente: identidades → rótulo; senhas → <SENHA_REDIGIDA>. */
export function redigir(valor) {
  const anda = (v, chavePai) => {
    if (typeof v === "string") {
      const trocado = rotuloOperador(v);
      if (trocado !== v) return trocado;
      // Campo de identidade cujo valor não é A nem B fica como está (outro
      // operador real da Sinqia é informação de auditoria, não credencial).
      return CHAVES_IDENTIDADE.has(chavePai) ? v : v;
    }
    if (Array.isArray(v)) return v.map((x) => anda(x, chavePai));
    if (v && typeof v === "object") {
      const out = {};
      for (const [k, x] of Object.entries(v)) out[k] = anda(x, k);
      return out;
    }
    return v;
  };
  const limpo = anda(valor, "");
  const texto = typeof limpo === "string" ? limpo : JSON.stringify(limpo, null, 2);
  return semSenhas(semLoginsEmProsa(texto));
}

/** console.log com redação aplicada. */
export function log(...partes) {
  console.log(partes.map((p) => redigir(p)).join(" "));
}

/** Grava evidência em JSON (test-artifacts/evidencias/<nome>.json), redigida. */
export function evidencia(nome, dados) {
  mkdirSync(DIR_EVID, { recursive: true });
  const arquivo = path.join(DIR_EVID, `${nome}.json`);
  writeFileSync(arquivo, redigir(dados), "utf8");
  return path.relative(RAIZ, arquivo);
}

/* ------------------------------------------------------------------ */
/* Estado compartilhado entre os passos da matriz                      */
/* ------------------------------------------------------------------ */

const ARQ_ESTADO = path.join(RAIZ, "test-artifacts", "estado.json");

export function estado() {
  try {
    return JSON.parse(readFileSync(ARQ_ESTADO, "utf8"));
  } catch {
    return { tomadores: {}, propostas: {}, requisicoes: {} };
  }
}

export function salvarEstado(novo) {
  mkdirSync(path.dirname(ARQ_ESTADO), { recursive: true });
  writeFileSync(ARQ_ESTADO, redigir(novo), "utf8");
}

/** CPF sintético com dígitos verificadores válidos, determinístico por semente. */
export function cpfSintetico(semente) {
  const base = String(semente).replace(/\D/g, "").padStart(9, "0").slice(-9);
  const d = base.split("").map(Number);
  const dv = (nums, pesoInicial) => {
    const soma = nums.reduce((acc, n, i) => acc + n * (pesoInicial - i), 0);
    const r = (soma * 10) % 11;
    return r === 10 ? 0 : r;
  };
  const d1 = dv(d, 10);
  const d2 = dv([...d, d1], 11);
  return base + String(d1) + String(d2);
}

export const agora = () => new Date().toISOString();

/** Espera até `cond()` virar verdadeiro (polling) — para execução de lote. */
export async function aguardar(cond, { timeoutMs = 60_000, intervaloMs = 1500 } = {}) {
  const limite = Date.now() + timeoutMs;
  for (;;) {
    const r = await cond();
    if (r) return r;
    if (Date.now() > limite) return null;
    await new Promise((s) => setTimeout(s, intervaloMs));
  }
}
