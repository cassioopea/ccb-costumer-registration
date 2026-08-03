// Cliente da API local. Usa caminhos relativos /api (proxy do Vite → backend).

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
  status: "OK" | "ERRO" | "PULADO";
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

function buildForm(
  file: File,
  username: string,
  password: string,
  control: BatchControlPayload,
): FormData {
  const fd = new FormData();
  fd.append("username", username);
  fd.append("password", password);
  fd.append("control", JSON.stringify(control));
  fd.append("file", file);
  return fd;
}

export async function validate(
  file: File,
  username: string,
  password: string,
  control: BatchControlPayload,
): Promise<ValidateResponse> {
  const res = await fetch("/api/validate", {
    method: "POST",
    body: buildForm(file, username, password, control),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json?.error ?? `Falha na validação (HTTP ${res.status}).`);
  return json;
}

export async function startImport(
  file: File,
  username: string,
  password: string,
  control: BatchControlPayload,
): Promise<{ jobId: string; total: number; validas: number; puladas: number; env: string }> {
  const res = await fetch("/api/import", {
    method: "POST",
    body: buildForm(file, username, password, control),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json?.error ?? `Falha ao iniciar o lote (HTTP ${res.status}).`);
  return json;
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
  }) => void;
  onRelogin?: (d: { index: number }) => void;
  onFatal?: (d: { message: string }) => void;
  onDone?: (d: { total: number; success: number; error: number }) => void;
  onError?: (e: Event) => void;
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
  username: string,
  password: string,
  tipoPessoa?: string,
): Promise<TodosClientesResponse> {
  const res = await fetch("/api/clientes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password, tipoPessoa }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json?.error ?? `Falha ao listar clientes (HTTP ${res.status}).`);
  return json;
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
  status: "OK" | "ERRO";
  httpStatus: number | null;
  envelopeStatus?: string;
  globalMessage?: string;
  messages: string;
  detail?: string;
}

export async function startAlterarSituacao(
  username: string,
  password: string,
  cdSituacao: number,
  alvos: SituacaoAlvo[],
): Promise<{ jobId: string; total: number; env: string }> {
  const res = await fetch("/api/situacao", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password, cdSituacao, alvos }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json?.error ?? `Falha ao iniciar a alteração (HTTP ${res.status}).`);
  return json;
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
  onProgress?: (p: { processed: number; total: number; success: number; error: number }) => void;
  onFatal?: (d: { message: string }) => void;
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
  on("relogin", handlers.onRelogin);
  on("fatal", handlers.onFatal);
  on("done", (d) => {
    handlers.onDone?.(d);
    es.close();
  });

  es.onerror = (e) => handlers.onError?.(e);

  return () => es.close();
}
