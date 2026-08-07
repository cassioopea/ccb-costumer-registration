import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { CalcProspCalculo } from "@cadastro-lote/shared";
import {
  buscarClientePorCpf,
  cadastrarProposta,
  listarPropostasPorCpf,
  type PropostaResumo,
} from "./sinqia-client.js";
import {
  buildPropostaPayload,
  type PropostaLoteParamsCriacao,
} from "./proposta-builder.js";
import { registrarEvento, registrarPropostaCriada } from "./db.js";
import { destroySession } from "./session.js";

/**
 * Fase 3 — CRIAÇÃO das propostas na Sinqia (irreversível).
 *
 * Políticas específicas desta etapa:
 *  - SEM retry automático: cadastrarProposta não é idempotente — repetir após
 *    timeout poderia criar a proposta em duplicidade. Falhou → ERRO no
 *    relatório; o operador decide.
 *  - nrClient buscado NA HORA por CPF (autoritativo no ambiente ativo) — a
 *    planilha traz o código de produção, que não vale em HML.
 *  - 401 aborta e marca o restante como NAO_ENVIADO (padrão dos outros jobs).
 */

const DETALHE_SESSAO_EXPIRADA =
  "Sessão expirou antes desta linha — entre novamente e reenvie as pendentes.";

export class SessaoExpiradaError extends Error {
  constructor() {
    super(DETALHE_SESSAO_EXPIRADA);
    this.name = "SessaoExpiradaError";
  }
}

export interface CriacaoItem {
  linha: number;
  nome: string;
  cpf: string;
  calculo: CalcProspCalculo;
}

export interface CriacaoRowResult {
  linha: number;
  nome: string;
  cpf: string;
  /** nrClient usado (vindo da busca por CPF na hora). */
  nrClient: number | null;
  /** Nº da proposta gerado pela Sinqia (quando identificável). */
  nrProsp: string | null;
  /** JA_EXISTE = proposta idêntica encontrada — nada foi criado. */
  status: "OK" | "JA_EXISTE" | "ERRO" | "NAO_ENVIADO";
  httpStatus: number | null;
  envelopeStatus?: string;
  globalMessage?: string;
  messages: string;
  detail?: string;
}

export interface CriacaoJobState {
  id: string;
  sessionId: string;
  total: number;
  processed: number;
  success: number;
  /** Linhas puladas porque o cliente já tinha proposta idêntica. */
  jaExiste: number;
  error: number;
  naoEnviado: number;
  done: boolean;
  results: CriacaoRowResult[];
  startedAt: number;
}

interface CriacaoJobInput {
  items: CriacaoItem[];
  params: PropostaLoteParamsCriacao;
  /** true = cria mesmo com proposta idêntica existente (reemissão consciente). */
  forcarDuplicadas: boolean;
  token: string;
  sessionId: string;
  /** Operador logado — vai para a trilha de eventos da base local. */
  username: string;
}

/** Compara valores monetários em centavos inteiros (mesma regra da conferência). */
const centavosIguais = (a: number | null, b: number | null) =>
  a !== null && b !== null && Math.round(a * 100) === Math.round(b * 100);

/**
 * Uma proposta existente é "idêntica" quando bate a assinatura completa:
 * produto + quantidade de parcelas + total financiado + valor da parcela +
 * 1º vencimento. Datas de contratação diferentes NÃO descaracterizam — o
 * objetivo é pegar reenvio do mesmo lote.
 */
export function propostaIdentica(
  existente: PropostaResumo,
  calculo: CalcProspCalculo,
  cdProd: number,
): boolean {
  return (
    existente.cdProd === cdProd &&
    existente.qtPrest === calculo.qtPrest &&
    existente.dtVct1ap === calculo.dtVct1ap &&
    centavosIguais(existente.vlFinan, calculo.vlContra) &&
    centavosIguais(existente.vlPrest, calculo.vlPresta)
  );
}

const jobs = new Map<string, CriacaoJobState>();
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

export function getCriacaoJob(id: string): CriacaoJobState | undefined {
  return jobs.get(id);
}

export function getCriacaoEmitter(id: string): EventEmitter | undefined {
  return emitters.get(id);
}

function emit(id: string, event: string, data: unknown) {
  emitters.get(id)?.emit("progress", { event, data });
}

function snapshot(state: CriacaoJobState) {
  return {
    id: state.id,
    total: state.total,
    processed: state.processed,
    success: state.success,
    jaExiste: state.jaExiste,
    error: state.error,
    naoEnviado: state.naoEnviado,
    done: state.done,
  };
}

export function startCriacaoJob(input: CriacaoJobInput): string {
  const id = randomUUID();
  const state: CriacaoJobState = {
    id,
    sessionId: input.sessionId,
    total: input.items.length,
    processed: 0,
    success: 0,
    jaExiste: 0,
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

async function processJob(id: string, input: CriacaoJobInput) {
  const state = jobs.get(id)!;

  const emitProgress = () =>
    emit(id, "progress", {
      processed: state.processed,
      total: state.total,
      success: state.success,
      jaExiste: state.jaExiste,
      error: state.error,
      naoEnviado: state.naoEnviado,
    });

  for (let i = 0; i < input.items.length; i++) {
    const item = input.items[i];

    let result: CriacaoRowResult;
    try {
      result = await criarUma(input.token, item, input.params, input.forcarDuplicadas, {
        usuario: input.username,
        origem: "lote",
      });
    } catch (e) {
      if (e instanceof SessaoExpiradaError) {
        destroySession(input.sessionId);
        for (const pendente of input.items.slice(i)) {
          const naoEnviada: CriacaoRowResult = {
            linha: pendente.linha,
            nome: pendente.nome,
            cpf: pendente.cpf,
            nrClient: null,
            nrProsp: null,
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
        linha: item.linha,
        nome: item.nome,
        cpf: item.cpf,
        nrClient: null,
        nrProsp: null,
        status: "ERRO",
        httpStatus: null,
        messages: "",
        detail: (e as Error).message,
      };
    }

    if (result.status === "OK") state.success++;
    else if (result.status === "JA_EXISTE") state.jaExiste++;
    else state.error++;

    state.results.push(result);
    state.processed++;
    emit(id, "row", result);
    emitProgress();
  }

  state.done = true;
  emit(id, "done", snapshot(state));
}

/** Quem pediu a criação — vai para a base local (métricas + trilha de eventos). */
export interface ContextoCriacao {
  usuario: string;
  origem: "lote" | "individual";
}

/**
 * Cria UMA proposta: busca o cliente → guarda de duplicidade → monta → envia.
 * Exportada: a proposta individual usa exatamente o mesmo caminho do lote
 * (mesma guarda, mesmo builder, mesmo TAC via vlConces).
 */
export async function criarUma(
  token: string,
  item: CriacaoItem,
  params: PropostaLoteParamsCriacao,
  forcarDuplicadas: boolean,
  contexto?: ContextoCriacao,
): Promise<CriacaoRowResult> {
  const base = {
    linha: item.linha,
    nome: item.nome,
    cpf: item.cpf,
    nrClient: null as number | null,
    nrProsp: null as string | null,
    httpStatus: null as number | null,
    messages: "",
  };

  // 1. Cliente autoritativo do ambiente ativo.
  const busca = await buscarClientePorCpf(token, item.cpf);
  if (busca.httpStatus === 401) throw new SessaoExpiradaError();
  if (!busca.encontrado || busca.nrClient === null) {
    return {
      ...base,
      status: "ERRO",
      httpStatus: busca.httpStatus,
      detail:
        busca.httpStatus === 204
          ? "Cliente não cadastrado neste ambiente — cadastre-o antes (módulo Clientes)."
          : `HTTP ${busca.httpStatus} ao buscar o cliente.`,
    };
  }
  base.nrClient = busca.nrClient;

  // 2. GUARDA DE DUPLICIDADE: se o cliente já tem proposta com a MESMA
  //    assinatura (produto/parcelas/financiado/parcela/1º vcto.), não cria de
  //    novo — evita o efeito "testei 3 vezes, 3 propostas por cliente".
  if (!forcarDuplicadas) {
    const existentes = await listarPropostasPorCpf(token, item.cpf);
    if (existentes.httpStatus === 401) throw new SessaoExpiradaError();
    // Falha na consulta NÃO bloqueia a criação — o guarda é proteção extra,
    // mas registra no relatório que não foi possível verificar.
    if (existentes.httpStatus >= 200 && existentes.httpStatus < 300) {
      const duplicadas = existentes.propostas.filter((p) =>
        propostaIdentica(p, item.calculo, params.cdProd),
      );
      if (duplicadas.length > 0) {
        const numeros = duplicadas.map((d) => d.nrProp).join(", ");
        return {
          ...base,
          status: "JA_EXISTE",
          httpStatus: existentes.httpStatus,
          detail:
            `Proposta idêntica já existe para este cliente: nº ${numeros}. ` +
            "Nada foi criado — use a opção de forçar apenas em reemissão consciente.",
        };
      }
    } else {
      base.messages = `Aviso: não foi possível verificar duplicidade (HTTP ${existentes.httpStatus}).`;
    }
  }

  // 3. Payload a partir do cálculo retido.
  const payload = buildPropostaPayload(
    { nrClient: busca.nrClient, nrCpfCnpj: item.cpf, dsNome: busca.dsNome || item.nome },
    item.calculo,
    params,
  );

  // 4. Envio — SEM retry (não idempotente).
  const res = await cadastrarProposta(token, payload);
  if (res.httpStatus === 401) throw new SessaoExpiradaError();

  const mensagens = [base.messages, res.analysis.messagesText].filter(Boolean);

  // O TAC (Custos de Bancarização) segue DENTRO do payload, em
  // principal.vlConces — registra no relatório para conferência.
  if (res.analysis.ok && (item.calculo.vlTac ?? 0) > 0) {
    mensagens.push(`Sucesso | TAC de R$ ${item.calculo.vlTac!.toFixed(2)} incluído (vlConces)`);
  }

  // Base local: os valores EXATOS do momento da criação (a listagem da Sinqia
  // não os devolve depois). Falha aqui não pode derrubar a criação.
  if (res.analysis.ok && res.nrProsp) {
    try {
      registrarPropostaCriada({
        nrProsp: Number(res.nrProsp),
        cpf: item.cpf,
        nome: busca.dsNome || item.nome,
        cdConv: params.cdConven ?? null,
        cdProd: params.cdProd ?? null,
        vlFinan: item.calculo.vlContra ?? null,
        vlLiquid: item.calculo.vlLiquid ?? null,
        vlTac: item.calculo.vlTac ?? null,
        vlPresta: item.calculo.vlPresta ?? null,
        qtPrest: item.calculo.qtPrest ?? null,
        origem: contexto?.origem ?? "lote",
      });
      registrarEvento("proposta_criada", contexto?.usuario ?? "", {
        nrProsp: res.nrProsp,
        cdProd: params.cdProd,
        cdConv: params.cdConven,
        origem: contexto?.origem ?? "lote",
      });
    } catch {
      /* base local é apoio — a Sinqia é a fonte da verdade */
    }
  }

  return {
    ...base,
    nrProsp: res.nrProsp,
    status: res.analysis.ok ? "OK" : "ERRO",
    httpStatus: res.httpStatus,
    envelopeStatus: res.analysis.envelopeStatus,
    globalMessage: res.analysis.globalMessage,
    messages: mensagens.join(" ;; "),
    detail: res.analysis.ok ? undefined : (res.analysis.reason ?? res.rawBody?.slice(0, 300)),
  };
}
