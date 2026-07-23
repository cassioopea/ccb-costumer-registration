// Cliente da API local. Usa caminhos relativos /api (proxy do Vite → backend).

export interface BatchControlInput {
  finalizar: boolean;
  idIntegracaoCadastro?: string;
  idRetConsistencias?: string;
  idBiometria?: string;
  idOrigemRequest?: string;
}

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
  control: BatchControlInput,
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
  control: BatchControlInput,
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
  control: BatchControlInput,
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
