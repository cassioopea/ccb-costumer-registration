import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { transferirStatus } from "./sinqia-client.js";
import { registrarEvento } from "./db.js";
import { destroySession } from "./session.js";

/**
 * Transferência de status EM LOTE — move várias propostas da mesma fila para
 * o mesmo destino, uma requisição transfStatus por proposta (a Sinqia não tem
 * operação em lote). Mesmas políticas dos outros jobs de escrita: sequencial,
 * SEM retry (transfStatus não é idempotente), 401 aborta e marca o restante
 * como NAO_ENVIADO.
 */

const DETALHE_SESSAO_EXPIRADA =
  "Sessão expirou antes desta proposta — entre novamente e mova as pendentes.";

export interface TransferenciaItem {
  nrProsp: number;
  nrCpf: string;
  nmCliente: string;
  cdProd: number;
  nrContra: number;
}

export interface TransferenciaRowResult {
  nrProsp: number;
  nmCliente: string;
  status: "OK" | "ERRO" | "NAO_ENVIADO";
  detalhe: string;
}

export interface TransferenciaJobState {
  id: string;
  sessionId: string;
  total: number;
  processed: number;
  success: number;
  error: number;
  naoEnviado: number;
  done: boolean;
  results: TransferenciaRowResult[];
  startedAt: number;
}

interface TransferenciaJobInput {
  items: TransferenciaItem[];
  nrWf: number;
  nrStatusAtual: number;
  proxStatus: number;
  dsObserv: string;
  token: string;
  sessionId: string;
  username: string;
}

const jobs = new Map<string, TransferenciaJobState>();
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

export function getTransferenciaJob(id: string): TransferenciaJobState | undefined {
  return jobs.get(id);
}

export function getTransferenciaEmitter(id: string): EventEmitter | undefined {
  return emitters.get(id);
}

function emit(id: string, event: string, data: unknown) {
  emitters.get(id)?.emit("progress", { event, data });
}

function snapshot(state: TransferenciaJobState) {
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

export function startTransferenciaJob(input: TransferenciaJobInput): string {
  const id = randomUUID();
  const state: TransferenciaJobState = {
    id,
    sessionId: input.sessionId,
    total: input.items.length,
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

  void processJob(id, input);
  return id;
}

async function processJob(id: string, input: TransferenciaJobInput) {
  const state = jobs.get(id)!;

  const emitProgress = () =>
    emit(id, "progress", {
      processed: state.processed,
      total: state.total,
      success: state.success,
      error: state.error,
      naoEnviado: state.naoEnviado,
    });

  for (let i = 0; i < input.items.length; i++) {
    const item = input.items[i];
    let result: TransferenciaRowResult;

    try {
      const res = await transferirStatus(input.token, {
        nrStatus: input.proxStatus,
        dsObserv: input.dsObserv,
        nrCpf: item.nrCpf,
        nrProsp: item.nrProsp,
        nmCliente: item.nmCliente,
        nrWf: input.nrWf,
        cdProd: item.cdProd,
        nrContra: item.nrContra,
      });

      if (res.httpStatus === 401) {
        // Sessão morreu: marca o restante como NAO_ENVIADO e encerra.
        destroySession(input.sessionId);
        for (const pendente of input.items.slice(i)) {
          const naoEnviada: TransferenciaRowResult = {
            nrProsp: pendente.nrProsp,
            nmCliente: pendente.nmCliente,
            status: "NAO_ENVIADO",
            detalhe: DETALHE_SESSAO_EXPIRADA,
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
        nrProsp: item.nrProsp,
        nmCliente: item.nmCliente,
        status: res.ok ? "OK" : "ERRO",
        detalhe: res.ok ? "Movida." : res.detalhe,
      };

      if (res.ok) {
        try {
          registrarEvento("transferencia_status", input.username, {
            nrProsp: item.nrProsp,
            de: input.nrStatusAtual,
            para: input.proxStatus,
            ok: true,
            dsObserv: input.dsObserv,
            lote: true,
          });
        } catch {
          /* base local é apoio */
        }
      }
    } catch (e) {
      result = {
        nrProsp: item.nrProsp,
        nmCliente: item.nmCliente,
        status: "ERRO",
        detalhe: (e as Error).message,
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
