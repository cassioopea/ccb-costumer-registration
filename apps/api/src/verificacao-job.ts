import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { buscarClientePorCpf } from "./sinqia-client.js";
import { destroySession } from "./session.js";
import { env } from "./env.js";

/**
 * Verificação de clientes do Emissoes na Sinqia (somente leitura).
 *
 * Para cada linha: buscarCliente por CPF → o cliente existe? o nrClient
 * cadastrado bate com o derivado do ID_Sinqia ("333-6" → 3336)?
 *
 * ATENÇÃO ambiente: os tomadores do Emissoes são clientes de PRODUÇÃO — em
 * HML a resposta esperada é "não encontrado" para todos. O check ganha valor
 * real quando a ferramenta apontar para produção.
 */

const DETALHE_SESSAO_EXPIRADA =
  "Sessão expirou antes desta linha — entre novamente e verifique as pendentes.";

class SessaoExpiradaError extends Error {
  constructor() {
    super(DETALHE_SESSAO_EXPIRADA);
    this.name = "SessaoExpiradaError";
  }
}

export interface VerificacaoAlvo {
  linha: number;
  nome: string;
  cpf: string;
  /** nrClient derivado do ID_Sinqia da planilha. */
  nrClient: number | null;
}

export interface VerificacaoRowResult {
  linha: number;
  nome: string;
  cpf: string;
  nrClientPlanilha: number | null;
  nrClientSinqia: number | null;
  nomeSinqia: string;
  /**
   * ENCONTRADO   = existe e o nrClient bate com a planilha;
   * DIVERGE      = existe, mas com outro nrClient (planilha desatualizada?);
   * NAO_ENCONTRADO = a Sinqia não conhece o CPF (bloqueia a criação na Fase 3);
   * ERRO         = falha de comunicação/HTTP.
   */
  status: "ENCONTRADO" | "DIVERGE" | "NAO_ENCONTRADO" | "ERRO" | "NAO_ENVIADO";
  httpStatus: number | null;
  detail?: string;
}

export interface VerificacaoJobState {
  id: string;
  sessionId: string;
  total: number;
  processed: number;
  /** encontrados com nrClient batendo. */
  success: number;
  diverge: number;
  /** não encontrados na Sinqia. */
  naoEncontrado: number;
  error: number;
  naoEnviado: number;
  done: boolean;
  results: VerificacaoRowResult[];
  startedAt: number;
}

interface VerificacaoJobInput {
  alvos: VerificacaoAlvo[];
  token: string;
  sessionId: string;
}

const jobs = new Map<string, VerificacaoJobState>();
const emitters = new Map<string, EventEmitter>();
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

export function getVerificacaoJob(id: string): VerificacaoJobState | undefined {
  return jobs.get(id);
}

export function getVerificacaoEmitter(id: string): EventEmitter | undefined {
  return emitters.get(id);
}

function emit(id: string, event: string, data: unknown) {
  emitters.get(id)?.emit("progress", { event, data });
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function snapshot(state: VerificacaoJobState) {
  return {
    id: state.id,
    total: state.total,
    processed: state.processed,
    success: state.success,
    diverge: state.diverge,
    naoEncontrado: state.naoEncontrado,
    error: state.error,
    naoEnviado: state.naoEnviado,
    done: state.done,
  };
}

export function startVerificacaoJob(input: VerificacaoJobInput): string {
  const id = randomUUID();
  const state: VerificacaoJobState = {
    id,
    sessionId: input.sessionId,
    total: input.alvos.length,
    processed: 0,
    success: 0,
    diverge: 0,
    naoEncontrado: 0,
    error: 0,
    naoEnviado: 0,
    done: false,
    results: [],
    startedAt: Date.now(),
  };
  jobs.set(id, state);
  emitters.set(id, new EventEmitter());
  pruneOldJobs();

  void processJob(id, input);
  return id;
}

async function processJob(id: string, input: VerificacaoJobInput) {
  const state = jobs.get(id)!;

  const emitProgress = () =>
    emit(id, "progress", {
      processed: state.processed,
      total: state.total,
      success: state.success,
      diverge: state.diverge,
      naoEncontrado: state.naoEncontrado,
      error: state.error,
      naoEnviado: state.naoEnviado,
    });

  for (let i = 0; i < input.alvos.length; i++) {
    const alvo = input.alvos[i];

    let result: VerificacaoRowResult;
    try {
      result = await verificarComPoliticas(input.token, alvo);
    } catch (e) {
      if (e instanceof SessaoExpiradaError) {
        destroySession(input.sessionId);
        for (const pendente of input.alvos.slice(i)) {
          const naoEnviada: VerificacaoRowResult = {
            linha: pendente.linha,
            nome: pendente.nome,
            cpf: pendente.cpf,
            nrClientPlanilha: pendente.nrClient,
            nrClientSinqia: null,
            nomeSinqia: "",
            status: "NAO_ENVIADO",
            httpStatus: null,
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
        linha: alvo.linha,
        nome: alvo.nome,
        cpf: alvo.cpf,
        nrClientPlanilha: alvo.nrClient,
        nrClientSinqia: null,
        nomeSinqia: "",
        status: "ERRO",
        httpStatus: null,
        detail: (e as Error).message,
      };
    }

    if (result.status === "ENCONTRADO") state.success++;
    else if (result.status === "DIVERGE") state.diverge++;
    else if (result.status === "NAO_ENCONTRADO") state.naoEncontrado++;
    else state.error++;

    state.results.push(result);
    state.processed++;
    emit(id, "row", result);
    emitProgress();
  }

  state.done = true;
  emit(id, "done", snapshot(state));
}

async function verificarComPoliticas(
  token: string,
  alvo: VerificacaoAlvo,
): Promise<VerificacaoRowResult> {
  const maxAttempts = env.RETRY_COUNT + 1;
  let lastError: string | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await buscarClientePorCpf(token, alvo.cpf);

      if (res.httpStatus === 401) throw new SessaoExpiradaError();

      if (res.httpStatus >= 500 && attempt < maxAttempts) {
        lastError = `HTTP ${res.httpStatus}`;
        await delay(500 * attempt);
        continue;
      }

      const base = {
        linha: alvo.linha,
        nome: alvo.nome,
        cpf: alvo.cpf,
        nrClientPlanilha: alvo.nrClient,
        nrClientSinqia: res.nrClient,
        nomeSinqia: res.dsNome,
        httpStatus: res.httpStatus,
      };

      if (!res.encontrado) {
        return {
          ...base,
          status: res.httpStatus === 204 ? "NAO_ENCONTRADO" : "ERRO",
          detail:
            res.httpStatus === 204
              ? "CPF não cadastrado na Sinqia (neste ambiente)."
              : `HTTP ${res.httpStatus} ao buscar o cliente.`,
        };
      }

      if (alvo.nrClient !== null && res.nrClient === alvo.nrClient) {
        return { ...base, status: "ENCONTRADO" };
      }
      return {
        ...base,
        status: "DIVERGE",
        detail: `Planilha diz nrClient ${alvo.nrClient ?? "—"}; a Sinqia tem ${res.nrClient}.`,
      };
    } catch (e) {
      if (e instanceof SessaoExpiradaError) throw e;
      lastError = (e as Error).message;
      if (attempt < maxAttempts) {
        await delay(500 * attempt);
        continue;
      }
    }
  }

  return {
    linha: alvo.linha,
    nome: alvo.nome,
    cpf: alvo.cpf,
    nrClientPlanilha: alvo.nrClient,
    nrClientSinqia: null,
    nomeSinqia: "",
    status: "ERRO",
    httpStatus: null,
    detail: lastError ?? "Falha após tentativas.",
  };
}
