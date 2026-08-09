import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import {
  conferirCalculo,
  type CalcProspCalculo,
  type CalcProspRequest,
  type Divergencia,
  type EmissaoRow,
} from "@cadastro-lote/shared";
import { calcProsp } from "./sinqia-client.js";
import { destroySession } from "./session.js";
import { env } from "./env.js";

/**
 * Fase 2 da esteira de propostas: cálculo (calcProsp) + conferência com o Excel.
 *
 * NADA é persistido na Sinqia — calcProsp só calcula. Mesmas políticas dos
 * outros jobs: sequencial, retry leve em 5xx/timeout, 401 aborta e marca o
 * restante como NAO_ENVIADO.
 *
 * O bloco `calculo` completo (com as prestações) fica retido NO SERVIDOR por
 * linha OK/divergente — a Fase 3 monta o cadastrarProposta a partir dele sem
 * recalcular. Para o front vai só o resumo.
 */

const DETALHE_SESSAO_EXPIRADA =
  "Sessão expirou antes desta linha — entre novamente e recalcule as pendentes.";

class SessaoExpiradaError extends Error {
  constructor() {
    super(DETALHE_SESSAO_EXPIRADA);
    this.name = "SessaoExpiradaError";
  }
}

/** Parâmetros do lote já normalizados (números prontos). */
export interface CalculoParams {
  txJuros: number;
  cdProd: number;
  idCarCtr: number;
  /** Data do contrato AAAAMMDD. */
  dtContra: number;
}

export interface CalculoRowResult {
  linha: number;
  nome: string;
  cpf: string;
  nrClient: number | null;
  /** DIVERGENCIA = calculou, mas difere do Excel além de R$0,01. */
  status: "OK" | "DIVERGENCIA" | "ERRO" | "NAO_ENVIADO";
  httpStatus: number | null;
  /** Valores para a grade de conferência (null quando o cálculo falhou). */
  vlPrestaExcel: number | null;
  vlPrestaCalc: number | null;
  vlFinanciadoExcel: number | null;
  vlFinanciadoCalc: number | null;
  vlLiquidoExcel: number | null;
  vlLiquidCalc: number | null;
  vlIof: number | null;
  vlTotal: number | null;
  txCetAm: number | null;
  qtPrest: number | null;
  divergencias: Divergencia[];
  /** Request enviado ao calcProsp — a revisão do operador vê exatamente isto. */
  request: CalcProspRequest;
  messages: string;
  detail?: string;
}

export interface CalculoJobState {
  id: string;
  sessionId: string;
  total: number;
  processed: number;
  /** OK = calculado e batendo com o Excel. */
  success: number;
  divergencia: number;
  error: number;
  naoEnviado: number;
  done: boolean;
  results: CalculoRowResult[];
  startedAt: number;
}

interface CalculoJobInput {
  rows: EmissaoRow[];
  params: CalculoParams;
  token: string;
  sessionId: string;
  /** Injetável nos testes (US-07); o runtime usa o calcProsp real. */
  calcProspFn?: typeof calcProsp;
}

const jobs = new Map<string, CalculoJobState>();
const emitters = new Map<string, EventEmitter>();
/** `calculo` completo por job/linha — insumo da Fase 3 (não vai ao front). */
const calculosCompletos = new Map<string, Map<number, CalcProspCalculo>>();

const MAX_FINISHED_JOBS = 10;

function pruneOldJobs() {
  const finished = [...jobs.values()]
    .filter((j) => j.done)
    .sort((a, b) => a.startedAt - b.startedAt);
  while (finished.length > MAX_FINISHED_JOBS) {
    const oldest = finished.shift()!;
    jobs.delete(oldest.id);
    emitters.delete(oldest.id);
    calculosCompletos.delete(oldest.id);
  }
}

export function getCalculoJob(id: string): CalculoJobState | undefined {
  return jobs.get(id);
}

export function getCalculoEmitter(id: string): EventEmitter | undefined {
  return emitters.get(id);
}

/** Fase 3 usa: bloco `calculo` completo de uma linha calculada. */
export function getCalculoCompleto(jobId: string, linha: number): CalcProspCalculo | undefined {
  return calculosCompletos.get(jobId)?.get(linha);
}

function emit(id: string, event: string, data: unknown) {
  emitters.get(id)?.emit("progress", { event, data });
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function snapshot(state: CalculoJobState) {
  return {
    id: state.id,
    total: state.total,
    processed: state.processed,
    success: state.success,
    divergencia: state.divergencia,
    error: state.error,
    naoEnviado: state.naoEnviado,
    done: state.done,
  };
}

/** Dados mínimos de UMA operação para o calcProsp (lote ou individual). */
export interface DadosCalculo {
  cpf: string;
  qtParcelas: number;
  /** LÍQUIDO da operação — vira o vlContra do request (ver comentário abaixo). */
  vlLiquido: number;
  dtVct1Ap: number;
  vlTac?: number | null;
  vlSeguro?: number | null;
  vlOutros?: number | null;
}

/**
 * Monta o request do calcProsp a partir dos dados de uma operação.
 *
 * vlContra recebe o LÍQUIDO (confirmado empiricamente): a Sinqia financia
 * TAC/Seguro/Outros ("F") por cima do vlContra e o total financiado que ela
 * devolve bate com a coluna Financiado da planilha.
 */
export function buildCalcRequestDados(d: DadosCalculo, params: CalculoParams): CalcProspRequest {
  return {
    nrCPF: d.cpf,
    qtPrest: d.qtParcelas,
    vlSldRefin: null,
    txJuros: params.txJuros,
    vlContra: d.vlLiquido,
    cdProd: params.cdProd,
    idCarCtr: params.idCarCtr,
    idRefin: "N",
    dtContra: params.dtContra,
    dtVct1Ap: d.dtVct1Ap,
    nmLogin: null,
    // 0 = encargo inexistente → null, como no payload de referência.
    vlOutvlr: d.vlOutros || null,
    tpPgOutros: "F",
    vlSeguro: d.vlSeguro || null,
    tpPgSeguro: "F",
    vlTac: d.vlTac || null,
    tpPgTac: "F",
    idPrestResponse: "S",
  };
}

/** Variante do lote: extrai os dados da linha do Emissoes.xlsx. */
export function buildCalcRequest(row: EmissaoRow, params: CalculoParams): CalcProspRequest {
  return buildCalcRequestDados(
    {
      cpf: row.cpf,
      qtParcelas: row.qtParcelas ?? 1,
      vlLiquido: row.vlLiquido ?? 0,
      dtVct1Ap: row.dtVct1Ap ?? 0,
      vlTac: row.vlTac,
      vlSeguro: row.vlSeguro,
      vlOutros: row.vlOutros,
    },
    params,
  );
}

export function startCalculoJob(input: CalculoJobInput): string {
  const id = randomUUID();
  const state: CalculoJobState = {
    id,
    sessionId: input.sessionId,
    total: input.rows.length,
    processed: 0,
    success: 0,
    divergencia: 0,
    error: 0,
    naoEnviado: 0,
    done: false,
    results: [],
    startedAt: Date.now(),
  };
  jobs.set(id, state);
  emitters.set(id, new EventEmitter());
  calculosCompletos.set(id, new Map());
  pruneOldJobs();

  void processJob(id, input);
  return id;
}

async function processJob(id: string, input: CalculoJobInput) {
  const state = jobs.get(id)!;

  const emitProgress = () =>
    emit(id, "progress", {
      processed: state.processed,
      total: state.total,
      success: state.success,
      divergencia: state.divergencia,
      error: state.error,
      naoEnviado: state.naoEnviado,
    });

  for (let i = 0; i < input.rows.length; i++) {
    const row = input.rows[i];
    const request = buildCalcRequest(row, input.params);

    let result: CalculoRowResult;
    try {
      result = await calcularComPoliticas(
        id,
        input.token,
        row,
        request,
        input.calcProspFn ?? calcProsp,
      );
    } catch (e) {
      if (e instanceof SessaoExpiradaError) {
        destroySession(input.sessionId);
        for (const pendente of input.rows.slice(i)) {
          const naoEnviada = baseResult(pendente, buildCalcRequest(pendente, input.params));
          naoEnviada.status = "NAO_ENVIADO";
          naoEnviada.detail = DETALHE_SESSAO_EXPIRADA;
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
      result = baseResult(row, request);
      result.status = "ERRO";
      result.detail = (e as Error).message;
    }

    if (result.status === "OK") state.success++;
    else if (result.status === "DIVERGENCIA") state.divergencia++;
    else state.error++;

    state.results.push(result);
    state.processed++;
    emit(id, "row", result);
    emitProgress();
  }

  state.done = true;
  emit(id, "done", snapshot(state));
}

function baseResult(row: EmissaoRow, request: CalcProspRequest): CalculoRowResult {
  return {
    linha: row.linha,
    nome: row.nome,
    cpf: row.cpf,
    nrClient: row.nrClient,
    status: "ERRO",
    httpStatus: null,
    vlPrestaExcel: row.vlParcelaInicial,
    vlPrestaCalc: null,
    vlFinanciadoExcel: row.vlFinanciado,
    vlFinanciadoCalc: null,
    vlLiquidoExcel: row.vlLiquido,
    vlLiquidCalc: null,
    vlIof: null,
    vlTotal: null,
    txCetAm: null,
    qtPrest: null,
    divergencias: [],
    request,
    messages: "",
  };
}

async function calcularComPoliticas(
  jobId: string,
  token: string,
  row: EmissaoRow,
  request: CalcProspRequest,
  calcProspFn: typeof calcProsp,
): Promise<CalculoRowResult> {
  const maxAttempts = env.RETRY_COUNT + 1;
  let lastError: string | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const { httpStatus, calculo, analysis, rawBody } = await calcProspFn(token, request);

      if (httpStatus === 401) throw new SessaoExpiradaError();

      if (httpStatus >= 500 && attempt < maxAttempts) {
        lastError = `HTTP ${httpStatus}`;
        await delay(500 * attempt);
        continue;
      }

      const result = baseResult(row, request);
      result.httpStatus = httpStatus;

      if (!calculo) {
        result.status = "ERRO";
        result.messages = analysis.messagesText;
        result.detail = analysis.reason ?? rawBody?.slice(0, 300);
        return result;
      }

      // Retém o cálculo completo para a Fase 3 (criação sem recalcular).
      calculosCompletos.get(jobId)?.set(row.linha, calculo);

      result.vlPrestaCalc = calculo.vlPresta;
      result.vlFinanciadoCalc = calculo.vlContra;
      result.vlLiquidCalc = calculo.vlLiquid;
      result.vlIof = calculo.vlIof;
      result.vlTotal = calculo.vlTotal;
      result.txCetAm = calculo.txCetAm;
      result.qtPrest = calculo.qtPrest;
      result.divergencias = conferirCalculo(
        {
          vlParcelaInicial: row.vlParcelaInicial,
          vlLiquido: row.vlLiquido,
          vlFinanciado: row.vlFinanciado,
        },
        calculo,
      );
      result.status = result.divergencias.length === 0 ? "OK" : "DIVERGENCIA";
      return result;
    } catch (e) {
      if (e instanceof SessaoExpiradaError) throw e;
      lastError = (e as Error).message;
      if (attempt < maxAttempts) {
        await delay(500 * attempt);
        continue;
      }
    }
  }

  const result = baseResult(row, request);
  result.detail = lastError ?? "Falha após tentativas.";
  return result;
}
