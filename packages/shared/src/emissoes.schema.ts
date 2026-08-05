import { z } from "zod";

/**
 * Linha normalizada do `Emissoes.xlsx` (entrada do lote de propostas).
 *
 * Colunas reais do arquivo (inspecionado em 2026-08-04): Nome, CPF, ID_Sinqia,
 * N_CCB, "Valor da parcela inicial", N_Contrato (vazio — gerado pela Sinqia),
 * Liquido, Financiado, "Quantidade Parcelas", TAC, Seguro, "Out. vlr",
 * "1º vcto. De juros", Situação.
 */

/** Situações observadas no arquivo real (o filtro aceita valores novos também). */
export const SITUACOES_EMISSAO_CONHECIDAS = [
  "Compliance",
  "Pendência Compliance",
  "Validação Creditú",
  "Cancelado Pela Creditú",
] as const;

/** Linhas canceladas não devem virar proposta — desmarcadas por padrão. */
export function isSituacaoCancelada(situacao: string): boolean {
  return /cancelad/i.test(situacao);
}

export const emissaoRowSchema = z.object({
  /** Linha da planilha (1 = primeira linha de dados, abaixo do cabeçalho). */
  linha: z.number().int().positive(),
  nome: z.string(),
  /** CPF normalizado com 11 dígitos (zeros à esquerda restaurados). */
  cpf: z.string(),
  /** ID_Sinqia cru, ex.: "333-6". */
  idSinqia: z.string(),
  /**
   * Código do cliente na Sinqia: dígitos do ID_Sinqia concatenados sem o traço
   * ("333-6" → 3336). Regra confirmada em 2026-08-04.
   */
  nrClient: z.number().int().nullable(),
  nrCcb: z.string(),
  vlParcelaInicial: z.number().nullable(),
  vlLiquido: z.number().nullable(),
  vlFinanciado: z.number().nullable(),
  qtParcelas: z.number().int().nullable(),
  vlTac: z.number().nullable(),
  vlSeguro: z.number().nullable(),
  vlOutros: z.number().nullable(),
  /** 1º vencimento em AAAAMMDD. */
  dtVct1Ap: z.number().int().nullable(),
  situacao: z.string(),
  /** Problemas que impedem a linha de virar proposta (vazio = apta). */
  erros: z.array(z.string()),
  /** Ajustes assumidos que NÃO bloqueiam (ex.: parcelas ausentes → 1). */
  avisos: z.array(z.string()),
});

export type EmissaoRow = z.infer<typeof emissaoRowSchema>;

export const parseEmissoesResponseSchema = z.object({
  env: z.string(),
  arquivo: z.string(),
  total: z.number().int(),
  /** Contagem por situação, na ordem de primeira aparição. */
  porSituacao: z.array(z.tuple([z.string(), z.number().int()])),
  /** Avisos globais do parse (coluna ausente, aba inesperada...). */
  avisos: z.array(z.string()),
  rows: z.array(emissaoRowSchema),
});

export type ParseEmissoesResponse = z.infer<typeof parseEmissoesResponseSchema>;
