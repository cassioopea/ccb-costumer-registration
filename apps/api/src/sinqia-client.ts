import { request } from "undici";
import {
  analyzeEnvelope,
  normalizeClientesResponse,
  sinqiaEnvelopeSchema,
  type AlterarSituacaoRequest,
  type CadastrarClienteRequest,
  type ClienteResumo,
  type ClientesPage,
  type EnvelopeAnalysis,
  type ListarClientesQuery,
  type SinqiaEnvelope,
} from "@cadastro-lote/shared";
import { env, loginUrl, cadastroUrl, clientesUrl, situacaoUrl } from "./env.js";

/**
 * Cliente HTTP da API Sinqia (BJ21M05).
 *
 * Fluxo de 2 passos:
 *  1. GET /user com Basic Auth → o token volta no HEADER de resposta "Auth".
 *  2. POST /cadastrarCliente com Bearer <token>.
 *
 * SEGURANÇA:
 *  - Credenciais recebidas por parâmetro, usadas só na sessão, nunca logadas.
 *  - Token nunca é logado por completo (só um prefixo mascarado, se necessário).
 */

export class SinqiaAuthError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
  ) {
    super(message);
    this.name = "SinqiaAuthError";
  }
}

/** Faz login e devolve o token lido do header "Auth". */
export async function login(username: string, password: string): Promise<string> {
  const basic = Buffer.from(`${username}:${password}`).toString("base64");

  const res = await request(loginUrl(), {
    method: "GET",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/json",
    },
    headersTimeout: env.REQUEST_TIMEOUT_MS,
    bodyTimeout: env.REQUEST_TIMEOUT_MS,
  });

  // Drena o body para liberar a conexão (não precisamos do conteúdo).
  await res.body.text().catch(() => undefined);

  if (res.statusCode === 401 || res.statusCode === 403) {
    throw new SinqiaAuthError(
      "Login recusado (usuário/senha inválidos ou sem permissão).",
      res.statusCode,
    );
  }
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new SinqiaAuthError(
      `Falha no login (HTTP ${res.statusCode}). Verifique VPN/host/credenciais.`,
      res.statusCode,
    );
  }

  // Header case-insensitive; undici entrega em minúsculas.
  const authHeader = res.headers["auth"];
  const token = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  if (!token) {
    throw new SinqiaAuthError(
      "Login OK, mas o header 'Auth' não veio na resposta. Contate a Sinqia/BRQ.",
      res.statusCode,
    );
  }
  return token;
}

export interface CadastroResult {
  httpStatus: number;
  envelope: SinqiaEnvelope | null;
  analysis: EnvelopeAnalysis;
  /** Corpo bruto quando não foi possível parsear o envelope. */
  rawBody?: string;
}

/** Envia UMA requisição de cadastro. Não faz retry aqui (a orquestração cuida). */
export async function cadastrarCliente(
  token: string,
  body: CadastrarClienteRequest,
): Promise<CadastroResult> {
  const res = await request(cadastroUrl(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    headersTimeout: env.REQUEST_TIMEOUT_MS,
    bodyTimeout: env.REQUEST_TIMEOUT_MS,
  });

  const text = await res.body.text().catch(() => "");
  let envelope: SinqiaEnvelope | null = null;
  let rawBody: string | undefined;

  if (text) {
    try {
      const json = JSON.parse(text);
      const parsed = sinqiaEnvelopeSchema.safeParse(json);
      envelope = parsed.success ? parsed.data : (json as SinqiaEnvelope);
    } catch {
      rawBody = text.slice(0, 2000);
    }
  }

  const analysis = analyzeEnvelope(res.statusCode, envelope);
  return { httpStatus: res.statusCode, envelope, analysis, rawBody };
}

/** Erro de token expirado (HTTP 401) para a orquestração decidir relogar. */
export class TokenExpiredError extends Error {
  constructor() {
    super("Token expirado (HTTP 401).");
    this.name = "TokenExpiredError";
  }
}

/* ------------------------------------------------------------------ */
/* Situação do cliente                                                 */
/* ------------------------------------------------------------------ */

/** Lê o corpo como JSON; devolve o texto cru quando não for JSON válido. */
async function readJson(res: { body: { text(): Promise<string> } }) {
  const text = await res.body.text().catch(() => "");
  if (!text) return { json: null as unknown, rawBody: undefined as string | undefined };
  try {
    return { json: JSON.parse(text) as unknown, rawBody: undefined };
  } catch {
    return { json: null as unknown, rawBody: text.slice(0, 2000) };
  }
}

export interface ListarClientesResult {
  httpStatus: number;
  page: ClientesPage;
  /** Corpo bruto quando não deu para parsear/normalizar (ajuda a diagnosticar). */
  rawBody?: string;
}

/**
 * GET /v1/cliente — lista paginada.
 *
 * HTTP 204 significa "nenhum registro encontrado" (sem corpo) — devolvemos uma
 * página vazia, não um erro.
 */
export async function listarClientes(
  token: string,
  query: ListarClientesQuery,
): Promise<ListarClientesResult> {
  const url = new URL(clientesUrl());
  url.searchParams.set("page", String(query.page));
  url.searchParams.set("size", String(query.size));
  if (query.search) url.searchParams.set("search", query.search);
  if (query.tipoPessoa) url.searchParams.set("tipoPessoa", query.tipoPessoa);
  if (query.sort) url.searchParams.set("sort", query.sort);

  const res = await request(url.toString(), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    headersTimeout: env.REQUEST_TIMEOUT_MS,
    bodyTimeout: env.REQUEST_TIMEOUT_MS,
  });

  const { json, rawBody } = await readJson(res);

  const emptyPage: ClientesPage = {
    items: [],
    page: query.page,
    size: query.size,
    totalElements: 0,
    totalPages: 0,
  };

  if (res.statusCode === 204) {
    return { httpStatus: 204, page: emptyPage };
  }

  return {
    httpStatus: res.statusCode,
    page:
      res.statusCode >= 200 && res.statusCode < 300
        ? normalizeClientesResponse(json, query.page, query.size)
        : emptyPage,
    rawBody,
  };
}

export interface TodosClientesResult {
  items: ClienteResumo[];
  /** Bateu no teto de segurança — a lista pode estar incompleta. */
  truncado: boolean;
  /** Quantas páginas foram lidas (diagnóstico). */
  paginas: number;
  totalElements: number | null;
  rawBody?: string;
}

/** Página máxima suportada pela API (parâmetro `size`). */
const PAGE_SIZE = 200;
/** Teto de registros carregados de uma vez — evita estourar memória/tempo. */
const MAX_ITEMS = 20_000;
/** Teto de requisições, mesmo que a API nunca sinalize fim. */
const MAX_PAGES = 200;

/**
 * Percorre TODAS as páginas de /v1/cliente com um único token.
 *
 * A tela precisa disso porque a busca é local: com dezenas de milhares de
 * clientes e página de 200, procurar só na página corrente não acha ninguém.
 * Um login para o varrimento inteiro (em vez de um por página).
 */
export async function listarTodosClientes(
  token: string,
  tipoPessoa?: string,
): Promise<TodosClientesResult> {
  const items: ClienteResumo[] = [];
  let paginas = 0;
  let truncado = false;
  let totalElements: number | null = null;
  let rawBody: string | undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await listarClientes(token, { page, size: PAGE_SIZE, tipoPessoa });
    paginas++;

    if (res.httpStatus === 204) break;
    if (res.httpStatus < 200 || res.httpStatus >= 300) {
      throw new Error(`A Sinqia respondeu HTTP ${res.httpStatus} ao listar a página ${page}.`);
    }
    if (res.rawBody && !rawBody) rawBody = res.rawBody;
    if (res.page.totalElements !== null) totalElements = res.page.totalElements;

    const lote = res.page.items;
    if (lote.length === 0) break;

    items.push(...lote);

    if (items.length >= MAX_ITEMS) {
      truncado = true;
      break;
    }
    // Página incompleta = última página.
    if (lote.length < PAGE_SIZE) break;
    // Respeita totalPages quando a API informa.
    if (res.page.totalPages !== null && page + 1 >= res.page.totalPages) break;

    if (page === MAX_PAGES - 1) truncado = true;
  }

  return { items, truncado, paginas, totalElements, rawBody };
}

export interface AlterarSituacaoResult {
  httpStatus: number;
  envelope: SinqiaEnvelope | null;
  analysis: EnvelopeAnalysis;
  rawBody?: string;
}

/** POST /situacao/alterar-situacao-cliente — UMA alteração (sem retry aqui). */
export async function alterarSituacaoCliente(
  token: string,
  body: AlterarSituacaoRequest,
): Promise<AlterarSituacaoResult> {
  const res = await request(situacaoUrl(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    headersTimeout: env.REQUEST_TIMEOUT_MS,
    bodyTimeout: env.REQUEST_TIMEOUT_MS,
  });

  const { json, rawBody } = await readJson(res);
  let envelope: SinqiaEnvelope | null = null;
  if (json) {
    const parsed = sinqiaEnvelopeSchema.safeParse(json);
    envelope = parsed.success ? parsed.data : (json as SinqiaEnvelope);
  }

  // Mesma regra do cadastro: HTTP 200 não basta, o envelope decide.
  const analysis = analyzeEnvelope(res.statusCode, envelope);
  return { httpStatus: res.statusCode, envelope, analysis, rawBody };
}
