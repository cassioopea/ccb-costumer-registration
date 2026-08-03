// Cliente da API local. Usa caminhos relativos /api (proxy do Vite → backend).
//
// AUTENTICAÇÃO: nenhuma função aqui recebe usuário/senha. A sessão viaja no
// cookie httpOnly que o backend setou no login, enviado automaticamente pelo
// fetch e pelo EventSource (mesma origem, via proxy do Vite).

import { lerResposta } from "./session";

/** Ações aceitas pela Sinqia: Incluir / Alterar / Excluir / Consultar. */
export type IdAcao = "IN" | "AL" | "EX" | "CO";

/** Estado do formulário de controle do lote (com "" para "não escolhido"). */
export interface BatchControlInput {
  finalizar: boolean;
  /** "S" (default) integra automaticamente com o módulo de cadastro; "N" não integra. */
  idIntegracaoCadastro: "S" | "N";
  /** Ação aplicada a todas as linhas. "" = usar o que vier do arquivo. */
  idAcao: IdAcao | "";
  idRetConsistencias?: string;
  idBiometria?: string;
  idOrigemRequest?: string;
}

/**
 * Forma enviada ao backend: já sem os "" (campos não escolhidos são omitidos).
 * Ver `sanitizeControl` em CadastroLote.tsx.
 */
export type BatchControlPayload = Record<string, unknown>;

export interface ValidateRow {
  index: number;
  nome: string;
  documento: string;
  tipo: "PF" | "PJ" | "?";
  errors: string[];
}

export interface ValidateResponse {
  env: string;
  total: number;
  totalErros: number;
  valido: boolean;
  rows: ValidateRow[];
  preview: Array<{ index: number; payload?: unknown; error?: string }>;
}

export interface RowResult {
  index: number;
  nome: string;
  documento: string;
  tipo: "PF" | "PJ" | "?";
  /** NAO_ENVIADO = sessão expirou antes desta linha ser tentada. */
  status: "OK" | "ERRO" | "PULADO" | "NAO_ENVIADO";
  httpStatus: number | null;
  envelopeStatus?: string;
  globalMessage?: string;
  messages: string;
  detail?: string;
}

export interface EnvInfo {
  env: string;
  isProd: boolean;
  baseUrl: string;
}

export const TEMPLATE_URL = "/api/template.csv";

export async function getEnv(): Promise<EnvInfo> {
  const res = await fetch("/api/env");
  if (!res.ok) throw new Error("Não foi possível consultar o ambiente do backend.");
  return res.json();
}

function buildForm(file: File, control: BatchControlPayload): FormData {
  const fd = new FormData();
  fd.append("control", JSON.stringify(control));
  fd.append("file", file);
  return fd;
}

export async function validate(
  file: File,
  control: BatchControlPayload,
): Promise<ValidateResponse> {
  const res = await fetch("/api/validate", {
    method: "POST",
    body: buildForm(file, control),
  });
  return lerResposta<ValidateResponse>(res, "Falha na validação");
}

export async function startImport(
  file: File,
  control: BatchControlPayload,
): Promise<{ jobId: string; total: number; validas: number; puladas: number; env: string }> {
  const res = await fetch("/api/import", {
    method: "POST",
    body: buildForm(file, control),
  });
  return lerResposta(res, "Falha ao iniciar o lote");
}

export interface StreamHandlers {
  onSnapshot?: (data: {
    total: number;
    processed: number;
    success: number;
    error: number;
    skipped: number;
    results: RowResult[];
    done: boolean;
  }) => void;
  onRow?: (row: RowResult) => void;
  onProgress?: (p: {
    processed: number;
    total: number;
    success: number;
    error: number;
    skipped: number;
    naoEnviado?: number;
  }) => void;
  /** Sessão morreu no meio: o restante ficou como NAO_ENVIADO. */
  onSessaoExpirada?: (d: { message: string }) => void;
  onFatal?: (d: { message: string }) => void;
  onDone?: (d: { total: number; success: number; error: number }) => void;
  onError?: (e: Event) => void;
}

/* ------------------------------------------------------------------ */
/* Cadastro individual                                                 */
/* ------------------------------------------------------------------ */

export interface CamposObrigatoriosResponse {
  httpStatus: number;
  /** Caminhos achatados exigidos pela Sinqia. */
  paths: string[];
  formato: "lista-strings" | "lista-objetos" | "modelo-cliente" | "desconhecido" | "sem-registro";
  /** Corpo cru — exibido na tela enquanto o formato real não está confirmado. */
  bruto?: unknown;
  rawBody?: string;
}

/** Consulta os campos obrigatórios do cadastro (GET, somente leitura). */
export async function getCamposObrigatorios(): Promise<CamposObrigatoriosResponse> {
  const res = await fetch("/api/campos-obrigatorios");
  return lerResposta<CamposObrigatoriosResponse>(res, "Falha ao consultar campos obrigatórios");
}

export interface CadastrarUmResponse {
  env: string;
  /** false = reprovou na validação local; `errors` traz os motivos por campo. */
  valido: boolean;
  errors?: string[];
  tipo: "PF" | "PJ" | "?";
  dryRun?: boolean;
  /** Payload montado — só no dry-run. */
  payload?: unknown;
  status?: "OK" | "ERRO";
  httpStatus?: number;
  envelopeStatus?: string;
  globalMessage?: string;
  messages?: string;
  detail?: string;
}

/**
 * Valida (e opcionalmente cadastra) UM cliente a partir do formulário.
 * `campos` é o mapa achatado, igual a uma linha de CSV.
 */
export async function cadastrarUm(
  campos: Record<string, string>,
  control: BatchControlPayload,
  dryRun: boolean,
): Promise<CadastrarUmResponse> {
  const res = await fetch("/api/cadastrar", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ campos, control, dryRun }),
  });
  return lerResposta<CadastrarUmResponse>(res, "Falha no cadastro");
}

/* ------------------------------------------------------------------ */
/* Situação de cliente                                                 */
/* ------------------------------------------------------------------ */

export interface ClienteResumo {
  nrCliente: number | null;
  nome: string;
  documento: string;
  tipoPessoa: string;
  cdSituacao: number | null;
  dsSituacao: string;
  raw: Record<string, unknown>;
}

export interface TodosClientesResponse {
  env: string;
  items: ClienteResumo[];
  /** Bateu no teto do backend — a lista pode estar incompleta. */
  truncado: boolean;
  paginas: number;
  totalElements: number | null;
  /** Presente quando a Sinqia devolveu algo que não era JSON. */
  rawBody?: string;
}

/**
 * Carrega TODOS os clientes de uma vez (o backend varre as páginas).
 * O filtro por número/nome/documento acontece localmente sobre esse conjunto.
 */
export async function listarTodosClientes(
  tipoPessoa?: string,
): Promise<TodosClientesResponse> {
  const res = await fetch("/api/clientes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tipoPessoa }),
  });
  return lerResposta<TodosClientesResponse>(res, "Falha ao listar clientes");
}

export interface SituacaoAlvo {
  nrCliente: number;
  nome: string;
  documento: string;
  situacaoAnterior: string;
}

export interface SituacaoRowResult {
  nrCliente: number;
  nome: string;
  documento: string;
  situacaoAnterior: string;
  situacaoNova: string;
  /** NAO_ENVIADO = sessão expirou antes deste cliente ser tentado. */
  status: "OK" | "ERRO" | "NAO_ENVIADO";
  httpStatus: number | null;
  envelopeStatus?: string;
  globalMessage?: string;
  messages: string;
  detail?: string;
}

export async function startAlterarSituacao(
  cdSituacao: number,
  alvos: SituacaoAlvo[],
): Promise<{ jobId: string; total: number; env: string }> {
  const res = await fetch("/api/situacao", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cdSituacao, alvos }),
  });
  return lerResposta(res, "Falha ao iniciar a alteração");
}

export interface SituacaoStreamHandlers {
  onSnapshot?: (d: {
    total: number;
    processed: number;
    success: number;
    error: number;
    results: SituacaoRowResult[];
    done: boolean;
  }) => void;
  onRow?: (row: SituacaoRowResult) => void;
  onProgress?: (p: {
    processed: number;
    total: number;
    success: number;
    error: number;
    naoEnviado?: number;
  }) => void;
  onFatal?: (d: { message: string }) => void;
  /** Sessão morreu no meio: o restante ficou como NAO_ENVIADO. */
  onSessaoExpirada?: (d: { message: string }) => void;
  onDone?: (d: { total: number; success: number; error: number }) => void;
  onError?: (e: Event) => void;
}

/** Abre o SSE de progresso da alteração de situação. Retorna função para fechar. */
export function streamSituacao(jobId: string, handlers: SituacaoStreamHandlers): () => void {
  const es = new EventSource(`/api/situacao/stream/${jobId}`);

  const on = (name: string, cb?: (d: any) => void) => {
    if (!cb) return;
    es.addEventListener(name, (ev) => {
      try {
        cb(JSON.parse((ev as MessageEvent).data));
      } catch {
        /* ignora payload malformado */
      }
    });
  };

  on("snapshot", handlers.onSnapshot);
  on("row", handlers.onRow);
  on("progress", handlers.onProgress);
  on("fatal", handlers.onFatal);
  on("sessao-expirada", handlers.onSessaoExpirada);
  on("done", (d) => {
    handlers.onDone?.(d);
    es.close();
  });

  es.onerror = (e) => handlers.onError?.(e);

  return () => es.close();
}

/** Abre o SSE de progresso. Retorna uma função para fechar. */
export function streamImport(jobId: string, handlers: StreamHandlers): () => void {
  const es = new EventSource(`/api/import/stream/${jobId}`);

  const on = (name: string, cb?: (d: any) => void) => {
    if (!cb) return;
    es.addEventListener(name, (ev) => {
      try {
        cb(JSON.parse((ev as MessageEvent).data));
      } catch {
        /* ignora payload malformado */
      }
    });
  };

  on("snapshot", handlers.onSnapshot);
  on("row", handlers.onRow);
  on("progress", handlers.onProgress);
  on("sessao-expirada", handlers.onSessaoExpirada);
  on("fatal", handlers.onFatal);
  on("done", (d) => {
    handlers.onDone?.(d);
    es.close();
  });

  es.onerror = (e) => handlers.onError?.(e);

  return () => es.close();
}
