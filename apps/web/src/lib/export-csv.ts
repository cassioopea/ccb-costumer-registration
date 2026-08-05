import type { CalculoRowResult, CriacaoRowResult, RowResult, SituacaoRowResult } from "./api";

/**
 * Escapa um valor para CSV.
 *
 * Anti formula-injection: valores vindos do arquivo/API que começam com
 * = + - @ (ou tab/CR) seriam executados como fórmula pelo Excel.
 */
function escape(v: unknown): string {
  let s = v === null || v === undefined ? "" : String(v);
  if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Monta o CSV (com BOM, para o Excel abrir acentos) e dispara o download. */
function download(prefixo: string, headers: string[], linhas: unknown[][]): void {
  const csv =
    "﻿" +
    [headers.join(","), ...linhas.map((l) => l.map(escape).join(","))].join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${prefixo}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/** Exporta o relatório do lote de cadastro (inclui mensagens de consistência). */
export function exportResultsCsv(results: RowResult[]): void {
  download(
    "relatorio-cadastro-lote",
    [
      "linha",
      "nome",
      "documento",
      "tipo",
      "status",
      "httpStatus",
      "statusEnvelope",
      "globalMessage",
      "mensagensConsistencia",
      "detalhe",
    ],
    results.map((r) => [
      r.index,
      r.nome,
      r.documento,
      r.tipo,
      r.status,
      r.httpStatus ?? "",
      r.envelopeStatus ?? "",
      r.globalMessage ?? "",
      r.messages ?? "",
      r.detail ?? "",
    ]),
  );
}

/** Exporta o relatório da alteração de situação em lote. */
export function exportSituacaoCsv(results: SituacaoRowResult[]): void {
  download(
    "relatorio-situacao-clientes",
    [
      "nrCliente",
      "nome",
      "documento",
      "situacaoAnterior",
      "situacaoNova",
      "status",
      "httpStatus",
      "statusEnvelope",
      "globalMessage",
      "mensagens",
      "detalhe",
    ],
    results.map((r) => [
      r.nrCliente,
      r.nome,
      r.documento,
      r.situacaoAnterior,
      r.situacaoNova,
      r.status,
      r.httpStatus ?? "",
      r.envelopeStatus ?? "",
      r.globalMessage ?? "",
      r.messages ?? "",
      r.detail ?? "",
    ]),
  );
}

/** Exporta o resultado do cálculo/conferência do lote de propostas. */
export function exportCalculoCsv(results: CalculoRowResult[]): void {
  download(
    "conferencia-calculo-propostas",
    [
      "linha",
      "nome",
      "cpf",
      "nrClient",
      "status",
      "parcelaExcel",
      "parcelaCalculada",
      "financiadoExcel",
      "financiadoCalculado",
      "liquidoExcel",
      "liquidoCalculado",
      "iof",
      "vlTotal",
      "cetMes",
      "qtParcelas",
      "divergencias",
      "mensagens",
      "detalhe",
    ],
    results.map((r) => [
      r.linha,
      r.nome,
      r.cpf,
      r.nrClient ?? "",
      r.status,
      r.vlPrestaExcel ?? "",
      r.vlPrestaCalc ?? "",
      r.vlFinanciadoExcel ?? "",
      r.vlFinanciadoCalc ?? "",
      r.vlLiquidoExcel ?? "",
      r.vlLiquidCalc ?? "",
      r.vlIof ?? "",
      r.vlTotal ?? "",
      r.txCetAm ?? "",
      r.qtPrest ?? "",
      r.divergencias
        .map((d) => `${d.campo}: excel ${d.excel} vs calc ${d.calculado}`)
        .join(" ;; "),
      r.messages ?? "",
      r.detail ?? "",
    ]),
  );
}

/** Uma pendência consolidada do lote de propostas (para corrigir a planilha). */
export interface PendenciaRow {
  linha: number;
  nome: string;
  cpf: string;
  idSinqia: string;
  situacao: string;
  /** De onde veio o problema: Planilha / Cliente Sinqia / Cálculo. */
  origem: string;
  problema: string;
}

/**
 * Relatório de pendências: tudo que impede a linha de virar proposta —
 * problemas de planilha, cliente não encontrado/divergente na Sinqia e
 * erros/divergências de cálculo. Vai para quem gera a planilha corrigida.
 */
export function exportPendenciasCsv(rows: PendenciaRow[]): void {
  download(
    "pendencias-emissoes",
    ["linha", "nome", "cpf", "idSinqia", "situacao", "origem", "problema"],
    rows.map((r) => [r.linha, r.nome, r.cpf, r.idSinqia, r.situacao, r.origem, r.problema]),
  );
}

/** Exporta o relatório da CRIAÇÃO das propostas (nº gerado por linha). */
export function exportCriacaoCsv(results: CriacaoRowResult[]): void {
  download(
    "criacao-propostas",
    [
      "linha",
      "nome",
      "cpf",
      "nrClient",
      "nrProposta",
      "status",
      "httpStatus",
      "statusEnvelope",
      "globalMessage",
      "mensagens",
      "detalhe",
    ],
    results.map((r) => [
      r.linha,
      r.nome,
      r.cpf,
      r.nrClient ?? "",
      r.nrProsp ?? "",
      r.status,
      r.httpStatus ?? "",
      r.envelopeStatus ?? "",
      r.globalMessage ?? "",
      r.messages ?? "",
      r.detail ?? "",
    ]),
  );
}
