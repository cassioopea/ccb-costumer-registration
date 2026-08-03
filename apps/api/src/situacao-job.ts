import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { situacaoLabel } from "@cadastro-lote/shared";
import { alterarSituacaoCliente, login } from "./sinqia-client.js";
import { env } from "./env.js";

/**
 * Alteração de situação em lote.
 *
 * Mesmas políticas do lote de cadastro: login uma vez, processamento
 * sequencial, relogin automático em 401 e retry leve em 5xx/timeout. O
 * resultado por linha sai da análise do envelope, não do HTTP.
 *
 * Vive separado de batch.ts de propósito: são jobs de domínios diferentes e o
 * caminho de cadastro já está validado em HML — não vale acoplá-los.
 */

export interface SituacaoAlvo {
  nrCliente: number;
  nome: string;
  documento: string;
  /** Situação antes da alteração, só para o relatório. */
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

export interface SituacaoJobState {
  id: string;
  total: number;
  processed: number;
  success: number;
  error: number;
  done: boolean;
  results: SituacaoRowResult[];
  startedAt: number;
}

interface SituacaoJobInput {
  alvos: SituacaoAlvo[];
  cdSituacao: number;
  username: string;
  password: string;
}

const jobs = new Map<string, SituacaoJobState>();
const emitters = new Map<string, EventEmitter>();

/** Resultados carregam nome/CPF — retém só os últimos jobs, como no cadastro. */
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

export function getSituacaoJob(id: string): SituacaoJobState | undefined {
  return jobs.get(id);
}

export function getSituacaoEmitter(id: string): EventEmitter | undefined {
  return emitters.get(id);
}

function emit(id: string, event: string, data: unknown) {
  emitters.get(id)?.emit("progress", { event, data });
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function snapshot(state: SituacaoJobState) {
  return {
    id: state.id,
    total: state.total,
    processed: state.processed,
    success: state.success,
    error: state.error,
    done: state.done,
  };
}

/** Cria o job e dispara o processamento. Retorna o jobId imediatamente. */
export function startSituacaoJob(input: SituacaoJobInput): string {
  const id = randomUUID();
  const state: SituacaoJobState = {
    id,
    total: input.alvos.length,
    processed: 0,
    success: 0,
    error: 0,
    done: false,
    results: [],
    startedAt: Date.now(),
  };
  jobs.set(id, state);
  emitters.set(id, new EventEmitter());
  pruneOldJobs();

  // Não await — as credenciais vivem só no closure durante o processamento.
  void processJob(id, input);

  return id;
}

async function processJob(id: string, input: SituacaoJobInput) {
  const state = jobs.get(id)!;
  const situacaoNova = situacaoLabel(input.cdSituacao);

  const emitProgress = () =>
    emit(id, "progress", {
      processed: state.processed,
      total: state.total,
      success: state.success,
      error: state.error,
    });

  let token = "";
  try {
    token = await login(input.username, input.password);
  } catch (e) {
    state.done = true;
    emit(id, "fatal", { message: (e as Error).message });
    emit(id, "done", snapshot(state));
    return;
  }

  for (const alvo of input.alvos) {
    const meta = {
      nrCliente: alvo.nrCliente,
      nome: alvo.nome,
      documento: alvo.documento,
      situacaoAnterior: alvo.situacaoAnterior,
      situacaoNova,
    };

    let result: SituacaoRowResult;
    try {
      result = await sendWithPolicies(
        id,
        () => token,
        (t) => (token = t),
        input,
        alvo.nrCliente,
        meta,
      );
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

    state.results.push(result);
    state.processed++;
    emit(id, "row", result);
    emitProgress();
  }

  state.done = true;
  emit(id, "done", snapshot(state));
}

type Meta = Pick<
  SituacaoRowResult,
  "nrCliente" | "nome" | "documento" | "situacaoAnterior" | "situacaoNova"
>;

/** Envia UMA alteração aplicando retry leve (5xx/timeout) + relogin em 401. */
async function sendWithPolicies(
  id: string,
  getToken: () => string,
  setToken: (t: string) => void,
  input: SituacaoJobInput,
  nrCliente: number,
  meta: Meta,
): Promise<SituacaoRowResult> {
  const maxAttempts = env.RETRY_COUNT + 1;
  let reloggedOnce = false;
  let lastError: string | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const { httpStatus, analysis } = await alterarSituacaoCliente(getToken(), {
        cdSituacao: input.cdSituacao,
        nrCliente,
      });

      if (httpStatus === 401 && !reloggedOnce) {
        reloggedOnce = true;
        try {
          setToken(await login(input.username, input.password));
          emit(id, "relogin", { nrCliente });
          continue;
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
