import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { BatchControl, Cliente } from "@cadastro-lote/shared";
import { buildRequest } from "./parse-input.js";
import { cadastrarCliente, login } from "./sinqia-client.js";
import { env } from "./env.js";

/**
 * Orquestração do lote:
 *  - login uma vez, reusa o token;
 *  - processa sequencialmente (1 por vez), continua em caso de erro;
 *  - HTTP 401 no meio → relogin automático + reenvio da linha 1x;
 *  - retry leve (RETRY_COUNT) para erros transitórios (timeout/5xx);
 *  - OK/ERRO decidido pela análise do envelope, não só pelo HTTP.
 */

export interface RowResult {
  index: number;
  nome: string;
  documento: string;
  tipo: "PF" | "PJ" | "?";
  /** OK = cadastrado; ERRO = recusado pela Sinqia; PULADO = reprovado na validação, não enviado. */
  status: "OK" | "ERRO" | "PULADO";
  httpStatus: number | null;
  envelopeStatus?: string;
  globalMessage?: string;
  messages: string;
  detail?: string;
}

export interface JobState {
  id: string;
  total: number;
  processed: number;
  success: number;
  error: number;
  skipped: number;
  done: boolean;
  results: RowResult[];
  startedAt: number;
}

/** Uma linha do lote, já com metadados e erros de validação. */
export interface JobItem {
  index: number;
  nome: string;
  documento: string;
  tipo: "PF" | "PJ" | "?";
  cliente: Cliente;
  errors: string[];
}

interface JobInput {
  items: JobItem[];
  control: BatchControl;
  username: string;
  password: string;
}

const jobs = new Map<string, JobState>();
const emitters = new Map<string, EventEmitter>();

/**
 * Retenção: os resultados contêm dados pessoais (nome/CPF). Mantém só os
 * últimos jobs concluídos em memória; os antigos são descartados.
 */
const MAX_FINISHED_JOBS = 10;

function pruneOldJobs() {
  const finished = [...jobs.values()]
    .filter((j) => j.done)
    .sort((a, b) => a.startedAt - b.startedAt);
  while (finished.length > MAX_FINISHED_JOBS) {
    const oldest = finished.shift()!;
    jobs.delete(oldest.id);
    emitters.delete(oldest.id);
  }
}

export function getJob(id: string): JobState | undefined {
  return jobs.get(id);
}

export function getEmitter(id: string): EventEmitter | undefined {
  return emitters.get(id);
}

function emit(id: string, event: string, data: unknown) {
  emitters.get(id)?.emit("progress", { event, data });
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Cria o job e dispara o processamento assíncrono. Retorna o jobId imediatamente. */
export function startJob(input: JobInput): string {
  const id = randomUUID();
  const state: JobState = {
    id,
    total: input.items.length,
    processed: 0,
    success: 0,
    error: 0,
    skipped: 0,
    done: false,
    results: [],
    startedAt: Date.now(),
  };
  jobs.set(id, state);
  emitters.set(id, new EventEmitter());
  pruneOldJobs();

  // Não await — roda em background. As credenciais vivem apenas no closure
  // de `input` durante o processamento (nunca em store nem em log).
  void processJob(id, input);

  return id;
}

async function processJob(id: string, input: JobInput) {
  const state = jobs.get(id)!;
  const { items, control } = input;

  const emitProgress = () =>
    emit(id, "progress", {
      processed: state.processed,
      total: state.total,
      success: state.success,
      error: state.error,
      skipped: state.skipped,
    });

  const validCount = items.filter((it) => it.errors.length === 0).length;

  // Só faz login se houver ao menos uma linha válida para enviar.
  let token = "";
  if (validCount > 0) {
    try {
      token = await login(input.username, input.password);
    } catch (e) {
      // Falha de login aborta o lote inteiro.
      state.done = true;
      emit(id, "fatal", { message: (e as Error).message });
      emit(id, "done", snapshot(state));
      return;
    }
  }

  for (const item of items) {
    const meta = {
      index: item.index,
      nome: item.nome,
      documento: item.documento,
      tipo: item.tipo,
    };

    let result: RowResult;

    // Linha inválida: PULADA (não enviada à Sinqia).
    if (item.errors.length > 0) {
      result = {
        ...meta,
        status: "PULADO",
        httpStatus: null,
        messages: item.errors.join(" ;; "),
        detail: "Reprovado na validação — linha não enviada à Sinqia.",
      };
      state.skipped++;
    } else {
      try {
        const body = buildRequest(item.cliente, control);
        result = await sendWithPolicies(id, () => token, (t) => (token = t), input, body, meta);
      } catch (e) {
        result = {
          ...meta,
          status: "ERRO",
          httpStatus: null,
          messages: "",
          detail: (e as Error).message,
        };
      }
      if (result.status === "OK") state.success++;
      else state.error++;
    }

    state.results.push(result);
    state.processed++;
    emit(id, "row", result);
    emitProgress();
  }

  state.done = true;
  emit(id, "done", snapshot(state));
}

type Meta = Pick<RowResult, "index" | "nome" | "documento" | "tipo">;

/**
 * Envia uma linha aplicando: retry leve (5xx/timeout) + relogin em 401.
 */
async function sendWithPolicies(
  id: string,
  getToken: () => string,
  setToken: (t: string) => void,
  input: JobInput,
  body: ReturnType<typeof buildRequest>,
  meta: Meta,
): Promise<RowResult> {
  const maxAttempts = env.RETRY_COUNT + 1;
  let reloggedOnce = false;
  let lastError: string | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const { httpStatus, analysis } = await cadastrarCliente(getToken(), body);

      // 401 → token pode ter expirado no meio do lote: relogar 1x e reenviar.
      if (httpStatus === 401 && !reloggedOnce) {
        reloggedOnce = true;
        try {
          setToken(await login(input.username, input.password));
          emit(id, "relogin", { index: meta.index });
          continue; // reenvia com token novo (não conta como retry de 5xx)
        } catch (e) {
          return {
            ...meta,
            status: "ERRO",
            httpStatus,
            messages: "",
            detail: `Falha ao relogar: ${(e as Error).message}`,
          };
        }
      }

      // 5xx → retry leve.
      if (httpStatus >= 500 && attempt < maxAttempts) {
        lastError = `HTTP ${httpStatus}`;
        await delay(500 * attempt);
        continue;
      }

      return {
        ...meta,
        status: analysis.ok ? "OK" : "ERRO",
        httpStatus,
        envelopeStatus: analysis.envelopeStatus,
        globalMessage: analysis.globalMessage,
        messages: analysis.messagesText,
        detail: analysis.ok ? undefined : analysis.reason,
      };
    } catch (e) {
      // Erro de rede/timeout → retry leve.
      lastError = (e as Error).message;
      if (attempt < maxAttempts) {
        await delay(500 * attempt);
        continue;
      }
    }
  }

  return {
    ...meta,
    status: "ERRO",
    httpStatus: null,
    messages: "",
    detail: lastError ?? "Falha após tentativas.",
  };
}

function snapshot(state: JobState) {
  return {
    id: state.id,
    total: state.total,
    processed: state.processed,
    success: state.success,
    error: state.error,
    skipped: state.skipped,
    done: state.done,
  };
}
