import type { RowResult } from "./api";

/** Exporta o relatório do lote (inclui mensagens de consistência) como CSV. */
export function exportResultsCsv(results: RowResult[]): void {
  const headers = [
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
  ];

  const escape = (v: unknown) => {
    let s = v === null || v === undefined ? "" : String(v);
    // Anti formula-injection: valores vindos do arquivo/API que começam com
    // = + - @ (ou tab/CR) seriam executados como fórmula pelo Excel.
    if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const lines = results.map((r) =>
    [
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
    ]
      .map(escape)
      .join(","),
  );

  const csv = "﻿" + [headers.join(","), ...lines].join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `relatorio-cadastro-lote-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
