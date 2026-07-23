import Papa from "papaparse";
import {
  cadastrarClienteRequestSchema,
  clienteSchema,
  detectTipoPessoa,
  type BatchControl,
  type CadastrarClienteRequest,
  type Cliente,
} from "@cadastro-lote/shared";

/**
 * Parsing e normalização da entrada (JSON ou CSV) para uma lista de
 * `{ cliente }` pronta para validação e envio.
 */

export interface ParsedRow {
  /** Índice 1-based (linha do arquivo/posição no array). */
  index: number;
  cliente: Cliente;
  tipo: "PF" | "PJ" | "?";
  nome: string;
  documento: string;
  /** Erros de validação zod (vazio = válido). */
  errors: string[];
}

/* ------------------------------------------------------------------ */
/* Registro de tipos por nome de campo (folha) para coerção do CSV     */
/* ------------------------------------------------------------------ */

/**
 * Campos que DEVEM permanecer string mesmo quando o valor parece numérico.
 * Fonte: payload PF validado + regras explícitas do domínio.
 */
const STRING_LEAVES = new Set<string>([
  // documentos / códigos que enganam
  "nrCpfCnpj", "nrCep", "nrConta", "dvConta", "nrDoc", "nrEnd",
  "idUniao", "tpImovel", "idPrincipal", "idLe6515", "tpEman",
  "cdAutscr", "dsSituac", "idLgpd", "cdRating", "cdCapital",
  "idContAcio", "idAcao", "idPrinc", "idAcaoCliente", "idAcaoEndereco",
  "step", "idIntegracaoCadastro", "idRetConsistencias", "idBiometria",
  "idOrigemRequest",
  // siglas / tipos textuais
  "sgEstado", "sgEmissor", "sgEstadoNat", "tpSexo", "tpConta",
  "tpRelacaoTrab", "tpSocio",
  // textos livres
  "dsNome", "dsEnd", "dsBairro", "dsCidade", "dsCompl", "dsEmail",
  "nmUrl", "nomeMae", "nomePai", "nomeCidadeNaturalidade", "dsCargo",
  "dsEmpres", "nmEnd", "nmBairro", "nmCidade", "nmImovel", "nome",
  "nomeFantasia", "nrInscEst", "nrInscMun", "nrNire", "nrNireAnt",
  "dsBem", "cdRenavam", "dsBandeira", "idFranquia", "idSimple",
  "nmBeneficiario", "nmFanFranq", "nmFranq", "nrCnpjFranq",
  "nrDocumentoBeneficiario", "idCapAberto",
]);

/** Retorna o nome da folha de um caminho pontilhado/indexado (ex.: "dadosPf.dtNasc" → "dtNasc"). */
function leafName(path: string): string {
  const last = path.split(".").pop() ?? path;
  return last.replace(/\[\d+\]$/, "");
}

/** Coage um valor de CSV (string) para o tipo apropriado, ou undefined se vazio. */
export function coerceValue(path: string, raw: string): unknown {
  const v = raw?.trim();
  if (v === undefined || v === "") return undefined; // não enviar chaves vazias/null

  const leaf = leafName(path);
  if (STRING_LEAVES.has(leaf)) return v;

  // Numérico (inteiro ou decimal, aceita vírgula decimal do pt-BR).
  const normalized = v.replace(/\s/g, "");
  if (/^-?\d+(\.\d+)?$/.test(normalized)) return Number(normalized);
  if (/^-?\d+,\d+$/.test(normalized)) return Number(normalized.replace(",", "."));

  // Booleanos eventuais.
  if (v.toLowerCase() === "true") return true;
  if (v.toLowerCase() === "false") return false;

  return v; // fallback: string
}

/** Chaves que permitiriam prototype pollution via cabeçalho de CSV malicioso. */
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
/** Índice máximo aceito em colunas de array (evita DoS por array esparso gigante). */
const MAX_ARRAY_INDEX = 999;

/**
 * Remonta objeto aninhado a partir de chaves achatadas.
 * Suporta: "dadosPf.dtNasc", "bensImoveis[0].nmImovel", "refPessoais[1].nome".
 *
 * Segurança: rejeita segmentos __proto__/constructor/prototype (prototype
 * pollution) e índices de array absurdos (esgotamento de memória).
 */
export function unflatten(flat: Record<string, unknown>): Record<string, unknown> {
  const root: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(flat)) {
    if (value === undefined) continue;
    const tokens = key.match(/[^.[\]]+/g);
    if (!tokens) continue;

    for (const token of tokens) {
      if (FORBIDDEN_KEYS.has(token)) {
        throw new Error(`Nome de coluna inválido no CSV: "${key}"`);
      }
      if (/^\d+$/.test(token) && Number(token) > MAX_ARRAY_INDEX) {
        throw new Error(
          `Índice de array muito alto na coluna "${key}" (máximo ${MAX_ARRAY_INDEX}).`,
        );
      }
    }

    let cursor: any = root;
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      const isIndex = /^\d+$/.test(token);
      const isLast = i === tokens.length - 1;
      const nextIsIndex = !isLast && /^\d+$/.test(tokens[i + 1]);

      if (isLast) {
        if (isIndex) cursor[Number(token)] = value;
        else cursor[token] = value;
      } else {
        const nextContainer = nextIsIndex ? [] : {};
        if (isIndex) {
          const idx = Number(token);
          cursor[idx] = cursor[idx] ?? nextContainer;
          cursor = cursor[idx];
        } else {
          cursor[token] = cursor[token] ?? nextContainer;
          cursor = cursor[token];
        }
      }
    }
  }

  // Compacta arrays esparsos (remove buracos).
  return compactArrays(root);
}

function compactArrays(node: any): any {
  if (Array.isArray(node)) {
    return node.filter((x) => x !== undefined && x !== null).map(compactArrays);
  }
  if (node && typeof node === "object") {
    for (const k of Object.keys(node)) node[k] = compactArrays(node[k]);
    return node;
  }
  return node;
}

/* ------------------------------------------------------------------ */
/* Entrada CSV                                                         */
/* ------------------------------------------------------------------ */

/** Converte CSV achatado em lista de objetos `cliente`. */
export function parseCsv(content: string): Cliente[] {
  const result = Papa.parse<Record<string, string>>(content, {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (h) => h.trim(),
  });
  if (result.errors.length) {
    const first = result.errors[0];
    throw new Error(`Erro ao ler CSV (linha ${first.row}): ${first.message}`);
  }

  return result.data.map((row) => {
    const flat: Record<string, unknown> = {};
    for (const [col, raw] of Object.entries(row)) {
      const coerced = coerceValue(col, raw ?? "");
      if (coerced !== undefined) flat[col] = coerced;
    }
    return unflatten(flat) as Cliente;
  });
}

/* ------------------------------------------------------------------ */
/* Entrada JSON                                                        */
/* ------------------------------------------------------------------ */

/**
 * Normaliza JSON de entrada. Aceita:
 *  - array de objetos `cliente`
 *  - array de `{ cliente: {...} }`
 *  - objeto único (com ou sem wrapper `cliente`)
 */
export function parseJson(content: string): Cliente[] {
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch (e) {
    throw new Error(`JSON inválido: ${(e as Error).message}`);
  }

  const arr = Array.isArray(data) ? data : [data];
  return arr.map((item) => {
    if (item && typeof item === "object" && "cliente" in (item as any)) {
      return (item as any).cliente as Cliente;
    }
    return item as Cliente;
  });
}

/* ------------------------------------------------------------------ */
/* Orquestração de parsing + validação                                 */
/* ------------------------------------------------------------------ */

export function parseByFilename(filename: string, content: string): Cliente[] {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".json")) return parseJson(content);
  if (lower.endsWith(".csv")) return parseCsv(content);
  // fallback: tenta detectar pelo conteúdo
  const trimmed = content.trimStart();
  return trimmed.startsWith("[") || trimmed.startsWith("{")
    ? parseJson(content)
    : parseCsv(content);
}

/** Valida cada cliente contra o schema zod e monta as linhas com metadados. */
export function validateRows(clientes: Cliente[]): ParsedRow[] {
  return clientes.map((cliente, i) => {
    const parsed = clienteSchema.safeParse(cliente);
    const errors = parsed.success
      ? []
      : parsed.error.issues.map((iss) => `${iss.path.join(".") || "(raiz)"}: ${iss.message}`);
    const documento = (cliente?.nrCpfCnpj ?? "").toString();
    return {
      index: i + 1,
      cliente: parsed.success ? parsed.data : cliente,
      tipo: detectTipoPessoa(documento),
      nome: (cliente?.dsNome ?? "").toString(),
      documento,
      errors,
    };
  });
}

/** Monta o request final por linha, injetando os campos de controle do lote. */
export function buildRequest(cliente: Cliente, control: BatchControl): CadastrarClienteRequest {
  const req: CadastrarClienteRequest = { cliente };
  if (control.finalizar) req.step = "FI";
  if (control.idIntegracaoCadastro) req.idIntegracaoCadastro = control.idIntegracaoCadastro;
  if (control.idRetConsistencias) req.idRetConsistencias = control.idRetConsistencias;
  if (control.idBiometria) req.idBiometria = control.idBiometria;
  if (control.idOrigemRequest) req.idOrigemRequest = control.idOrigemRequest;
  // Valida o request completo (garante forma antes de enviar).
  return cadastrarClienteRequestSchema.parse(req);
}
