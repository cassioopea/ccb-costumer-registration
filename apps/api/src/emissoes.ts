import * as XLSX from "xlsx";
import type { EmissaoRow } from "@cadastro-lote/shared";

/**
 * Parser do `Emissoes.xlsx` → linhas normalizadas para o lote de propostas.
 *
 * Formatos REAIS observados no arquivo (2026-08-04):
 *  - CPF vem como NUMBER (zeros à esquerda perdidos) → padStart(11, "0");
 *  - ID_Sinqia é string "999-9" (ex.: "333-6");
 *  - valores monetários já são number; datas vêm como Date (cellDates);
 *  - N_Contrato vem vazio (gerado pela Sinqia — ignorado na entrada);
 *  - Situação inclui "Cancelado Pela Creditú" (não só "Cancelado").
 */

/** Normaliza cabeçalho para casar com tolerância a acento/caixa/espaços. */
function normalizeHeader(h: string): string {
  return h
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/º/g, "o")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Cabeçalhos canônicos → chave interna. */
const HEADER_MAP: Record<string, keyof RawRow> = {
  "nome": "nome",
  "cpf": "cpf",
  "id sinqia": "idSinqia",
  "n ccb": "nrCcb",
  "valor da parcela inicial": "vlParcelaInicial",
  "n contrato": "nrContrato",
  "liquido": "vlLiquido",
  "financiado": "vlFinanciado",
  "quantidade parcelas": "qtParcelas",
  "tac": "vlTac",
  "seguro": "vlSeguro",
  "out vlr": "vlOutros",
  "1o vcto de juros": "dtVct1Ap",
  "situacao": "situacao",
};

interface RawRow {
  nome: unknown;
  cpf: unknown;
  idSinqia: unknown;
  nrCcb: unknown;
  vlParcelaInicial: unknown;
  nrContrato: unknown;
  vlLiquido: unknown;
  vlFinanciado: unknown;
  qtParcelas: unknown;
  vlTac: unknown;
  vlSeguro: unknown;
  vlOutros: unknown;
  dtVct1Ap: unknown;
  situacao: unknown;
}

/** Date | serial Excel | "dd/mm/aaaa" → int AAAAMMDD, ou null. */
export function toAAAAMMDD(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    return v.getFullYear() * 10_000 + (v.getMonth() + 1) * 100 + v.getDate();
  }
  if (typeof v === "number" && Number.isFinite(v)) {
    // Já está em AAAAMMDD?
    if (v >= 19_00_01_01 && v <= 99_99_12_31) return Math.trunc(v);
    // Serial de data do Excel.
    const d = XLSX.SSF.parse_date_code(v);
    if (d) return d.y * 10_000 + d.m * 100 + d.d;
    return null;
  }
  if (typeof v === "string") {
    const m = v.trim().match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/);
    if (m) return Number(m[3]) * 10_000 + Number(m[2]) * 100 + Number(m[1]);
    const iso = v.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return Number(iso[1]) * 10_000 + Number(iso[2]) * 100 + Number(iso[3]);
  }
  return null;
}

/** number | "R$ 1.234,56" | "1234,56" | "416.78" → number, ou null. */
export function toMoney(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    let cleaned = v.replace(/[R$\s]/g, "");
    // Com vírgula, o ponto é separador de milhar (BR); sem vírgula, o ponto
    // é decimal (formato do template CSV — US-07).
    if (cleaned.includes(",")) cleaned = cleaned.replace(/\./g, "").replace(",", ".");
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** CPF (number ou string) → 11 dígitos com zeros à esquerda, ou "" se vazio. */
export function normalizeCpf(v: unknown): string {
  if (v === null || v === undefined || v === "") return "";
  const digits = String(v).replace(/\D/g, "");
  if (!digits) return "";
  return digits.length < 11 ? digits.padStart(11, "0") : digits;
}

/**
 * ID_Sinqia "333-6" → nrClient 3336 (dígitos CONCATENADOS, sem o traço).
 * Regra confirmada pelo Cassio em 2026-08-04; conferível via busca de cliente
 * filtrando pelo nrCliente.
 */
export function idSinqiaToNrClient(raw: string): number | null {
  if (!/^\d+(?:-\d+)?$/.test(raw.trim())) return null;
  const n = Number(raw.replace(/\D/g, ""));
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export interface ParseEmissoesResult {
  rows: EmissaoRow[];
  porSituacao: Array<[string, number]>;
  avisos: string[];
}

export function parseEmissoesXlsx(buf: Buffer): ParseEmissoesResult {
  let wb: XLSX.WorkBook;
  try {
    // A lib detecta o formato pelo conteúdo: .xlsx/.xls E .csv (US-07) caem
    // no MESMO caminho de parse/normalização — não há segundo parser.
    // CSV (texto plano, sem assinatura ZIP/OLE) é lido com raw:true: a lib
    // interpretaria "05/09/2026" como data AMERICANA (9 de maio); com raw,
    // tudo chega string e as normalizações daqui (toAAAAMMDD dd/mm/aaaa,
    // toMoney, normalizeCpf) mandam — determinístico nos dois formatos.
    // A decodificação também é nossa: UTF-8 (formato do template), com
    // fallback latin1 para CSV "ANSI" salvo pelo Excel — sem isso a lib
    // assume cp1252 e corrompe os acentos do cabeçalho ("Situação").
    const ehTextoPlano =
      !(buf[0] === 0x50 && buf[1] === 0x4b) && !(buf[0] === 0xd0 && buf[1] === 0xcf);
    if (ehTextoPlano) {
      const utf8 = buf.toString("utf8");
      const conteudo = utf8.includes("�") ? buf.toString("latin1") : utf8;
      wb = XLSX.read(conteudo, { type: "string", raw: true });
    } else {
      wb = XLSX.read(buf, { cellDates: true });
    }
  } catch {
    throw new Error("Arquivo não pôde ser lido como planilha (.xlsx ou .csv).");
  }
  if (wb.SheetNames.length === 0) throw new Error("A planilha não tem nenhuma aba.");

  const avisos: string[] = [];
  if (wb.SheetNames.length > 1) {
    avisos.push(
      `A planilha tem ${wb.SheetNames.length} abas — usando a primeira ("${wb.SheetNames[0]}").`,
    );
  }

  const ws = wb.Sheets[wb.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: null });
  if (raw.length === 0) throw new Error("A planilha está vazia (nenhuma linha de dados).");

  // Mapeia cabeçalhos reais → chaves internas.
  const headerLookup = new Map<string, keyof RawRow>();
  const desconhecidos: string[] = [];
  for (const original of Object.keys(raw[0])) {
    const key = HEADER_MAP[normalizeHeader(original)];
    if (key) headerLookup.set(original, key);
    else desconhecidos.push(original);
  }
  if (desconhecidos.length) {
    avisos.push(`Colunas ignoradas (não fazem parte do mapeamento): ${desconhecidos.join(", ")}`);
  }
  const mapeadas = new Set(headerLookup.values());
  const essenciais: Array<keyof RawRow> = ["cpf", "vlFinanciado", "qtParcelas", "situacao"];
  const faltando = essenciais.filter((k) => !mapeadas.has(k));
  if (faltando.length) {
    throw new Error(
      `A planilha não tem as colunas esperadas: ${faltando.join(", ")}. ` +
        "Confirme se é o Emissoes.xlsx no formato combinado.",
    );
  }

  const rows: EmissaoRow[] = raw.map((r, i) => {
    const rec: Partial<RawRow> = {};
    for (const [original, key] of headerLookup) rec[key] = r[original];

    const erros: string[] = [];
    const avisos: string[] = [];
    const nome = String(rec.nome ?? "").trim();
    const cpf = normalizeCpf(rec.cpf);
    const idSinqia = String(rec.idSinqia ?? "").trim();
    const nrClient = idSinqia ? idSinqiaToNrClient(idSinqia) : null;
    const vlFinanciado = toMoney(rec.vlFinanciado);
    const vlLiquido = toMoney(rec.vlLiquido);
    const vlParcelaInicial = toMoney(rec.vlParcelaInicial);
    const qtRaw = toMoney(rec.qtParcelas);
    let qtParcelas = qtRaw !== null && Number.isInteger(qtRaw) ? qtRaw : null;
    const dtVct1Ap = toAAAAMMDD(rec.dtVct1Ap);

    if (!cpf) erros.push("CPF ausente.");
    else if (cpf.length !== 11) erros.push(`CPF com ${cpf.length} dígitos (esperado 11).`);
    if (!idSinqia) erros.push("ID_Sinqia ausente.");
    else if (nrClient === null) erros.push(`ID_Sinqia "${idSinqia}" fora do formato esperado (999-9).`);
    if (vlFinanciado === null) erros.push("Financiado ausente ou inválido.");
    if (vlLiquido === null) {
      erros.push("Líquido ausente — é o valor contratado enviado ao cálculo (vlContra).");
    }
    if (qtParcelas === null) {
      // Regra de negócio (Cassio, 2026-08-04): sem quantidade = parcela única.
      qtParcelas = 1;
      avisos.push("Quantidade de parcelas ausente — assumida 1 (parcela única).");
    }
    if (dtVct1Ap === null) erros.push("1º vcto. de juros ausente ou inválido.");
    if (vlParcelaInicial === null) {
      erros.push("Valor da parcela inicial ausente — sem ele não há conferência do cálculo.");
    }

    return {
      linha: i + 1,
      nome,
      cpf,
      idSinqia,
      nrClient,
      nrCcb: String(rec.nrCcb ?? "").trim(),
      vlParcelaInicial,
      vlLiquido,
      vlFinanciado,
      qtParcelas,
      vlTac: toMoney(rec.vlTac),
      vlSeguro: toMoney(rec.vlSeguro),
      vlOutros: toMoney(rec.vlOutros),
      dtVct1Ap,
      situacao: String(rec.situacao ?? "").trim() || "(sem situação)",
      erros,
      avisos,
    };
  });

  // Contagem por situação, na ordem de primeira aparição.
  const contagem = new Map<string, number>();
  for (const row of rows) contagem.set(row.situacao, (contagem.get(row.situacao) ?? 0) + 1);

  return { rows, porSituacao: [...contagem.entries()], avisos };
}
