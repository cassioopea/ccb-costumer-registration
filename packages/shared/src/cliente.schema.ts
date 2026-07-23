import { z } from "zod";
import {
  idAcaoEnum,
  tpRelacaoTrabEnum,
  cdCapitalEnum,
  tpSocioEnum,
  cdSetorEnum,
  idGrinstEnum,
  idEtniaEnum,
  idConstiEnum,
  idContAcioEnum,
  idUniaoEnum,
} from "./enums.js";

/**
 * Schema do objeto `cliente` da API Sinqia (BJ21M05 / cadastrarCliente).
 *
 * PRINCÍPIOS (confirmados pelo payload PF validado em produção-HML):
 *  - A maioria dos campos é OPCIONAL. Só incluir o que for usado (orientação BRQ).
 *  - NÃO enviar chaves com valor vazio/null só para preencher.
 *  - Tipos importam: alguns "códigos numéricos" trafegam como STRING
 *    (ex.: idUniao "2", tpImovel "1", nrConta, dvConta, nrDoc, nrCep, nrCpfCnpj).
 *  - Datas são inteiros AAAAMMDD (ex.: 20090416).
 *  - `idAcao` só aparece dentro de arrays/alguns objetos; para cadastro novo = "IN".
 *    NÃO forçar idAcao em dadosPf/dadosProfissionais (o exemplo real não envia).
 */

/** Data no formato inteiro AAAAMMDD (ex.: 20090416). */
export const dateInt = z
  .number()
  .int()
  .refine((v) => v === 0 || (v >= 1_00_00 && v <= 99_99_12_31), {
    message: "Data deve ser inteiro no formato AAAAMMDD (ex.: 20090416) ou 0",
  });

/** number opcional (aceita 0). */
const num = z.number();
/** number com casas decimais (valores monetários). */
const decimal = z.number();
/** string livre. */
const str = z.string();

/* ------------------------------------------------------------------ */
/* Arrays / objetos aninhados                                          */
/* ------------------------------------------------------------------ */

export const bemImovelSchema = z
  .object({
    idAcao: idAcaoEnum.optional(),
    cdPais: num.optional(),
    dsCompl: str.optional(),
    nmBairro: str.optional(),
    nmCidade: str.optional(),
    nmEnd: str.optional(),
    nmImovel: str.optional(),
    nrCep: str.optional(),
    nrEnd: str.optional(),
    sgEstado: str.optional(),
    tpImovel: str.optional(), // código numérico que trafega como string ("1")
    vlImovel: decimal.optional(),
  })
  .passthrough();

export const bemMovelSchema = z
  .object({
    idAcao: idAcaoEnum.optional(),
    aaFabric: num.optional(),
    aaModelo: num.optional(),
    cdRenavam: str.optional(),
    dsBem: str.optional(),
    dsSituac: str.optional(),
    vlBem: decimal.optional(),
  })
  .passthrough();

export const cartaoCreditoSchema = z
  .object({
    idAcao: idAcaoEnum.optional(),
    nrBanco: num.optional(),
    dsBandeira: str.optional(),
    vlLimite: decimal.optional(),
  })
  .passthrough();

export const dadosBancariosSchema = z
  .object({
    idAcao: idAcaoEnum.optional(),
    nrBanco: num.optional(),
    nrAgencia: num.optional(),
    nrConta: str.optional(), // string
    dvConta: str.optional(), // string
    tpConta: str.optional(),
    dtAbert: dateInt.optional(),
    idPrincipal: str.optional(), // "S"/"N"
  })
  .passthrough();

export const enderecoSchema = z
  .object({
    idAcao: idAcaoEnum.optional(),
    tpEnd: num.optional(), // 1-4
    tpMorad: num.optional(), // 1-6
    nrCep: str.optional(),
    dsEnd: str.optional(),
    nrEnd: str.optional(),
    dsBairro: str.optional(),
    dsCidade: str.optional(),
    sgEstado: str.optional(),
    nrDDD: num.optional(),
    nrTel: num.optional(),
    nrDDDCel: num.optional(),
    nrCel: num.optional(),
    idPrinc: str.optional(),
  })
  .passthrough();

export const dadosProfissionaisSchema = z
  .object({
    // idAcao NÃO é enviado aqui no exemplo validado — opcional, sem forçar.
    idAcao: idAcaoEnum.optional(),
    cdProf: num.optional(),
    dsCargo: str.optional(),
    dsEmpres: str.optional(),
    dtAdmis: dateInt.optional(),
    vlRendaBruta: decimal.optional(),
    vlRendaLiquida: decimal.optional(),
    tpRelacaoTrab: tpRelacaoTrabEnum.optional(),
    cdPais: num.optional(),
    cdPorte: num.optional(),
    cdLoctb: num.optional(),
    nrCep: str.optional(),
    nmEnd: str.optional(),
    nrEnd: str.optional(),
    nmBairro: str.optional(),
    nmCidade: str.optional(),
    sgEstado: str.optional(),
  })
  .passthrough();

export const refPessoalSchema = z
  .object({
    nome: str.optional(),
    nrDDDTel: num.optional(),
    nrTel: num.optional(),
  })
  .passthrough();

export const socioSchema = z
  .object({
    idAcao: idAcaoEnum.optional(),
    tpSocio: tpSocioEnum.optional(),
    dsNome: str.optional(),
    nrCpfCnpj: str.optional(),
    vlPart: decimal.optional(),
  })
  .passthrough();

/* PF: dados de pessoa física */
export const dadosPfSchema = z
  .object({
    tpEman: str.optional(),
    dtNasc: dateInt.optional(),
    tpSexo: str.optional(),
    cdProf: num.optional(),
    tpDoc: num.optional(),
    nrDoc: str.optional(),
    sgEmissor: str.optional(),
    dtEmissao: dateInt.optional(),
    sgEstadoNat: str.optional(),
    cdEstCivil: num.optional(),
    idUniao: idUniaoEnum.optional(), // "1"/"2" — string; Sinqia rejeita outros valores
    nomeMae: str.optional(),
    nomePai: str.optional(),
    naturalidade: num.optional(),
    nomeCidadeNaturalidade: str.optional(),
    nacionalidade: num.optional(),
    idGrinst: idGrinstEnum.optional(),
    idEtnia: idEtniaEnum.optional(),
    nrDepend: num.optional(),
    idLe6515: str.optional(),
    cdPais: num.optional(),
  })
  .passthrough();

/* PJ: dados de pessoa jurídica */
export const dadosPjSchema = z
  .object({
    idAcao: idAcaoEnum.optional(),
    amFatMes: decimal.optional(),
    cdSetor: cdSetorEnum.optional(),
    cdTribute: num.optional(),
    cdPorte: num.optional(),
    cdCapital: cdCapitalEnum.optional(), // "N"/"E"/"M" string
    dtAberturaEmpresa: dateInt.optional(),
    dtUltBal: dateInt.optional(),
    idConsti: idConstiEnum.optional(),
    idContAcio: idContAcioEnum.optional(), // "1"/"2" string
    idEncBal: num.optional(),
    nomeFantasia: str.optional(),
    nrInscEst: str.optional(),
    nrInscMun: str.optional(),
    nrNire: str.optional(),
    qtFiliais: num.optional(),
    qtFuncio: num.optional(),
    vlFatMes: decimal.optional(),
  })
  .passthrough();

/* ------------------------------------------------------------------ */
/* Objeto cliente (nível raiz de dados cadastrais)                     */
/* ------------------------------------------------------------------ */

export const clienteSchema = z
  .object({
    // Identificação
    dsNome: str.optional(),
    nrCpfCnpj: str.optional(), // string sem máscara; 11=PF, 14=PJ
    // Endereço principal
    sgEstado: str.optional(),
    nrCep: str.optional(),
    dsEnd: str.optional(),
    nrEnd: str.optional(),
    dsBairro: str.optional(),
    dsCidade: str.optional(),
    dsCompl: str.optional(),
    tpEnd: num.optional(),
    tpResid: num.optional(),
    // Contato
    dsEmail: str.optional(),
    nrDDD: num.optional(),
    nrTel: num.optional(),
    nrDDDCel: num.optional(),
    nrCel: num.optional(),
    nmUrl: str.optional(),
    // Códigos / classificação
    cdPess: num.optional(),
    cdPais: num.optional(),
    cdGrupo: num.optional(),
    cdSituac: num.optional(),
    dsSituac: str.optional(),
    cdAtvCl: num.optional(),
    cdAutscr: str.optional(), // "S"
    cdRamoAtiv: num.optional(),
    cdRating: str.optional(),
    // Datas
    dtAbert: dateInt.optional(),
    dtValcad: dateInt.optional(),
    // Moradia / patrimônio (nível cliente)
    amResid: num.optional(),
    vlAluguel: decimal.optional(),
    vlImovel: decimal.optional(),
    vlPrestacaoFinanciada: decimal.optional(),
    // LGPD / consistências / ações
    idLgpd: str.optional(),
    inconsistenciasCadastrais: z.array(z.unknown()).optional(),
    idAcaoCliente: idAcaoEnum.optional(),
    idAcaoEndereco: idAcaoEnum.optional(),

    // Objetos aninhados
    dadosPf: dadosPfSchema.optional(),
    dadosPj: dadosPjSchema.optional(),
    dadosProfissionais: dadosProfissionaisSchema.optional(),
    conjuge: z.record(z.string(), z.unknown()).optional(),
    dadosHistoricoFinanceiro: z.record(z.string(), z.unknown()).optional(),

    // Arrays
    listaDadosProfissionais: z.array(dadosProfissionaisSchema).optional(),
    dadosBancarios: z.array(dadosBancariosSchema).optional(),
    bensImoveis: z.array(bemImovelSchema).optional(),
    bensMoveis: z.array(bemMovelSchema).optional(),
    cartoesCredito: z.array(cartaoCreditoSchema).optional(),
    enderecos: z.array(enderecoSchema).optional(),
    refPessoais: z.array(refPessoalSchema).optional(),
    socios: z.array(socioSchema).optional(),
    consentimentos: z.array(z.record(z.string(), z.unknown())).optional(),
    exposicaoPolitica: z.array(z.record(z.string(), z.unknown())).optional(),
    fornecedoresClientes: z.array(z.record(z.string(), z.unknown())).optional(),
    infoSocioeconomicas: z.array(z.record(z.string(), z.unknown())).optional(),
    partOutrasEmpresas: z.array(z.record(z.string(), z.unknown())).optional(),
  })
  // Mantém campos extras do modelo Swagger que não listamos explicitamente,
  // já que "usar só o necessário" implica um conjunto aberto.
  .passthrough()
  // Refinamento condicional PF/PJ pelo comprimento do documento.
  .superRefine((c, ctx) => {
    if (!c.nrCpfCnpj) return; // documento é validado como obrigatório no nível do request
    const doc = c.nrCpfCnpj.replace(/\D/g, "");
    if (doc.length === 11) {
      if (c.dadosPj) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["dadosPj"],
          message: "CPF (11 dígitos) é PF — não envie o bloco dadosPj.",
        });
      }
    } else if (doc.length === 14) {
      if (c.dadosPf) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["dadosPf"],
          message: "CNPJ (14 dígitos) é PJ — não envie o bloco dadosPf.",
        });
      }
    } else {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["nrCpfCnpj"],
        message: "nrCpfCnpj deve ter 11 (PF) ou 14 (PJ) dígitos.",
      });
    }
  });

export type Cliente = z.infer<typeof clienteSchema>;

/** Detecta PF/PJ pelo comprimento do documento (11=PF, 14=PJ). */
export function detectTipoPessoa(nrCpfCnpj: string | undefined): "PF" | "PJ" | "?" {
  const doc = (nrCpfCnpj ?? "").replace(/\D/g, "");
  if (doc.length === 11) return "PF";
  if (doc.length === 14) return "PJ";
  return "?";
}
