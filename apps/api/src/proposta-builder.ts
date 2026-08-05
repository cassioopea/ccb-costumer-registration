import {
  cadastrarPropostaRequestSchema,
  type CadastrarPropostaRequest,
  type CalcProspCalculo,
} from "@cadastro-lote/shared";
import { env } from "./env.js";

/**
 * Monta o cadastrarProposta a partir do CÁLCULO retido (Fase 2) + dados do
 * cliente buscados na hora + parâmetros do lote.
 *
 * Modelado sobre os payloads gravados do Portal de Crédito:
 *  - base = variante "menor" (principal + parcelas) + fichaCadastralCliente
 *    mínima (cliente já existe — decisão do Cassio: enviar o mínimo e corrigir
 *    se a API exigir mais);
 *  - SEM `idAcao` no principal ("AL" do exemplo completo era alteração);
 *  - SEM nrProsp (criação — a Sinqia gera);
 *  - SEM dados bancários (a variante "menor" não os envia) // [a validar];
 *  - mapeamentos de nome: prestacoes→parcelas, dtVctPre→dtVctpre,
 *    txAm/txAa→txFinmes/txFinano, txCetAm/txCetAa→txCetMes/txCetAno,
 *    vlIof→vlIofCob, qtPrest→qtPresta.
 */

export interface PropostaClienteInfo {
  /** nrClient AUTORITATIVO, vindo do buscarCliente por CPF no ambiente ativo. */
  nrClient: number;
  nrCpfCnpj: string;
  dsNome: string;
}

export interface PropostaLoteParamsCriacao {
  txJuros: number;
  cdProd: number;
  idCarCtr: number;
  cdConven: string;
  /** Ausente = proposta sem loja/filial. */
  cdLoja?: number;
  dtContra: number;
}

export function buildPropostaPayload(
  cliente: PropostaClienteInfo,
  calculo: CalcProspCalculo,
  params: PropostaLoteParamsCriacao,
): CadastrarPropostaRequest {
  const step = env.SINQIA_PROPOSTA_STEP;

  const payload: CadastrarPropostaRequest = {
    step,
    principal: {
      idSimul: "S",
      idCarctr: params.idCarCtr,
      nrClient: cliente.nrClient,
      nrCpfCnpj: cliente.nrCpfCnpj,
      cdConven: params.cdConven,
      ...(params.cdLoja !== undefined ? { cdLoja: params.cdLoja } : {}),
      qtPresta: calculo.qtPrest,
      dtVct1Ap: calculo.dtVct1ap,
      dtVct1ap: calculo.dtVct1ap, // a API usa as DUAS grafias (payload real)
      dtContra: params.dtContra,
      dtVctult: calculo.dtVctult,
      vlFinan: calculo.vlContra, // total financiado (líquido + encargos)
      vlPresta: calculo.vlPresta,
      cdProdut: params.cdProd,
      /**
       * TAC (Custos de Bancarização) vai em vlConces — "Valor da Concessão".
       * Confirmado por exemplo funcional (2026-08-05): calcProsp recebe vlTac
       * e a proposta persiste o mesmo valor em vlConces; a INTEGRAÇÃO para
       * contrato lê este campo (proposta sem ele integrou com financiado menor
       * e parcela errada). idConces "F" = financiada, como no cálculo.
       */
      vlConces: calculo.vlTac ?? 0,
      vlOutvlr: calculo.vlOutvlr ?? 0,
      vlSeguro: calculo.vlSeguro ?? 0,
      txRefCdc: params.txJuros,
      idPeriod: 1,
      idPerjur: 1,
      idTipIof: "I",
      idConces: "F",
      idSeguro: "F",
      idOutvlr: "F",
      idFamort: 2,
      dsFamort: "Ano final",
      vlContra: calculo.vlContra,
      vlIofCob: calculo.vlIof,
      vlLiquid: calculo.vlLiquid,
      vlTotal: calculo.vlTotal,
      txFinano: calculo.txAa ?? 0,
      txCetMes: calculo.txCetAm,
      txCetAno: calculo.txCetAa ?? 0,
      txFinmes: calculo.txAm,
      pzMedio: 0,
      nrMatric: "",
      idLojist: "N",
    },
    fichaCadastralCliente: {
      step,
      idRetConsistencias: "S",
      idOrigemRequest: "SQ",
      cliente: {
        nrClient: cliente.nrClient,
        nrCpfCnpj: cliente.nrCpfCnpj,
        dsNome: cliente.dsNome,
      },
    },
    parcelas: calculo.prestacoes.map((p) => ({
      tpParc: p.tpParc,
      nrPresta: p.nrPresta,
      vlPrinc: p.vlPrinc,
      vlJuros: p.vlJuros,
      vlPresta: p.vlPresta,
      vlTotal: p.vlTotal,
      dtVctpre: p.dtVctPre, // ← grafia diferente entre cálculo e proposta
    })),
  };

  return cadastrarPropostaRequestSchema.parse(payload);
}
