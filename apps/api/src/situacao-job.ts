import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { situacaoLabel } from "@cadastro-lote/shared";
import { alterarSituacaoCliente } from "./sinqia-client.js";
import { destroySession } from "./session.js";
import { env } from "./env.js";

/**
 * Alteração de situação em lote.
 *
 * Mesmas políticas do lote de cadastro: token vindo da sessão, processamento
 * sequencial e retry leve em 5xx/timeout. O resultado por linha sai da análise
 * do envelope, não do HTTP.
 *
 * 401 aborta o job (sem relogin — o backend não guarda a senha) e o que sobrou
 * fica como NAO_ENVIADO.
 *
 * Vive separado de batch.ts de propósito: são jobs de domínios diferentes e o
 * caminho de cadastro já está validado em HML — não vale acoplá-los.
 */

const DETALHE_SESSAO_EXPIRADA =
  "Sessão expirou antes deste cliente — entre novamente e reexecute os pendentes.";

/** Sinaliza 401 da Sinqia: a sessão morreu e o lote não pode continuar. */
class SessaoExpiradaError extends Error {
  constructor() {
    super(DETALHE_SESSAO_EXPIRADA);
    this.name = "SessaoExpiradaError";
  }
}

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
  /** NAO_ENVIADO = sessão expirou antes de tentar este cliente. */
  status: "OK" | "ERRO" | "NAO_ENVIADO";
  httpStatus: number | null;
  envelopeStatus?: string;
  globalMessage?: string;
  messages: string;
  detail?: string;
}

export interface SituacaoJobState {
  id: string;
  /** Sessão dona do job — o SSE recusa quem não é o dono. */
  sessionId: string;
  total: number;
  processed: number;
  success: number;
  error: number;
  /** Clientes não tentados por expiração de sessão. */
  naoEnviado: number;
  done: boolean;
  results: SituacaoRowResult[];
  startedAt: number;
}

interface SituacaoJobInput {
  alvos: SituacaoAlvo[];
  cdSituacao: number;
  /** Token da sessão. O job não conhece usuário nem senha. */
  token: string;
  sessionId: string;
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
    naoEnviado: state.naoEnviado,
    done: state.done,
  };
}

/** Cria o job e dispara o processamento. Retorna o jobId imediatamente. */
export function startSituacaoJob(input: SituacaoJobInput): string {
  const id = randomUUID();
  const state: SituacaoJobState = {
    id,
    sessionId: input.sessionId,
    total: input.alvos.length,
    processed: 0,
    success: 0,
    error: 0,
    naoEnviado: 0,
    done: false,
    results: [],
    startedAt: Date.now(),
  };
  jobs.set(id, state);
  emitters.set(id, new EventEmitter());
  pruneOldJobs();

  // Não await — o token vive só no closure durante o processamento.
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
      naoEnviado: state.naoEnviado,
    });

  for (let i = 0; i < input.alvos.length; i++) {
    const alvo = input.alvos[i];
    const meta = {
      nrCliente: alvo.nrCliente,
      nome: alvo.nome,
      documento: alvo.documento,
      situacaoAnterior: alvo.situacaoAnterior,
      situacaoNova,
    };

    let result: SituacaoRowResult;
    try {
      result = await sendWithPolicies(input.token, input.cdSituacao, alvo.nrCliente, meta);
    } catch (e) {
      if (e instanceof SessaoExpiradaError) {
        destroySession(input.sessionId);
        for (const pendente of input.alvos.slice(i)) {
          const naoEnviada: SituacaoRowResult = {
            nrCliente: pendente.nrCliente,
            nome: pendente.nome,
            documento: pendente.documento,
            situacaoAnterior: pendente.situacaoAnterior,
            situacaoNova,
            status: "NAO_ENVIADO",
            httpStatus: null,
            messages: "",
            detail: DETALHE_SESSAO_EXPIRADA,
          };
          state.results.push(naoEnviada);
          state.naoEnviado++;
          state.processed++;
          emit(id, "row", naoEnviada);
        }
        emitProgress();
        state.done = true;
        emit(id, "sessao-expirada", { message: DETALHE_SESSAO_EXPIRADA });
        emit(id, "done", snapshot(state));
        return;
      }
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

/**
 * Envia UMA alteração aplicando retry leve (5xx/timeout).
 * 401 lança `SessaoExpiradaError` — quem decide é o laço do job.
 */
async function sendWithPolicies(
  token: string,
  cdSituacao: number,
  nrCliente: number,
  meta: Meta,
): Promise<SituacaoRowResult> {
  const maxAttempts = env.RETRY_COUNT + 1;
  let lastError: string | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const { httpStatus, analysis } = await alterarSituacaoCliente(token, {
        cdSituacao,
        nrCliente,
      });

      if (httpStatus === 401) throw new SessaoExpiradaError();

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
      // Sessão expirada não é erro transitório — não faz sentido repetir.
      if (e instanceof SessaoExpiradaError) throw e;
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
