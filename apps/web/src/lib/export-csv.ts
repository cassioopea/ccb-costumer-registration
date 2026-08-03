import type { RowResult, SituacaoRowResult } from "./api";

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
