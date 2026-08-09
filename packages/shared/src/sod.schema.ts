import { z } from "zod";

/**
 * Esteira de Aprovação (SoD) — contratos da camada de requisições (US-01).
 *
 * Aqui ficam só os TIPOS e REGRAS PURAS compartilháveis (front usa a partir da
 * US-02); a máquina de estados executável e a persistência vivem no BFF
 * (apps/api/src/sod/).
 */

/* ------------------------------------------------------------------ */
/* Estados e transições (RN02)                                         */
/* ------------------------------------------------------------------ */

/** Os nomes seguem a nomenclatura do negócio — inclusive `aprovada/executando`. */
export const ESTADOS_REQUISICAO = [
  "pendente",
  "aprovada/executando",
  "executada",
  "falha",
  "reprovada",
  "cancelada",
  "descartada",
] as const;

export type EstadoRequisicao = (typeof ESTADOS_REQUISICAO)[number];

export const estadoRequisicaoSchema = z.enum(ESTADOS_REQUISICAO);

/** Estados que encerram o ciclo de vida — nenhuma transição sai deles. */
export const ESTADOS_TERMINAIS: readonly EstadoRequisicao[] = [
  "executada",
  "reprovada",
  "cancelada",
  "descartada",
];

/**
 * Transições permitidas (qualquer outra é inválida e auditada).
 * `falha → aprovada/executando` (retry) e `falha → descartada` chegam como
 * FUNCIONALIDADE na Onda 2 (US-10), mas a máquina já as reconhece desde a
 * fundação para a modelagem não precisar mudar.
 */
export const TRANSICOES_PERMITIDAS: Record<EstadoRequisicao, readonly EstadoRequisicao[]> = {
  pendente: ["aprovada/executando", "reprovada", "cancelada"],
  "aprovada/executando": ["executada", "falha"],
  falha: ["aprovada/executando", "descartada"],
  executada: [],
  reprovada: [],
  cancelada: [],
  descartada: [],
};

export function transicaoPermitida(de: EstadoRequisicao, para: EstadoRequisicao): boolean {
  return TRANSICOES_PERMITIDAS[de].includes(para);
}

/* ------------------------------------------------------------------ */
/* Tipos de ação (registro extensível)                                 */
/* ------------------------------------------------------------------ */

/**
 * Registro dos tipos de ação sensível que viram requisição. Cada US futura
 * ACRESCENTA a sua entrada aqui — enum fechado de propósito: tipo desconhecido
 * é erro, nunca linha órfã na base.
 */
export const TIPOS_ACAO_SOD = [
  "tomador.cadastrar", // US-02
  "proposta.criar", // US-04
  "tomador.cadastrar_lote", // US-06
  "proposta.criar_lote", // US-07
  "proposta.movimentar", // US-08
  "proposta.movimentar_massa", // US-09
  "tomador.alterar_situacao", // US-12
] as const;

export type TipoAcaoSod = (typeof TIPOS_ACAO_SOD)[number];

export const tipoAcaoSodSchema = z.enum(TIPOS_ACAO_SOD);

/* ------------------------------------------------------------------ */
/* Identidade (RN05)                                                   */
/* ------------------------------------------------------------------ */

/**
 * Login Sinqia normalizado: trim + case-insensitive. TODA comparação de
 * identidade da esteira (maker-checker, cancelamento) usa esta forma — e é
 * ela que vai para a base, nunca o login como digitado.
 */
export function normalizarLogin(login: string): string {
  return login.trim().toLowerCase();
}

/* ------------------------------------------------------------------ */
/* Contratos dos endpoints do BFF                                      */
/* ------------------------------------------------------------------ */

/** Corpo de criação de requisição. `payload` é o JSON integral da ação (RN08). */
export const criarRequisicaoSodSchema = z.object({
  tipo: tipoAcaoSodSchema,
  payload: z.record(z.unknown()),
});

export type CriarRequisicaoSod = z.infer<typeof criarRequisicaoSodSchema>;

/**
 * Decisões aplicáveis via endpoint nesta fase. Retry e descarte (estados de
 * `falha`) só ganham rota na Onda 2 — o domínio já os suporta para testes.
 * `motivo` é obrigatório em `reprovar` (RN07) — o domínio valida.
 */
export const decisaoSodSchema = z.object({
  decisao: z.enum(["aprovar", "reprovar", "cancelar"]),
  motivo: z.string().optional(),
});

export type DecisaoSod = z.infer<typeof decisaoSodSchema>;
