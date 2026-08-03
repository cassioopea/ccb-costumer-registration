import { z } from "zod";

/**
 * Alteração de situação do cliente.
 *
 * Endpoints (Swagger Sinqia):
 *  - GET  /v1/cliente                       → lista paginada de clientes
 *  - POST /situacao/alterar-situacao-cliente → { cdSituacao, nrCliente }
 *
 * Ambos usam o mesmo envelope de resposta do cadastro (ver response.schema.ts):
 * HTTP 200 NÃO garante sucesso — é preciso analisar `status`/`messages[]`.
 */

/* ------------------------------------------------------------------ */
/* Situações (cdSituacao)                                              */
/* ------------------------------------------------------------------ */

/**
 * Códigos de situação do cliente, conforme o modelo `SituacoesRequest`.
 *
 * Atenção: a tabela tem rótulos repetidos — 2 e 98 são "INATIVO", 13 e 99 são
 * "CANCELADO". Mantemos os dois de cada porque o domínio da Sinqia distingue,
 * e a UI sempre mostra o código junto do rótulo para não haver ambiguidade.
 */
export const SITUACOES = [
  { codigo: 1, label: "ATIVO" },
  { codigo: 2, label: "INATIVO" },
  { codigo: 3, label: "BLOQUEADO JUDICIALMENTE" },
  { codigo: 4, label: "BLOQUEADO INSTITUIÇÃO" },
  { codigo: 5, label: "PROVISÓRIO" },
  { codigo: 10, label: "EM PREENCHIMENTO" },
  { codigo: 11, label: "EM ANÁLISE" },
  { codigo: 12, label: "APROVADO" },
  { codigo: 13, label: "CANCELADO" },
  { codigo: 14, label: "DEVOLVIDO PARA REGULARIZAÇÃO" },
  { codigo: 15, label: "AGUARDANDO DOCUMENTAÇÃO" },
  { codigo: 98, label: "INATIVO" },
  { codigo: 99, label: "CANCELADO" },
] as const;

export type Situacao = (typeof SITUACOES)[number];

const CODIGOS = SITUACOES.map((s) => s.codigo) as unknown as [number, ...number[]];

/** Aceita só os códigos da tabela — evita mandar situação inexistente. */
export const cdSituacaoSchema = z
  .number()
  .int()
  .refine((v) => CODIGOS.includes(v), {
    message: `cdSituacao inválido. Aceitos: ${CODIGOS.join(", ")}.`,
  });

/** Rótulo "12 — APROVADO" para um código; devolve só o código se desconhecido. */
export function situacaoLabel(codigo: number | undefined | null): string {
  if (codigo === undefined || codigo === null) return "";
  const s = SITUACOES.find((x) => x.codigo === codigo);
  return s ? `${s.codigo} — ${s.label}` : String(codigo);
}

/* ------------------------------------------------------------------ */
/* Request de alteração                                                */
/* ------------------------------------------------------------------ */

export const alterarSituacaoRequestSchema = z.object({
  cdSituacao: cdSituacaoSchema,
  /** Número de cadastro do cliente na Sinqia (NÃO é o CPF/CNPJ). */
  nrCliente: z.number().int(),
});

export type AlterarSituacaoRequest = z.infer<typeof alterarSituacaoRequestSchema>;

/* ------------------------------------------------------------------ */
/* Listagem de clientes                                                */
/* ------------------------------------------------------------------ */

/** Filtros da GET /v1/cliente (page/size/sort são paginação Spring). */
export const listarClientesQuerySchema = z.object({
  page: z.coerce.number().int().min(0).default(0),
  size: z.coerce.number().int().min(1).max(200).default(20),
  search: z.string().optional(),
  tipoPessoa: z.string().optional(),
  sort: z.string().optional(),
});

export type ListarClientesQuery = z.infer<typeof listarClientesQuerySchema>;

/**
 * Item da lista, já normalizado para o que a tela precisa.
 * `raw` guarda o objeto original — a Sinqia devolve mais campos do que usamos,
 * e a tela deixa inspecionar tudo (útil enquanto o contrato não está fechado).
 */
export interface ClienteResumo {
  /** Chave usada no POST de alteração. `null` = não foi possível descobrir. */
  nrCliente: number | null;
  nome: string;
  documento: string;
  tipoPessoa: string;
  cdSituacao: number | null;
  dsSituacao: string;
  raw: Record<string, unknown>;
}

export interface ClientesPage {
  items: ClienteResumo[];
  page: number;
  size: number;
  totalElements: number | null;
  totalPages: number | null;
}

/**
 * Casa um cliente com o termo digitado no filtro da tela.
 *
 * Regras:
 *  - nome: substring, sem diferenciar maiúsculas;
 *  - documento: substring dos dígitos (aceita CPF/CNPJ com ou sem máscara);
 *  - nrCliente: igualdade exata — buscar "12" não pode trazer 1200, senão
 *    selecionar "todos os filtrados" pegaria clientes que o operador não viu.
 */
export function matchCliente(c: ClienteResumo, termo: string): boolean {
  const t = termo.trim().toLowerCase();
  if (!t) return true;

  if (c.nome.toLowerCase().includes(t)) return true;

  const tDigitos = t.replace(/\D/g, "");
  if (!tDigitos) return false;

  if (c.documento.replace(/\D/g, "").includes(tDigitos)) return true;
  if (c.nrCliente !== null && String(c.nrCliente) === tDigitos) return true;

  return false;
}

/** Primeiro valor não-vazio entre as chaves candidatas. */
function pick(obj: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

function toInt(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string") {
    const digits = v.replace(/\D/g, "");
    if (digits) return Number(digits);
  }
  return null;
}

function toStr(v: unknown): string {
  return v === undefined || v === null ? "" : String(v);
}

/**
 * Normaliza um item da lista.
 *
 * Os nomes de campo da GET /v1/cliente ainda não foram confirmados contra a API
 * real, então tentamos as variações plausíveis e preservamos o objeto bruto.
 * Quando o contrato estiver fechado, dá para enxugar esta função.
 */
export function normalizeClienteItem(raw: unknown): ClienteResumo {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;

  const nrCliente = toInt(
    pick(o, ["nrCliente", "numeroCliente", "nrCadastro", "cdCliente", "codigoCliente", "id"]),
  );
  const documento = toStr(
    pick(o, ["nrCpfCnpj", "cpfCnpj", "nrCpf", "nrCnpj", "documento", "cpf", "cnpj"]),
  );
  const nome = toStr(pick(o, ["dsNome", "nome", "nmCliente", "nomeCliente", "razaoSocial"]));
  const cdSituacao = toInt(pick(o, ["cdSituac", "cdSituacao", "situacao", "codigoSituacao"]));
  const dsSituacao =
    toStr(pick(o, ["dsSituac", "dsSituacao", "descricaoSituacao", "situacaoDescricao"])) ||
    (cdSituacao !== null ? situacaoLabel(cdSituacao) : "");

  // tipoPessoa explícito, senão deduz pelo tamanho do documento (11=PF, 14=PJ).
  const doc = documento.replace(/\D/g, "");
  const tipoPessoa =
    toStr(pick(o, ["tipoPessoa", "tpPessoa", "cdPess"])) ||
    (doc.length === 11 ? "PF" : doc.length === 14 ? "PJ" : "");

  return { nrCliente, nome, documento, tipoPessoa, cdSituacao, dsSituacao, raw: o };
}

/**
 * Normaliza a resposta da GET /v1/cliente.
 *
 * Aceita as formas plausíveis: página Spring (`content`/`totalElements`), lista
 * crua, ou qualquer uma delas embrulhada em `data`/`result`/`clientes` — e,
 * como a API usa o envelope padrão, também procura a lista dentro dele.
 */
export function normalizeClientesResponse(body: unknown, fallbackPage = 0, fallbackSize = 20): ClientesPage {
  const empty: ClientesPage = {
    items: [],
    page: fallbackPage,
    size: fallbackSize,
    totalElements: null,
    totalPages: null,
  };
  if (!body || typeof body !== "object") return empty;

  const root = body as Record<string, unknown>;

  // Procura o container que tem a lista, descendo por wrappers comuns.
  const candidates: Record<string, unknown>[] = [root];
  for (const key of ["data", "result", "content", "clientes", "page", "payload"]) {
    const v = root[key];
    if (v && typeof v === "object" && !Array.isArray(v)) candidates.push(v as Record<string, unknown>);
  }

  let list: unknown[] | null = null;
  let container: Record<string, unknown> = root;

  if (Array.isArray(body)) {
    list = body as unknown[];
  } else {
    for (const c of candidates) {
      for (const key of ["content", "items", "clientes", "lista", "records", "data", "rows"]) {
        const v = c[key];
        if (Array.isArray(v)) {
          list = v as unknown[];
          container = c;
          break;
        }
      }
      if (list) break;
    }
  }

  if (!list) return empty;

  const totalElements = toInt(pick(container, ["totalElements", "totalRegistros", "total", "count"]));
  const totalPages = toInt(pick(container, ["totalPages", "totalPaginas"]));
  const page = toInt(pick(container, ["number", "page", "pagina"]));
  const size = toInt(pick(container, ["size", "tamanho", "pageSize"]));

  return {
    items: list.map(normalizeClienteItem),
    page: page ?? fallbackPage,
    size: size ?? fallbackSize,
    totalElements,
    totalPages,
  };
}
