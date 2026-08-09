import {
  conferirCalculo,
  type CadastrarClienteRequest,
  type CalcProspRequest,
  type MovimentacaoSodPayload,
  type PropostaLoteItemSodPayload,
  type PropostaSodPayload,
  type TipoAcaoSod,
} from "@cadastro-lote/shared";
import type {
  cadastrarCliente,
  calcProsp,
  consultarHistoricoProposta,
  consultarStatusTransf,
  transferirStatus,
  TransfStatusInput,
} from "./../sinqia-client.js";
import { criarUma, SessaoExpiradaError } from "./../criacao-job.js";
import type { RequisicaoSod } from "./repositorio.js";

/**
 * Esteira de Aprovação (SoD) — EXECUTORES por tipo de ação (decisão B2').
 *
 * Cada tipo registrado em `EXECUTORES` sabe executar o payload persistido da
 * requisição na SESSÃO DO APROVADOR. As dependências Sinqia entram por
 * `ExecucaoDeps` (injetáveis nos testes); o contexto (token + ator) vem da
 * sessão de quem aprovou. Tipo aprovado sem executor vira `falha` registrada
 * (nunca exceção solta) — a rota de decisão cuida disso.
 */

/** Dependências Sinqia da execução — o runtime injeta as reais, o teste, spies. */
export interface ExecucaoDeps {
  cadastrarClienteFn: typeof cadastrarCliente;
  calcProspFn: typeof calcProsp;
  criarUmaFn: typeof criarUma;
  /** Movimentação de proposta (US-08) — o MESMO cliente do fluxo direto. */
  transferirStatusFn: typeof transferirStatus;
  consultarStatusTransfFn: typeof consultarStatusTransf;
  consultarHistoricoPropostaFn: typeof consultarHistoricoProposta;
}

/** Sessão do aprovador: token para a Sinqia + login para a base local. */
export interface ContextoExecucao {
  token: string;
  ator: string;
}

/** Desfecho interno de uma execução — vira `resultado` da requisição (RN05). */
export interface ResultadoExecucao {
  desfecho: "executada" | "falha";
  /** true = a Sinqia respondeu 401 no meio — a sessão do aprovador morreu. */
  sessaoExpirou: boolean;
  /** Resposta/erro INTEGRAL, anexado à requisição e à auditoria. */
  resultado: Record<string, unknown>;
  /** Resumo legível para a UI (identificação do que foi criado / erro). */
  publico: {
    desfecho: "executada" | "falha";
    httpStatus: number | null;
    mensagens: string;
    detalhe?: string;
  };
}

export function falhaExecucao(
  resultado: Record<string, unknown>,
  publico: { httpStatus: number | null; mensagens: string; detalhe?: string },
  sessaoExpirou = false,
): ResultadoExecucao {
  return {
    desfecho: "falha",
    sessaoExpirou,
    resultado: { origem: "sinqia", desfecho: "falha", ...resultado },
    publico: { desfecho: "falha", ...publico },
  };
}

/**
 * Executor do cadastro individual de tomador (US-03): o MESMO cliente
 * (`cadastrarCliente`) e o MESMO payload persistido na criação da requisição
 * (`payload.request` — RN05/RN08 da US-02), no token da SESSÃO DO APROVADOR.
 */
async function executarCadastroTomador(
  requisicao: RequisicaoSod,
  ctx: ContextoExecucao,
  deps: ExecucaoDeps,
): Promise<ResultadoExecucao> {
  const request = requisicao.payload.request;
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    return falhaExecucao(
      { causa: "payload_sem_request", mensagem: "A requisição não contém o request Sinqia montado." },
      { httpStatus: null, mensagens: "Payload da requisição sem o request Sinqia montado." },
    );
  }

  try {
    const r = await deps.cadastrarClienteFn(ctx.token, request as CadastrarClienteRequest);

    if (r.httpStatus === 401) {
      return falhaExecucao(
        {
          causa: "sessao_expirada_durante_execucao",
          mensagem: "O token da Sinqia expirou durante a execução.",
          httpStatus: r.httpStatus,
        },
        {
          httpStatus: r.httpStatus,
          mensagens: "O token da Sinqia expirou durante a execução.",
        },
        true,
      );
    }

    // Mesma regra do fluxo direto: o ENVELOPE decide, não o HTTP 200.
    const integral: Record<string, unknown> = {
      origem: "sinqia",
      httpStatus: r.httpStatus,
      envelopeStatus: r.analysis.envelopeStatus,
      globalMessage: r.analysis.globalMessage,
      mensagens: r.analysis.messagesText,
      envelope: r.envelope,
      ...(r.rawBody ? { rawBody: r.rawBody } : {}),
    };

    if (r.analysis.ok) {
      return {
        desfecho: "executada",
        sessaoExpirou: false,
        resultado: { ...integral, desfecho: "executada" },
        publico: {
          desfecho: "executada",
          httpStatus: r.httpStatus,
          mensagens: r.analysis.messagesText,
        },
      };
    }
    return falhaExecucao(
      { ...integral, causa: "erro_negocio", detalhe: r.analysis.reason },
      {
        httpStatus: r.httpStatus,
        mensagens: r.analysis.messagesText || r.analysis.globalMessage || "",
        detalhe: r.analysis.reason,
      },
    );
  } catch (e) {
    // Indisponibilidade/timeout — sem retry automático (RN07): falha é repouso.
    return falhaExecucao(
      { causa: "indisponibilidade_ou_timeout", mensagem: (e as Error).message },
      { httpStatus: null, mensagens: (e as Error).message },
    );
  }
}

/**
 * Executor da criação individual de proposta (US-04), em duas etapas na
 * sessão do aprovador:
 *
 *  1. CÁLCULO OFICIAL: o `calcProsp` roda de novo com o `calcRequest`
 *     persistido — decisão do PM (checkpoint A): o cálculo da Sinqia na
 *     execução é o correto; os valores do requisitante são só referência.
 *     Cálculo recusado → `falha` (causa `calculo_reprovado`), nada é criado.
 *  2. CRIAÇÃO: reusa `criarUma` — exatamente o caminho do fluxo direto
 *     (busca do cliente, guarda de duplicidade Sinqia, builder, TAC via
 *     vlConces, registro na base local) — para a proposta aparecer no painel
 *     como qualquer outra.
 *
 * Divergência entre referência e cálculo oficial NÃO bloqueia (o oficial
 * vence), mas fica registrada no resultado para o drawer e a auditoria.
 */
async function executarCriacaoProposta(
  requisicao: RequisicaoSod,
  ctx: ContextoExecucao,
  deps: ExecucaoDeps,
): Promise<ResultadoExecucao> {
  const payload = requisicao.payload as unknown as Partial<PropostaSodPayload>;
  const proposta = payload.proposta;
  const calcRequest = payload.calcRequest;
  if (!proposta?.cpf || !proposta.params || !calcRequest || typeof calcRequest !== "object") {
    return falhaExecucao(
      { causa: "payload_invalido", mensagem: "A requisição não contém os insumos da proposta." },
      { httpStatus: null, mensagens: "Payload da requisição sem os insumos da proposta." },
    );
  }

  // 1. Cálculo OFICIAL na sessão do aprovador.
  let calculoOficial;
  try {
    calculoOficial = await deps.calcProspFn(ctx.token, calcRequest as CalcProspRequest);
  } catch (e) {
    return falhaExecucao(
      { causa: "indisponibilidade_ou_timeout", etapa: "calculo", mensagem: (e as Error).message },
      { httpStatus: null, mensagens: (e as Error).message },
    );
  }
  if (calculoOficial.httpStatus === 401) {
    return falhaExecucao(
      {
        causa: "sessao_expirada_durante_execucao",
        etapa: "calculo",
        mensagem: "O token da Sinqia expirou durante o cálculo oficial.",
        httpStatus: 401,
      },
      { httpStatus: 401, mensagens: "O token da Sinqia expirou durante o cálculo oficial." },
      true,
    );
  }
  if (!calculoOficial.calculo) {
    // A Sinqia recusou o cálculo: o requisitante precisa rever os insumos.
    return falhaExecucao(
      {
        causa: "calculo_reprovado",
        etapa: "calculo",
        httpStatus: calculoOficial.httpStatus,
        mensagens: calculoOficial.analysis.messagesText,
        detalhe: calculoOficial.analysis.reason,
        ...(calculoOficial.rawBody ? { rawBody: calculoOficial.rawBody.slice(0, 2000) } : {}),
      },
      {
        httpStatus: calculoOficial.httpStatus,
        mensagens:
          calculoOficial.analysis.messagesText ||
          "A Sinqia não devolveu o cálculo oficial da proposta.",
        detalhe: calculoOficial.analysis.reason,
      },
    );
  }
  const oficial = calculoOficial.calculo;

  // Divergência referência × oficial: informativa (o oficial vence).
  const centavosDiferem = (a: number | null | undefined, b: number | null | undefined) =>
    typeof a === "number" && typeof b === "number" && Math.round(a * 100) !== Math.round(b * 100);
  const ref = payload.referencia?.resumo;
  const divergencias: Array<{ campo: string; referencia: number; oficial: number }> = [];
  if (ref) {
    if (centavosDiferem(ref.vlPresta, oficial.vlPresta)) {
      divergencias.push({ campo: "vlPresta", referencia: ref.vlPresta, oficial: oficial.vlPresta });
    }
    if (centavosDiferem(ref.vlFinanciado, oficial.vlContra)) {
      divergencias.push({
        campo: "vlFinanciado",
        referencia: ref.vlFinanciado,
        oficial: oficial.vlContra,
      });
    }
  }

  /*
   * CONFERÊNCIA AUTOMÁTICA do lote de propostas (US-07, RN02): itens vindos
   * do Emissões carregam `conferencia` (valores da PLANILHA, rotulados) e,
   * diferentemente da referência acima, ela BLOQUEIA: cálculo oficial fora da
   * tolerância (1 centavo, a mesma da fase de cálculo) → `falha` com o
   * comparativo esperado × calculado, NADA é criado. Requisições individuais
   * (US-04) não têm o campo — comportamento intacto.
   */
  const conferencia = (payload as Partial<PropostaLoteItemSodPayload>).conferencia;
  if (conferencia && typeof conferencia === "object") {
    const reprovadas = conferirCalculo(
      {
        vlParcelaInicial: conferencia.vlParcelaInicial ?? null,
        vlLiquido: conferencia.vlLiquido ?? null,
        vlFinanciado: conferencia.vlFinanciado ?? null,
      },
      oficial,
    );
    if (reprovadas.length > 0) {
      const comparativo = reprovadas.map((d) => ({
        campo: d.campo,
        esperado: d.excel,
        calculado: d.calculado,
      }));
      const resumoComparativo = comparativo
        .map((c) => `${c.campo}: esperado R$ ${c.esperado.toFixed(2)} × calculado R$ ${c.calculado.toFixed(2)}`)
        .join("; ");
      return falhaExecucao(
        {
          causa: "conferencia_reprovada",
          etapa: "conferencia",
          httpStatus: calculoOficial.httpStatus,
          comparativo,
          calculoOficial: oficial,
          conferencia,
          mensagem: `Conferência automática reprovada — ${resumoComparativo}.`,
        },
        {
          httpStatus: calculoOficial.httpStatus,
          mensagens: `Conferência automática reprovada — ${resumoComparativo}.`,
          detalhe:
            "O cálculo oficial divergiu da planilha além da tolerância de 1 centavo; nada foi criado.",
        },
      );
    }
  }

  // 2. Criação pelo MESMO caminho do fluxo direto, com o cálculo oficial.
  let criacao;
  try {
    criacao = await deps.criarUmaFn(
      ctx.token,
      { linha: 1, nome: proposta.nome ?? "", cpf: proposta.cpf, calculo: oficial },
      proposta.params,
      proposta.forcarDuplicada === true,
      { usuario: ctx.ator, origem: "individual" },
    );
  } catch (e) {
    if (e instanceof SessaoExpiradaError) {
      return falhaExecucao(
        {
          causa: "sessao_expirada_durante_execucao",
          etapa: "criacao",
          mensagem: "O token da Sinqia expirou durante a criação da proposta.",
        },
        { httpStatus: null, mensagens: "O token da Sinqia expirou durante a criação da proposta." },
        true,
      );
    }
    return falhaExecucao(
      { causa: "indisponibilidade_ou_timeout", etapa: "criacao", mensagem: (e as Error).message },
      { httpStatus: null, mensagens: (e as Error).message },
    );
  }

  // Resultado INTEGRAL (RN05): cálculo oficial + desfecho da criação.
  const integral: Record<string, unknown> = {
    origem: "sinqia",
    etapa: "criacao",
    httpStatus: criacao.httpStatus,
    nrProsp: criacao.nrProsp,
    nrClient: criacao.nrClient,
    envelopeStatus: criacao.envelopeStatus,
    globalMessage: criacao.globalMessage,
    mensagens: criacao.messages,
    calculoOficial: oficial,
    ...(divergencias.length > 0 ? { divergenciasReferencia: divergencias } : {}),
  };

  if (criacao.status === "OK") {
    const aviso =
      divergencias.length > 0
        ? " (valores oficiais divergiram da referência — o oficial prevaleceu)"
        : "";
    return {
      desfecho: "executada",
      sessaoExpirou: false,
      resultado: { ...integral, desfecho: "executada" },
      publico: {
        desfecho: "executada",
        httpStatus: criacao.httpStatus,
        mensagens:
          `Proposta nº ${criacao.nrProsp ?? "—"} criada com o cálculo oficial: ` +
          `${oficial.qtPrest}x de R$ ${oficial.vlPresta.toFixed(2)}, ` +
          `financiado R$ ${oficial.vlContra.toFixed(2)}${aviso}.`,
      },
    };
  }

  if (criacao.status === "JA_EXISTE") {
    // Proposta idêntica surgiu na Sinqia entre a requisição e a aprovação —
    // nada foi criado; divergência de estado externo é falha registrada.
    return falhaExecucao(
      { ...integral, causa: "duplicidade_sinqia", detalhe: criacao.detail },
      { httpStatus: criacao.httpStatus, mensagens: criacao.messages, detalhe: criacao.detail },
    );
  }

  return falhaExecucao(
    { ...integral, causa: "erro_negocio", detalhe: criacao.detail },
    { httpStatus: criacao.httpStatus, mensagens: criacao.messages, detalhe: criacao.detail },
  );
}

/**
 * Executor da movimentação individual de proposta (US-08), em duas etapas na
 * sessão do aprovador:
 *
 *  1. PRÉ-VERIFICAÇÃO DE DIVERGÊNCIA EXTERNA (Cenário 4): consulta o
 *     histórico da proposta na Sinqia e exige que o status ATUAL seja a etapa
 *     de ORIGEM da requisição. A proposta pode ter sido movida por fora
 *     (Portal Sinqia) entre a criação e a aprovação — nesse caso NADA é
 *     movido: `falha` com causa `divergencia_externa`, o comparativo
 *     esperado × atual e as etapas válidas a partir do status atual
 *     (capturadas quando a consulta as devolve). O bloqueio permanece (RN03);
 *     a resolução é retry/descarte na US-10.
 *  2. MOVIMENTAÇÃO: reusa `transferirStatus` — exatamente o cliente do fluxo
 *     direto — com o `request` PERSISTIDO na requisição (RN05/RN08), no token
 *     do aprovador. Rejeição da Sinqia → `falha` com a resposta integral.
 */
async function executarMovimentacaoProposta(
  requisicao: RequisicaoSod,
  ctx: ContextoExecucao,
  deps: ExecucaoDeps,
): Promise<ResultadoExecucao> {
  const payload = requisicao.payload as unknown as Partial<MovimentacaoSodPayload>;
  const mov = payload.movimentacao;
  const request = payload.request;
  if (
    !mov?.nrProsp ||
    !mov.origem ||
    !mov.destino ||
    !request ||
    typeof request !== "object" ||
    Array.isArray(request)
  ) {
    return falhaExecucao(
      {
        causa: "payload_invalido",
        mensagem: "A requisição não contém os dados da movimentação.",
      },
      { httpStatus: null, mensagens: "Payload da requisição sem os dados da movimentação." },
    );
  }

  /** Etapas válidas a partir de um status — melhor-esforço, nunca derruba a falha. */
  const capturarEtapasValidas = async (nrStatus: number) => {
    try {
      const r = await deps.consultarStatusTransfFn(ctx.token, mov.nrWf, nrStatus);
      return r.httpStatus < 400 ? r.transicoes : undefined;
    } catch {
      return undefined;
    }
  };

  // 1. Status ATUAL da proposta (histórico Sinqia; o maior nrSeq é o vigente).
  let statusAtual: number | null = null;
  let dsStatusAtual = "";
  try {
    const hist = await deps.consultarHistoricoPropostaFn(ctx.token, String(mov.nrProsp));
    if (hist.httpStatus === 401) {
      return falhaExecucao(
        {
          causa: "sessao_expirada_durante_execucao",
          etapa: "verificacao",
          mensagem: "O token da Sinqia expirou durante a verificação da proposta.",
          httpStatus: 401,
        },
        { httpStatus: 401, mensagens: "O token da Sinqia expirou durante a verificação da proposta." },
        true,
      );
    }
    const vigente = hist.historicos.reduce<(typeof hist.historicos)[number] | null>(
      (max, h) => (max === null || h.nrSeq > max.nrSeq ? h : max),
      null,
    );
    if (hist.httpStatus >= 400 || !vigente || vigente.nrStatus === null) {
      return falhaExecucao(
        {
          causa: "indisponibilidade_ou_timeout",
          etapa: "verificacao",
          httpStatus: hist.httpStatus,
          mensagem:
            `Não foi possível confirmar a etapa atual da proposta ${mov.nrProsp} na Sinqia — ` +
            "nada foi movido.",
        },
        {
          httpStatus: hist.httpStatus,
          mensagens: `Não foi possível confirmar a etapa atual da proposta ${mov.nrProsp} — nada foi movido.`,
        },
      );
    }
    statusAtual = vigente.nrStatus;
    dsStatusAtual = vigente.dsStatus;
  } catch (e) {
    return falhaExecucao(
      { causa: "indisponibilidade_ou_timeout", etapa: "verificacao", mensagem: (e as Error).message },
      { httpStatus: null, mensagens: (e as Error).message },
    );
  }

  if (statusAtual !== mov.origem.nrStatus) {
    // Divergência EXTERNA (Cenário 4): a proposta saiu da etapa de origem por
    // fora da plataforma — nada é movido; o comparativo e as etapas válidas
    // atuais vão INTEGRAIS para o resultado (insumo do retry/descarte, US-10).
    const etapasValidas = await capturarEtapasValidas(statusAtual);
    const mensagem =
      `A proposta ${mov.nrProsp} não está mais na etapa de origem da requisição: ` +
      `esperava "${mov.origem.dsStatus}" (status ${mov.origem.nrStatus}) e a Sinqia mostra ` +
      `"${dsStatusAtual}" (status ${statusAtual}). Nada foi movido.`;
    return falhaExecucao(
      {
        causa: "divergencia_externa",
        etapa: "verificacao",
        esperado: mov.origem,
        atual: { nrStatus: statusAtual, dsStatus: dsStatusAtual },
        ...(etapasValidas ? { etapasValidas } : {}),
        mensagem,
      },
      {
        httpStatus: null,
        mensagens: mensagem,
        detalhe: "Divergência externa — resolução por retry ou descarte (US-10).",
      },
    );
  }

  // 2. Movimentação pelo MESMO cliente do fluxo direto, com o request persistido.
  try {
    const r = await deps.transferirStatusFn(ctx.token, request as unknown as TransfStatusInput);
    if (r.httpStatus === 401) {
      return falhaExecucao(
        {
          causa: "sessao_expirada_durante_execucao",
          etapa: "movimentacao",
          mensagem: "O token da Sinqia expirou durante a movimentação.",
          httpStatus: 401,
        },
        { httpStatus: 401, mensagens: "O token da Sinqia expirou durante a movimentação." },
        true,
      );
    }
    if (!r.ok) {
      // Rejeição da Sinqia na própria transferência: resposta integral + as
      // etapas que o workflow permite a partir da origem (quando consultáveis).
      const etapasValidas = await capturarEtapasValidas(mov.origem.nrStatus);
      return falhaExecucao(
        {
          causa: "movimentacao_rejeitada",
          etapa: "movimentacao",
          httpStatus: r.httpStatus,
          respostaSinqia: r.detalhe,
          ...(etapasValidas ? { etapasValidas } : {}),
          mensagem: `A Sinqia não confirmou a movimentação da proposta ${mov.nrProsp}: ${r.detalhe}`,
        },
        {
          httpStatus: r.httpStatus,
          mensagens: `A Sinqia não confirmou a movimentação: ${r.detalhe}`,
        },
      );
    }
    return {
      desfecho: "executada",
      sessaoExpirou: false,
      resultado: {
        origem: "sinqia",
        desfecho: "executada",
        httpStatus: r.httpStatus,
        respostaSinqia: r.detalhe,
        de: mov.origem,
        para: mov.destino,
      },
      publico: {
        desfecho: "executada",
        httpStatus: r.httpStatus,
        mensagens:
          `Proposta nº ${mov.nrProsp} movida de "${mov.origem.dsStatus}" para ` +
          `"${mov.destino.dsStatus}".`,
      },
    };
  } catch (e) {
    // Indisponibilidade/timeout — sem retry automático (RN07): falha é repouso.
    return falhaExecucao(
      { causa: "indisponibilidade_ou_timeout", etapa: "movimentacao", mensagem: (e as Error).message },
      { httpStatus: null, mensagens: (e as Error).message },
    );
  }
}

/**
 * Registro de executores por tipo de ação — o ponto de extensão que cada US
 * de novo tipo alimenta (US-04 acrescentou `proposta.criar`; a Onda 2
 * acrescenta os demais).
 */
export type Executor = (
  requisicao: RequisicaoSod,
  ctx: ContextoExecucao,
  deps: ExecucaoDeps,
) => Promise<ResultadoExecucao>;

export const EXECUTORES: Partial<Record<TipoAcaoSod, Executor>> = {
  "tomador.cadastrar": executarCadastroTomador,
  "proposta.criar": executarCriacaoProposta,
  "proposta.movimentar": executarMovimentacaoProposta,
};
