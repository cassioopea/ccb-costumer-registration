import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { BatchControl, Cliente } from "@cadastro-lote/shared";
import { buildRequest } from "./parse-input.js";
import { cadastrarCliente } from "./sinqia-client.js";
import { destroySession } from "./session.js";
import { env } from "./env.js";

/**
 * Orquestração do lote:
 *  - usa o token da sessão (o login acontece uma vez, na tela de login);
 *  - processa sequencialmente (1 por vez), continua em caso de erro;
 *  - retry leve (RETRY_COUNT) para erros transitórios (timeout/5xx);
 *  - OK/ERRO decidido pela análise do envelope, não só pelo HTTP.
 *
 * HTTP 401 no meio do lote ABORTA o job. Não há relogin automático: o backend
 * não guarda a senha, e a Sinqia não tem refresh token. As linhas ainda não
 * tentadas ficam como NAO_ENVIADO — marcá-las ERRO seria mentira, elas não
 * foram recusadas por ninguém.
 */

/** Mensagem única para as linhas que o aborto de sessão deixou para trás. */
const DETALHE_SESSAO_EXPIRADA =
  "Sessão expirou antes desta linha — entre novamente e reexecute as pendentes.";

export interface RowResult {
  index: number;
  nome: string;
  documento: string;
  tipo: "PF" | "PJ" | "?";
  /**
   * OK = cadastrado; ERRO = recusado pela Sinqia; PULADO = reprovado na
   * validação, não enviado; NAO_ENVIADO = sessão expirou antes de tentar.
   */
  status: "OK" | "ERRO" | "PULADO" | "NAO_ENVIADO";
  httpStatus: number | null;
  envelopeStatus?: string;
  globalMessage?: string;
  messages: string;
  detail?: string;
}

export interface JobState {
  id: string;
  /** Sessão dona do job — o SSE recusa quem não é o dono. */
  sessionId: string;
  total: number;
  processed: number;
  success: number;
  error: number;
  skipped: number;
  /** Linhas não tentadas por expiração de sessão. */
  naoEnviado: number;
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
  /** Token da sessão. O job não conhece usuário nem senha. */
  token: string;
  sessionId: string;
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
    sessionId: input.sessionId,
    total: input.items.length,
    processed: 0,
    success: 0,
    error: 0,
    skipped: 0,
    naoEnviado: 0,
    done: false,
    results: [],
    startedAt: Date.now(),
  };
  jobs.set(id, state);
  emitters.set(id, new EventEmitter());
  pruneOldJobs();

  // Não await — roda em background. O token vive apenas no closure de `input`.
  void processJob(id, input);

  return id;
}

/** Sinaliza 401 da Sinqia: a sessão morreu e o lote não pode continuar. */
class SessaoExpiradaError extends Error {
  constructor() {
    super(DETALHE_SESSAO_EXPIRADA);
    this.name = "SessaoExpiradaError";
  }
}

async function processJob(id: string, input: JobInput) {
  const state = jobs.get(id)!;
  const { items, control, token } = input;

  const emitProgress = () =>
    emit(id, "progress", {
      processed: state.processed,
      total: state.total,
      success: state.success,
      error: state.error,
      skipped: state.skipped,
      naoEnviado: state.naoEnviado,
    });

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
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
        result = await sendWithPolicies(token, body, meta);
      } catch (e) {
        if (e instanceof SessaoExpiradaError) {
          // Sessão morta: invalida no store e encerra marcando o restante como
          // não tentado (desta linha, inclusive, até o fim).
          destroySession(input.sessionId);
          for (const pendente of items.slice(i)) {
            const naoEnviada: RowResult = {
              index: pendente.index,
              nome: pendente.nome,
              documento: pendente.documento,
              tipo: pendente.tipo,
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
 * Envia uma linha aplicando retry leve (5xx/timeout).
 *
 * 401 lança `SessaoExpiradaError` — sem a senha não há como relogar, então quem
 * decide o que fazer é o laço do job (abortar e marcar o resto NAO_ENVIADO).
 */
async function sendWithPolicies(
  token: string,
  body: ReturnType<typeof buildRequest>,
  meta: Meta,
): Promise<RowResult> {
  const maxAttempts = env.RETRY_COUNT + 1;
  let lastError: string | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const { httpStatus, analysis } = await cadastrarCliente(token, body);

      if (httpStatus === 401) throw new SessaoExpiradaError();

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
      // Sessão expirada não é erro transitório — não faz sentido repetir.
      if (e instanceof SessaoExpiradaError) throw e;
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
    naoEnviado: state.naoEnviado,
    done: state.done,
  };
}
