import { request } from "undici";
import {
  analyzeEnvelope,
  calcProspResponseSchema,
  normalizeClientesResponse,
  sinqiaEnvelopeSchema,
  type AlterarSituacaoRequest,
  type CadastrarClienteRequest,
  type CalcProspCalculo,
  type CalcProspRequest,
  type ClienteResumo,
  type ClientesPage,
  type EnvelopeAnalysis,
  type ListarClientesQuery,
  type SinqiaEnvelope,
} from "@cadastro-lote/shared";
import {
  env,
  loginUrl,
  buscarClienteUrl,
  cadastroUrl,
  camposObrigatoriosUrl,
  calcProspUrl,
  clientesUrl,
  conveniosUrl,
  dadosPropostaUrl,
  filiaisUrl,
  produtosUrl,
  propostaUrl,
  propostasPorCpfUrl,
  situacaoUrl,
} from "./env.js";

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

export interface CamposObrigatoriosResult {
  httpStatus: number;
  /** Corpo cru — a tela exibe para descobrirmos o formato real da resposta. */
  body: unknown;
  rawBody?: string;
}

/**
 * GET consultarCamposObrigatorios — sem parâmetros, somente leitura.
 *
 * HTTP 204 ("Nenhum registro foi encontrado") significa que não há campos
 * obrigatórios parametrizados; devolvemos body null, não erro.
 */
export async function consultarCamposObrigatorios(
  token: string,
): Promise<CamposObrigatoriosResult> {
  const res = await request(camposObrigatoriosUrl(), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    headersTimeout: env.REQUEST_TIMEOUT_MS,
    bodyTimeout: env.REQUEST_TIMEOUT_MS,
  });

  const { json, rawBody } = await readJson(res);
  return { httpStatus: res.statusCode, body: json, rawBody };
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

/* ------------------------------------------------------------------ */
/* Propostas — consulta por cliente e detalhe                           */
/* ------------------------------------------------------------------ */

/** Resumo de uma proposta do cliente (shape real capturado em HML). */
export interface PropostaResumo {
  nrProp: number;
  nrClient: number | null;
  dtProp: number | null;
  cdProd: number | null;
  vlFinan: number | null;
  vlPrest: number | null;
  vlTotal: number | null;
  vlLiquid: number | null;
  qtPrest: number | null;
  dtVct1ap: number | null;
}

export interface PropostasClienteResult {
  httpStatus: number;
  propostas: PropostaResumo[];
}

/**
 * GET consultarPropostasPorCpfcnpj — devolve `{sc200: [...]}` com as propostas
 * do cliente. 204 = nenhum registro (cliente sem propostas).
 */
export async function listarPropostasPorCpf(
  token: string,
  cpf: string,
): Promise<PropostasClienteResult> {
  const url = new URL(propostasPorCpfUrl());
  url.searchParams.set("nrCpfcnpj", cpf);
  const { httpStatus, json } = await getJsonLookup(token, url.toString());
  if (httpStatus === 204) return { httpStatus, propostas: [] };

  const lista = (json as { sc200?: Array<Record<string, any>> } | null)?.sc200 ?? [];
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    httpStatus,
    propostas: lista
      .map((p) => ({
        nrProp: Number(p?.id?.nrProp ?? NaN),
        nrClient: num(p?.id?.nrClient),
        dtProp: num(p?.dtProp),
        cdProd: num(p?.cdProd),
        vlFinan: num(p?.vlFinan),
        vlPrest: num(p?.vlPrest),
        vlTotal: num(p?.vlTotal),
        vlLiquid: num(p?.vlLiquid),
        qtPrest: num(p?.qtPrest),
        dtVct1ap: num(p?.dtVct1ap),
      }))
      .filter((p) => Number.isFinite(p.nrProp))
      .sort((a, b) => b.nrProp - a.nrProp),
  };
}

export interface DadosPropostaResult {
  httpStatus: number;
  /** Corpo como veio (`principal` + `parcelas[]`) — a tela formata. */
  dados: unknown;
}

/** GET consultarDadosProposta?nrProsp=N — detalhe completo (principal + parcelas). */
export async function consultarDadosProposta(
  token: string,
  nrProsp: number,
): Promise<DadosPropostaResult> {
  const url = new URL(dadosPropostaUrl());
  url.searchParams.set("nrProsp", String(nrProsp));
  const { httpStatus, json } = await getJsonLookup(token, url.toString());
  return { httpStatus, dados: json };
}

/* ------------------------------------------------------------------ */
/* Propostas — lookups de parâmetros (produto/convênio/filial)          */
/* ------------------------------------------------------------------ */

/** Opção genérica de lookup: código + descrição, direto da Sinqia. */
export interface LookupOption {
  codigo: number;
  descricao: string;
}

export interface LookupResult {
  httpStatus: number;
  options: LookupOption[];
}

async function getJsonLookup(token: string, url: string): Promise<{ httpStatus: number; json: unknown }> {
  const res = await request(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
    headersTimeout: env.REQUEST_TIMEOUT_MS,
    bodyTimeout: env.REQUEST_TIMEOUT_MS,
  });
  const { json } = await readJson(res);
  return { httpStatus: res.statusCode, json };
}

/**
 * GET consultarProdutosGeral?idCarctr=N[&cdConven=M] → [{cdProduto, dsProduto}].
 * Os produtos são configurados POR CONVÊNIO — o Portal sempre envia cdConven
 * junto (gravação do DevTools); sem ele a lista pode não trazer o produto certo.
 */
export async function listarProdutos(
  token: string,
  idCarctr: number,
  cdConven?: number,
): Promise<LookupResult> {
  const url = new URL(produtosUrl());
  url.searchParams.set("idCarctr", String(idCarctr));
  if (cdConven !== undefined) url.searchParams.set("cdConven", String(cdConven));
  const { httpStatus, json } = await getJsonLookup(token, url.toString());
  const produtos = (json as { produtos?: Array<Record<string, unknown>> } | null)?.produtos ?? [];
  return {
    httpStatus,
    options: produtos
      .map((p) => ({ codigo: Number(p.cdProduto), descricao: String(p.dsProduto ?? "") }))
      .filter((o) => Number.isFinite(o.codigo)),
  };
}

/**
 * Convênios como o PORTAL busca: consultarConvenioEmprestimosPorTpClacv com
 * tpClacv "C" e "P" (duas classificações), mesclados sem duplicar.
 * Resposta: {listEm32: [{id: {cdConv}, nmConv}]}; 204 = classificação vazia.
 */
export async function listarConvenios(token: string): Promise<LookupResult> {
  const buscar = async (tpClacv: string) => {
    const url = new URL(conveniosUrl());
    url.searchParams.set("tpClacv", tpClacv);
    const { httpStatus, json } = await getJsonLookup(token, url.toString());
    const lista =
      (json as { listEm32?: Array<Record<string, any>> } | null)?.listEm32 ?? [];
    return {
      httpStatus,
      options: lista
        .map((c) => ({ codigo: Number(c?.id?.cdConv), descricao: String(c?.nmConv ?? "") }))
        .filter((o) => Number.isFinite(o.codigo)),
    };
  };

  const [c, p] = await Promise.all([buscar("C"), buscar("P")]);
  if (c.httpStatus === 401 || p.httpStatus === 401) {
    return { httpStatus: 401, options: [] };
  }

  const porCodigo = new Map<number, LookupOption>();
  for (const o of [...c.options, ...p.options]) {
    if (!porCodigo.has(o.codigo)) porCodigo.set(o.codigo, o);
  }
  // 204 nas duas classificações = sem convênios; um 2xx qualquer = ok.
  const status =
    [c.httpStatus, p.httpStatus].find((s) => s >= 200 && s < 300) ??
    Math.max(c.httpStatus, p.httpStatus);
  return { httpStatus: status, options: [...porCodigo.values()].sort((a, b) => a.codigo - b.codigo) };
}

/**
 * Filiais (loja) como o PORTAL busca: consultarFilialByCdConv?cdConv=N.
 * Resposta: {sc22: [{id: {cdFilial}, nmFilial}]}; 204 = convênio sem filiais.
 */
export async function listarFiliais(token: string, codigoConvenio: number): Promise<LookupResult> {
  const url = new URL(filiaisUrl());
  url.searchParams.set("cdConv", String(codigoConvenio));
  const { httpStatus, json } = await getJsonLookup(token, url.toString());
  const lista = (json as { sc22?: Array<Record<string, any>> } | null)?.sc22 ?? [];
  return {
    httpStatus,
    options: lista
      .map((f) => ({ codigo: Number(f?.id?.cdFilial), descricao: String(f?.nmFilial ?? "") }))
      .filter((o) => Number.isFinite(o.codigo)),
  };
}

/* ------------------------------------------------------------------ */
/* Propostas — busca de cliente por CPF                                 */
/* ------------------------------------------------------------------ */

export interface BuscarClienteResult {
  httpStatus: number;
  /** false = HTTP 204 (a Sinqia não conhece esse CPF). */
  encontrado: boolean;
  /** nrClient CADASTRADO na Sinqia (para conferir com o derivado do ID_Sinqia). */
  nrClient: number | null;
  dsNome: string;
}

/** Extrai os campos que interessam do XML do buscarCliente (sem parser pesado). */
export function parseBuscarClienteXml(xml: string): { nrClient: number | null; dsNome: string } {
  const nr = xml.match(/<nrClient>(\d+)<\/nrClient>/)?.[1];
  const nome = xml.match(/<dsNome>([^<]*)<\/dsNome>/)?.[1] ?? "";
  return { nrClient: nr ? Number(nr) : null, dsNome: nome.trim() };
}

/**
 * GET buscarCliente — o parâmetro se chama `nrClient` mas recebe o CPF
 * (comportamento observado na collection e confirmado em HML). A resposta de
 * sucesso vem em XML (<fichaCadastralCliente><cliente>...); 204 = não existe.
 */
export async function buscarClientePorCpf(
  token: string,
  cpf: string,
): Promise<BuscarClienteResult> {
  const url = new URL(buscarClienteUrl());
  url.searchParams.set("nrClient", cpf);

  const res = await request(url.toString(), {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
    headersTimeout: env.REQUEST_TIMEOUT_MS,
    bodyTimeout: env.REQUEST_TIMEOUT_MS,
  });
  const text = await res.body.text().catch(() => "");

  if (res.statusCode === 204) {
    return { httpStatus: 204, encontrado: false, nrClient: null, dsNome: "" };
  }
  if (res.statusCode >= 200 && res.statusCode < 300) {
    const { nrClient, dsNome } = parseBuscarClienteXml(text);
    return { httpStatus: res.statusCode, encontrado: nrClient !== null, nrClient, dsNome };
  }
  return { httpStatus: res.statusCode, encontrado: false, nrClient: null, dsNome: "" };
}

/* ------------------------------------------------------------------ */
/* Propostas — criação (cadastrarProposta)                              */
/* ------------------------------------------------------------------ */

export interface CadastrarPropostaResult {
  httpStatus: number;
  envelope: SinqiaEnvelope | null;
  analysis: EnvelopeAnalysis;
  /** Nº da proposta gerado pela Sinqia, quando identificável na resposta. */
  nrProsp: string | null;
  rawBody?: string;
}

/**
 * Procura o nº da proposta gerado.
 *
 * Comportamento REAL observado em HML (lote de 67 em 2026-08-05): o número vem
 * na mensagem de consistência com type "Sucesso" — ex.: `Sucesso | 2585` —
 * exatamente como o cadastro de cliente devolve o código do cliente. O campo
 * `id` do envelope NÃO é o nº da proposta (veio 3 para todas as linhas).
 */
export function extrairNrProsp(envelope: SinqiaEnvelope | null, text: string): string | null {
  const sucesso = envelope?.messages?.find(
    (m) => /sucesso/i.test(m.type ?? "") && /^\d+$/.test((m.message ?? "").trim()),
  );
  if (sucesso) return (sucesso.message ?? "").trim();

  const direto = (envelope as Record<string, unknown> | null)?.["nrProsp"];
  if (direto !== undefined && direto !== null && direto !== "" && direto !== 0) {
    return String(direto);
  }
  const m =
    text.match(/"nrProsp"\s*:\s*"?(\d+)"?/) ?? text.match(/<nrProsp>(\d+)<\/nrProsp>/);
  return m ? m[1] : null;
}

/** POST cadastrarProposta — CRIA a proposta (irreversível). Sem retry aqui. */
export async function cadastrarProposta(
  token: string,
  body: unknown,
): Promise<CadastrarPropostaResult> {
  const res = await request(propostaUrl(), {
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
  return {
    httpStatus: res.statusCode,
    envelope,
    analysis,
    nrProsp: extrairNrProsp(envelope, text),
    rawBody,
  };
}

/* ------------------------------------------------------------------ */
/* Propostas — cálculo (calcProsp)                                      */
/* ------------------------------------------------------------------ */

export interface CalcProspResult {
  httpStatus: number;
  /** Bloco `calculo` validado — null quando a chamada falhou. */
  calculo: CalcProspCalculo | null;
  /** Mensagens de consistência quando a Sinqia recusa (envelope padrão). */
  analysis: EnvelopeAnalysis;
  rawBody?: string;
}

/**
 * POST calcProsp — SOMENTE cálculo, nada é persistido na Sinqia.
 * Sucesso vem como `{ calculo: {...} }` (shape capturado em HML); erro vem no
 * envelope padrão (status/globalMessage/messages) como nos demais serviços.
 */
export async function calcProsp(
  token: string,
  body: CalcProspRequest,
): Promise<CalcProspResult> {
  const res = await request(calcProspUrl(), {
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

  // Caminho feliz: { calculo: {...} }.
  if (res.statusCode >= 200 && res.statusCode < 300 && json) {
    const parsed = calcProspResponseSchema.safeParse(json);
    if (parsed.success) {
      return {
        httpStatus: res.statusCode,
        calculo: parsed.data.calculo,
        analysis: analyzeEnvelope(res.statusCode, null),
      };
    }
  }

  // Falha: tenta ler o envelope padrão para extrair as mensagens.
  let envelope: SinqiaEnvelope | null = null;
  if (json) {
    const parsed = sinqiaEnvelopeSchema.safeParse(json);
    envelope = parsed.success ? parsed.data : (json as SinqiaEnvelope);
  }
  const analysis = analyzeEnvelope(res.statusCode, envelope);
  return {
    httpStatus: res.statusCode,
    calculo: null,
    analysis: analysis.ok
      ? { ...analysis, ok: false, reason: "Resposta sem o bloco `calculo` esperado." }
      : analysis,
    rawBody: rawBody ?? (json ? JSON.stringify(json).slice(0, 2000) : undefined),
  };
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
