import { z } from "zod";
import { dateInt } from "./cliente.schema.js";

/**
 * Schemas do fluxo de PROPOSTA (Backoffice de Originação — módulo Propostas).
 *
 * Fonte: payloads reais gravados do Portal de Crédito (DevTools) em
 * `exemplos/payloads_proposta_referencia.json`. O fluxo que importa são
 * 3 chamadas: calcProsp → primeiro-vencimento → cadastrarProposta.
 *
 * Filosofia igual ao módulo Clientes: campos opcionais + .passthrough(),
 * tipos fiéis ao payload validado (não ao que "parece certo").
 */

/* ------------------------------------------------------------------ */
/* 1. calcProsp — cálculo da proposta                                   */
/* ------------------------------------------------------------------ */

/**
 * Request de POST /BJ21SS0501C/calcProsp.
 * O payload de referência envia null explícito em vários campos — o schema
 * aceita null e a montagem decide entre null e omitir. `tpPg*`: "F" observado
 * (significado exato // [a validar] — presumido "Financiado").
 */
export const calcProspRequestSchema = z
  .object({
    nrCPF: z.string().min(11).max(14),
    qtPrest: z.number().int().positive(),
    vlSldRefin: z.number().nullable().optional(),
    txJuros: z.number(),
    vlContra: z.number(),
    cdProd: z.number().int(),
    idCarCtr: z.number().int(),
    idRefin: z.enum(["S", "N"]).default("N"),
    dtContra: dateInt,
    dtVct1Ap: dateInt,
    nmLogin: z.string().nullable().optional(),
    vlOutvlr: z.number().nullable().optional(),
    tpPgOutros: z.string().default("F"),
    vlSeguro: z.number().nullable().optional(),
    tpPgSeguro: z.string().default("F"),
    vlTac: z.number().nullable().optional(),
    tpPgTac: z.string().default("F"),
    idPrestResponse: z.string().default("S"),
  })
  .passthrough();

export type CalcProspRequest = z.infer<typeof calcProspRequestSchema>;

/** Uma parcela do plano (mesma forma no retorno do cálculo e no cadastrarProposta). */
export const parcelaPropostaSchema = z
  .object({
    tpParc: z.number().int(),
    nrPresta: z.number().int(),
    vlPrinc: z.number(),
    vlJuros: z.number(),
    vlPresta: z.number(),
    vlTotal: z.number(),
    dtVctpre: dateInt,
  })
  .passthrough();

export type ParcelaProposta = z.infer<typeof parcelaPropostaSchema>;

/**
 * Prestação como o calcProsp DEVOLVE. Atenção: `dtVctPre` com P maiúsculo —
 * o cadastrarProposta espera `dtVctpre` (minúsculo). Mapear na Fase 3.
 */
export const calcProspPrestacaoSchema = z
  .object({
    tpParc: z.number().int(),
    nrPresta: z.number().int(),
    vlPrinc: z.number(),
    vlJuros: z.number(),
    vlPresta: z.number(),
    dtVctPre: dateInt,
    vlTotal: z.number(),
  })
  .passthrough();

export type CalcProspPrestacao = z.infer<typeof calcProspPrestacaoSchema>;

/**
 * Response REAL do calcProsp, capturada em HML (2026-08-04) com o payload de
 * referência — reproduziu exatamente os valores do contrato validado
 * (vlPresta 416.78, vlTotal 25006.80). Nomes divergem do cadastrarProposta:
 * txAm/txAa (vs txFinmes/txFinano), txCetAm/txCetAa (vs txCetMes/txCetAno),
 * vlIof (vs vlIofCob), prestacoes (vs parcelas).
 */
export const calcProspResponseSchema = z
  .object({
    calculo: z
      .object({
        vlLiquid: z.number(),
        vlPresta: z.number(),
        vlIof: z.number(),
        vlTac: z.number().optional(),
        vlOutvlr: z.number().optional(),
        vlContra: z.number(),
        vlSeguro: z.number().optional(),
        dtVct1ap: dateInt,
        dtVctult: dateInt,
        txAm: z.number(),
        txAa: z.number().optional(),
        txCetAm: z.number(),
        txCetAa: z.number().optional(),
        qtPrest: z.number().int(),
        vlEncarg: z.number().optional(),
        vlTotal: z.number(),
        prestacoes: z.array(calcProspPrestacaoSchema),
      })
      .passthrough(),
  })
  .passthrough();

export type CalcProspResponse = z.infer<typeof calcProspResponseSchema>;
export type CalcProspCalculo = CalcProspResponse["calculo"];

/* ------------------------------------------------------------------ */
/* 2. primeiro-vencimento                                               */
/* ------------------------------------------------------------------ */

export const primeiroVencimentoRequestSchema = z.object({
  cdProduto: z.number().int(),
  dtContrato: dateInt,
});

export type PrimeiroVencimentoRequest = z.infer<typeof primeiroVencimentoRequestSchema>;

/* ------------------------------------------------------------------ */
/* 3. cadastrarProposta                                                 */
/* ------------------------------------------------------------------ */

/**
 * Bloco `principal` — dados financeiros consolidados. Tipos conforme o payload
 * real: atenção a `cdConven` (STRING "111"), `nrAgenc`/`nrConta` (STRING),
 * `cdLoja` (NUMBER), e à dupla dtVct1Ap/dtVct1ap (a API usa as DUAS grafias).
 */
export const propostaPrincipalSchema = z
  .object({
    idSimul: z.string().optional(), // "S" na referência
    nrProsp: z.string().optional(), // devolvido/usado em alteração
    idCarctr: z.number().int().optional(),
    nrClient: z.number().int().optional(),
    nrCpfCnpj: z.string().optional(),
    cdConven: z.string().optional(), // string "111"
    cdLoja: z.number().int().optional(), // number 111
    qtPresta: z.number().int().optional(),
    dtVct1Ap: dateInt.optional(),
    dtVct1ap: dateInt.optional(), // grafia duplicada existe no payload real
    dtContra: dateInt.optional(),
    dtVctult: dateInt.optional(),
    vlFinan: z.number().optional(),
    vlPresta: z.number().optional(),
    cdProdut: z.number().int().optional(),
    vlConces: z.number().optional(),
    vlOutvlr: z.number().optional(),
    vlSeguro: z.number().optional(),
    txRefCdc: z.number().optional(),
    idPeriod: z.number().int().optional(),
    idPerjur: z.number().int().optional(),
    idTipIof: z.string().optional(), // "I"
    idConces: z.string().optional(), // "F"
    idSeguro: z.string().optional(), // "F"
    idOutvlr: z.string().optional(), // "F"
    idFamort: z.number().int().optional(), // 2
    dsFamort: z.string().optional(), // "Ano final"
    vlContra: z.number().optional(),
    vlIofCob: z.number().optional(),
    vlLiquid: z.number().optional(),
    vlTotal: z.number().optional(),
    txFinano: z.number().optional(),
    txCetMes: z.number().optional(),
    txCetAno: z.number().optional(),
    txFinmes: z.number().optional(),
    pzMedio: z.number().optional(),
    nrMatric: z.string().optional(),
    idAcao: z.string().optional(), // "AL" no payload completo — [a validar] p/ criação
    nrBanco: z.number().int().optional(),
    nrAgenc: z.string().optional(), // string
    nrConta: z.string().optional(), // string
    dtAbert: dateInt.optional(),
    idLojist: z.string().optional(), // "N"
  })
  .passthrough();

export type PropostaPrincipal = z.infer<typeof propostaPrincipalSchema>;

/**
 * `fichaCadastralCliente` — repete dados do cliente dentro da proposta.
 *
 * ATENÇÃO: os TIPOS aqui divergem do cadastrarCliente (módulo Clientes)!
 * No payload real da proposta: nrDDD/nrTel/nrDDDCel/nrCel são STRING,
 * idUniao é NUMBER (2) e idGrinst é STRING ("1") — o inverso do cadastro.
 * Por isso o cliente aqui é um objeto frouxo, não o clienteSchema estrito.
 * No MVP ("cliente já existe") enviamos o mínimo que a API exigir a partir
 * de nrClient/CPF. // [a validar] qual é esse mínimo.
 */
export const fichaCadastralClienteSchema = z
  .object({
    step: z.string().optional(), // "GA" observado
    idRetConsistencias: z.string().optional(), // "S"
    idOrigemRequest: z.string().optional(), // "SQ"
    cliente: z
      .object({
        nrClient: z.number().int().optional(),
        nrCpfCnpj: z.string().optional(),
        dsNome: z.string().optional(),
      })
      .passthrough(),
  })
  .passthrough();

/**
 * Request completo de POST /BJ21SS0501H/cadastrarProposta.
 * `step` controla a etapa do workflow (observado "GA" = Garantias).
 * // [a validar] qual step salva a proposta como "Contrato em Assinatura".
 */
export const cadastrarPropostaRequestSchema = z
  .object({
    step: z.string().optional(),
    principal: propostaPrincipalSchema,
    fichaCadastralCliente: fichaCadastralClienteSchema.optional(),
    parcelas: z.array(parcelaPropostaSchema).optional(),
  })
  .passthrough();

export type CadastrarPropostaRequest = z.infer<typeof cadastrarPropostaRequestSchema>;

/* ------------------------------------------------------------------ */
/* Domínios fixos                                                       */
/* ------------------------------------------------------------------ */

/**
 * Característica da Proposta (idCarctr) — domínio fixo documentado no swagger
 * (campo Principal.idCarctr). 31 = Crédito Pessoal é o caso da CCB.
 */
export const CARACTERISTICAS_PROPOSTA = [
  { codigo: 5, label: "CDC" },
  { codigo: 10, label: "Veículos" },
  { codigo: 11, label: "Equipamentos" },
  { codigo: 20, label: "Bens" },
  { codigo: 30, label: "Consignado" },
  { codigo: 31, label: "Crédito Pessoal" },
  { codigo: 32, label: "Consignado Privado" },
  { codigo: 34, label: "Consignado INSS" },
  { codigo: 41, label: "Renegociação" },
  { codigo: 43, label: "Refinanciamento" },
  { codigo: 50, label: "Desconto de Recebíveis" },
  { codigo: 51, label: "Saque-aniversário FGTS" },
  { codigo: 60, label: "Crédito Imobiliário" },
  { codigo: 70, label: "BNDES" },
  { codigo: 80, label: "Antecipação de Cartão" },
  { codigo: 90, label: "Proposta Eletrônica" },
  { codigo: 91, label: "Empréstimo" },
  { codigo: 92, label: "Financiamento" },
] as const;

/* ------------------------------------------------------------------ */
/* Parâmetros do lote de propostas (configurados na tela)               */
/* ------------------------------------------------------------------ */

/**
 * O que NÃO vem do Emissoes.xlsx e vale para o lote inteiro.
 * Defaults extraídos do payload de referência validado.
 */
export const propostaLoteParamsSchema = z.object({
  txJuros: z.number().positive().default(12),
  cdProd: z.number().int().default(1015),
  idCarCtr: z.number().int().default(31),
  cdConven: z.string().default("111"),
  cdLoja: z.number().int().default(111),
  /** Data do contrato (AAAAMMDD). Sem default — o operador informa por lote. */
  dtContra: dateInt.optional(),
  /** Dados bancários de liberação — [a validar] obrigatoriedade na criação. */
  nrBanco: z.number().int().optional(),
  nrAgenc: z.string().optional(),
  nrConta: z.string().optional(),
});

export type PropostaLoteParams = z.infer<typeof propostaLoteParamsSchema>;

/* ------------------------------------------------------------------ */
/* Conferência: calculado (API) × planilha (Excel)                      */
/* ------------------------------------------------------------------ */

/** Divergência acima disto (em centavos) marca a linha e exige revisão. */
export const TOLERANCIA_DIVERGENCIA_CENTAVOS = 1;

export interface Divergencia {
  campo: string;
  excel: number;
  calculado: number;
}

/** Compara em CENTAVOS INTEIROS — float faria 0.01 virar 0.010000000000019. */
function divergeAcimaDaTolerancia(a: number, b: number): boolean {
  return Math.abs(Math.round(a * 100) - Math.round(b * 100)) > TOLERANCIA_DIVERGENCIA_CENTAVOS;
}

/**
 * Compara o retorno do calcProsp com os valores do Excel.
 * Só compara o que o Excel tem (null = sem baseline, não é divergência).
 *
 * Semântica CONFIRMADA empiricamente em HML (2026-08-05, linha real do Emissoes):
 * o request leva vlContra = LÍQUIDO; a Sinqia financia TAC/Seguro/Outros por
 * cima e devolve vlContra = FINANCIADO e vlLiquid = líquido. Com dtContra
 * correto, os três campos fecham no centavo com a planilha.
 */
export function conferirCalculo(
  excel: {
    vlParcelaInicial: number | null;
    vlLiquido: number | null;
    vlFinanciado: number | null;
  },
  calculo: { vlPresta: number; vlLiquid: number; vlContra: number },
): Divergencia[] {
  const divergencias: Divergencia[] = [];
  if (
    excel.vlParcelaInicial !== null &&
    divergeAcimaDaTolerancia(calculo.vlPresta, excel.vlParcelaInicial)
  ) {
    divergencias.push({
      campo: "Parcela",
      excel: excel.vlParcelaInicial,
      calculado: calculo.vlPresta,
    });
  }
  if (
    excel.vlFinanciado !== null &&
    divergeAcimaDaTolerancia(calculo.vlContra, excel.vlFinanciado)
  ) {
    divergencias.push({
      campo: "Financiado",
      excel: excel.vlFinanciado,
      calculado: calculo.vlContra,
    });
  }
  if (excel.vlLiquido !== null && divergeAcimaDaTolerancia(calculo.vlLiquid, excel.vlLiquido)) {
    divergencias.push({ campo: "Líquido", excel: excel.vlLiquido, calculado: calculo.vlLiquid });
  }
  return divergencias;
}
