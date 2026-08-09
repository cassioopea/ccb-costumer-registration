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

/** Rótulos legíveis dos tipos — a UI (US-02+) exibe estes, nunca o código. */
export const ROTULO_TIPO_ACAO: Record<TipoAcaoSod, string> = {
  "tomador.cadastrar": "Cadastro de tomador",
  "proposta.criar": "Criação de proposta",
  "tomador.cadastrar_lote": "Cadastro de tomadores em lote",
  "proposta.criar_lote": "Criação de propostas em lote",
  "proposta.movimentar": "Movimentação de proposta",
  "proposta.movimentar_massa": "Movimentação de propostas em massa",
  "tomador.alterar_situacao": "Alteração de situação de tomador",
};

/* ------------------------------------------------------------------ */
/* Chave de duplicidade (guarda de pendentes — RN02 US-02 / RN04 US-04) */
/* ------------------------------------------------------------------ */

/** CPF/CNPJ reduzido a dígitos — a forma canônica comparável e indexável. */
export function normalizarDocumento(doc: string): string {
  return doc.replace(/\D/g, "");
}

/**
 * Payload canônico de `proposta.criar` (US-04): os INSUMOS da execução
 * (`proposta` + `calcRequest`) e os valores do cálculo do requisitante como
 * REFERÊNCIA rotulada (RN06) — o cálculo oficial acontece na execução, na
 * sessão do aprovador (decisão do PM no checkpoint A).
 */
export interface PropostaSodPayload {
  proposta: {
    cpf: string;
    nome: string;
    dados: {
      vlLiquido: number;
      qtParcelas: number;
      dtVct1Ap: number;
      vlTac?: number;
      vlSeguro?: number;
      vlOutros?: number;
    };
    params: {
      txJuros: number;
      cdProd: number;
      idCarCtr: number;
      cdConven: string;
      cdLoja?: number;
      dtContra: number;
    };
    forcarDuplicada: boolean;
  };
  /** Request EXATO do calcProsp do requisitante — a execução recalcula com ele. */
  calcRequest: Record<string, unknown>;
  referencia: {
    rotulo: string;
    calculadoEm: string;
    resumo: {
      vlPresta: number;
      vlFinanciado: number;
      vlLiquid: number;
      vlIof: number;
      vlTotal: number;
      txAm: number;
      txCetAm: number | null;
      qtPrest: number;
      dtVct1ap: number;
      dtVctult: number | null;
      vlTac: number;
      vlSeguro: number;
      vlOutvlr: number;
    };
  };
}

/** Rótulo fixo da referência (RN06) — a UI exibe exatamente este texto. */
export const ROTULO_REFERENCIA_CALCULO = "referência — cálculo oficial na execução";

const centavos = (v: number): number => Math.round(v * 100);

/**
 * Chave de duplicidade de `proposta.criar` (RN04): a MESMA assinatura da
 * guarda do fluxo direto (`propostaIdentica` — produto + parcelas + 1º vcto. +
 * financiado + parcela, em centavos), prefixada pelo CPF. Legível de propósito
 * (o drawer e a auditoria a mostram). Payload fora do formato → null (sem guarda).
 */
export function chaveDuplicidadeProposta(payload: Record<string, unknown>): string | null {
  const proposta = payload.proposta as PropostaSodPayload["proposta"] | undefined;
  const referencia = payload.referencia as PropostaSodPayload["referencia"] | undefined;
  const resumo = referencia?.resumo;
  const cpf = typeof proposta?.cpf === "string" ? normalizarDocumento(proposta.cpf) : "";
  const cdProd = proposta?.params?.cdProd;
  if (
    !cpf ||
    typeof cdProd !== "number" ||
    typeof resumo?.qtPrest !== "number" ||
    typeof resumo?.dtVct1ap !== "number" ||
    typeof resumo?.vlFinanciado !== "number" ||
    typeof resumo?.vlPresta !== "number"
  ) {
    return null;
  }
  return [
    cpf,
    `prod${cdProd}`,
    `${resumo.qtPrest}x`,
    `vcto${resumo.dtVct1ap}`,
    `fin${centavos(resumo.vlFinanciado)}`,
    `parc${centavos(resumo.vlPresta)}`,
  ].join(":");
}

/**
 * Extrai a CHAVE DE DUPLICIDADE do payload de uma requisição, por tipo — o
 * valor vai para a coluna `documento`, coberta pelo índice único parcial de
 * pendentes (uma pendente por (ambiente, tipo, chave)).
 *
 * - `tomador.cadastrar` (US-02): o documento (CPF/CNPJ) de
 *   `{ campos: { nrCpfCnpj } }` — uma pendente por documento.
 * - `proposta.criar` (US-04): a assinatura da proposta (mesma chave da guarda
 *   do fluxo direto) — pendentes de propostas DIFERENTES do mesmo CPF são
 *   permitidas, como na Sinqia (decisão "Opção A" do PM no checkpoint da US-04).
 *
 * Demais tipos (e payloads em formato inesperado) devolvem null — sem chave
 * não há guarda.
 */
export function extrairDocumentoSod(
  tipo: TipoAcaoSod,
  payload: Record<string, unknown>,
): string | null {
  if (tipo === "proposta.criar") return chaveDuplicidadeProposta(payload);
  if (tipo !== "tomador.cadastrar") return null;
  const campos = payload.campos;
  if (!campos || typeof campos !== "object" || Array.isArray(campos)) return null;
  const bruto = (campos as Record<string, unknown>).nrCpfCnpj;
  if (typeof bruto !== "string") return null;
  const doc = normalizarDocumento(bruto);
  return doc.length > 0 ? doc : null;
}

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
