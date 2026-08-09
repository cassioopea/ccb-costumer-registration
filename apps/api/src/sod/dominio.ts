import { randomUUID } from "node:crypto";
import {
  derivarDesfechoLote,
  ehTipoLote,
  extrairDocumentoSod,
  normalizarLogin,
  ROTULO_TIPO_ACAO,
  temDuplicidades,
  transicaoItemPermitida,
  transicaoPermitida,
  type DuplicidadesLote,
  type EstadoRequisicao,
  type ExcecaoLote,
  type TipoAcaoSod,
} from "@cadastro-lote/shared";
import {
  ehViolacaoBloqueioMovimentacao,
  ehViolacaoBloqueioMovimentacaoItem,
  ehViolacaoDuplicidadeItemPendente,
  ehViolacaoDuplicidadePendente,
  type ItemLoteSod,
  type MovimentacaoAtivaSod,
  type RequisicaoSod,
  type SodRepositorio,
} from "./repositorio.js";

/**
 * Esteira de Aprovação (SoD) — camada de DOMÍNIO.
 *
 * TODA mutação de requisição passa por aqui (regra transversal do CONTEXTO-SOD):
 * máquina de estados (RN02), maker-checker (RN03), motivo obrigatório (RN07) e
 * trilha de auditoria (RN06) — incluindo as tentativas REJEITADAS, que são
 * auditadas ANTES de o erro subir.
 */

export type CodigoErroSod =
  | "REQUISICAO_NAO_ENCONTRADA"
  | "TRANSICAO_INVALIDA"
  | "VIOLACAO_SOD"
  | "MOTIVO_OBRIGATORIO"
  | "CANCELAMENTO_NEGADO"
  | "DUPLICIDADE_PENDENTE"
  | "MOVIMENTACAO_BLOQUEADA"
  | "LOTE_INVALIDO";

export class SodError extends Error {
  constructor(
    public readonly codigo: CodigoErroSod,
    mensagem: string,
    /** Dados estruturados que a rota anexa à resposta (ex.: requisição existente). */
    public readonly extra?: Record<string, unknown>,
  ) {
    super(mensagem);
    this.name = "SodError";
  }
}

/** Nomes das ações na trilha de auditoria. */
export const ACAO_AUDITORIA = {
  criacao: "requisicao_criada",
  transicao: "transicao_estado",
  tentativaRejeitada: "tentativa_rejeitada",
  inicioExecucao: "execucao_iniciada",
} as const;

export function criarSodServico(
  repo: SodRepositorio,
  /** Injetável para os testes (mesmo padrão do `agora` em session.ts). */
  agora: () => string = () => new Date().toISOString(),
) {
  /** Audita uma tentativa rejeitada e lança o erro correspondente. */
  function rejeitar(
    codigo: CodigoErroSod,
    mensagem: string,
    contexto: {
      requisicaoId: string | null;
      ator: string;
      detalhe: Record<string, unknown>;
      /** Vai no SodError para a rota devolver estruturado (não entra na auditoria). */
      extra?: Record<string, unknown>;
    },
  ): never {
    repo.inserirEvento({
      requisicaoId: contexto.requisicaoId,
      ator: contexto.ator,
      acao: ACAO_AUDITORIA.tentativaRejeitada,
      detalhe: { ...contexto.detalhe, mensagem },
      resultado: `rejeitada:${codigo.toLowerCase()}`,
      ts: agora(),
    });
    throw new SodError(codigo, mensagem, contexto.extra);
  }

  function exigirRequisicao(id: string, ator: string, operacao: string): RequisicaoSod {
    const req = repo.obterRequisicao(id);
    if (!req) {
      // Sem requisição não há o que auditar por vínculo — o evento fica órfão
      // de propósito (requisicaoId null) para a tentativa ainda assim constar.
      rejeitar("REQUISICAO_NAO_ENCONTRADA", `Requisição ${id} não encontrada.`, {
        requisicaoId: null,
        ator,
        detalhe: { operacao, idInformado: id },
      });
    }
    return req;
  }

  /**
   * Núcleo de toda transição: valida a máquina de estados, aplica o UPDATE
   * atômico (primeira decisão vence) e audita — sucesso ou rejeição.
   */
  function transicionar(params: {
    req: RequisicaoSod;
    para: EstadoRequisicao;
    ator: string;
    decisao: string;
    motivo?: string;
    resultado?: Record<string, unknown>;
    ehDecisor?: boolean;
  }): RequisicaoSod {
    const { req, para, ator, decisao } = params;

    if (!transicaoPermitida(req.estado, para)) {
      // Também é o caminho da decisão CONCORRENTE que releu tarde demais: quem
      // perde recebe o estado atual e quem decidiu (Cenário 5 da US-03).
      rejeitar(
        "TRANSICAO_INVALIDA",
        `Transição inválida: ${req.estado} → ${para} (requisição ${req.id}` +
          (req.decididoPor ? `, decidida por ${req.decididoPor}` : "") +
          `).`,
        {
          requisicaoId: req.id,
          ator,
          detalhe: { decisao, de: req.estado, para },
          extra: { estadoAtual: req.estado, decididoPor: req.decididoPor },
        },
      );
    }

    const ok = repo.transicionar({
      id: req.id,
      de: req.estado,
      para,
      decididoPor: params.ehDecisor ? ator : undefined,
      motivo: params.motivo,
      resultado: params.resultado,
      agora: agora(),
      evento: {
        requisicaoId: req.id,
        ator,
        acao: ACAO_AUDITORIA.transicao,
        detalhe: {
          decisao,
          de: req.estado,
          para,
          ...(params.motivo ? { motivo: params.motivo } : {}),
          // Resultado integral da execução (resposta/erro Sinqia) também na
          // trilha — a auditoria conta a história completa sozinha.
          ...(params.resultado ? { resultado: params.resultado } : {}),
        },
        resultado: "ok",
        ts: agora(),
      },
    });

    if (!ok) {
      // Corrida perdida: outra decisão mudou o estado entre a leitura e o
      // UPDATE. A primeira venceu (RN: jamais segunda execução) — audita e erra.
      // Quem perdeu recebe o estado atual E quem decidiu (Cenário 5 da US-03).
      const atual = repo.obterRequisicao(req.id);
      rejeitar(
        "TRANSICAO_INVALIDA",
        `Decisão não aplicada: a requisição ${req.id} já saiu de "${req.estado}" ` +
          `(estado atual: "${atual?.estado ?? "desconhecido"}"` +
          (atual?.decididoPor ? `, decidida por ${atual.decididoPor}` : "") +
          `).`,
        {
          requisicaoId: req.id,
          ator,
          detalhe: { decisao, de: req.estado, para, estadoAtual: atual?.estado ?? null },
          extra: {
            estadoAtual: atual?.estado ?? null,
            decididoPor: atual?.decididoPor ?? null,
          },
        },
      );
    }

    const depois = repo.obterRequisicao(req.id);
    if (!depois) throw new Error(`Requisição ${req.id} sumiu após transição — estado inconsistente.`);
    return depois;
  }

  /**
   * Núcleo da decisão de LOTE (US-06): valida as máquinas (lote + itens),
   * aplica tudo em UMA transação com "primeira decisão vence" e audita —
   * sucesso ou rejeição. Usado pela decisão bidirecional e pelo cancelamento.
   */
  function aplicarDecisaoLoteInterno(params: {
    req: RequisicaoSod;
    para: EstadoRequisicao;
    ator: string;
    decisao: string;
    motivo?: string;
    ehDecisor?: boolean;
    /** Contexto extra do evento do lote (direção-base, exceções…). */
    detalheLote?: Record<string, unknown>;
    itens: Array<{
      item: ItemLoteSod;
      para: EstadoRequisicao;
      motivo?: string;
      origem?: string;
    }>;
  }): RequisicaoSod {
    const { req, para, ator, decisao } = params;

    if (!transicaoPermitida(req.estado, para)) {
      rejeitar(
        "TRANSICAO_INVALIDA",
        `Transição inválida: ${req.estado} → ${para} (requisição ${req.id}` +
          (req.decididoPor ? `, decidida por ${req.decididoPor}` : "") +
          `).`,
        {
          requisicaoId: req.id,
          ator,
          detalhe: { decisao, de: req.estado, para },
          extra: { estadoAtual: req.estado, decididoPor: req.decididoPor },
        },
      );
    }
    for (const { item, para: paraItem } of params.itens) {
      // Programação defensiva: quem chama já filtra pendentes — item fora da
      // máquina aqui é bug interno, não entrada do usuário.
      if (!transicaoItemPermitida(item.estado, paraItem)) {
        throw new Error(
          `Transição de item inválida: ${item.estado} → ${paraItem} (item ${item.id} do lote ${req.id}).`,
        );
      }
    }

    const ts = agora();
    const ok = repo.aplicarDecisaoLote({
      id: req.id,
      de: req.estado,
      para,
      decididoPor: params.ehDecisor ? ator : undefined,
      motivo: params.motivo,
      agora: ts,
      eventoLote: {
        requisicaoId: req.id,
        ator,
        acao: ACAO_AUDITORIA.transicao,
        detalhe: {
          decisao,
          de: req.estado,
          para,
          ...(params.motivo ? { motivo: params.motivo } : {}),
          ...(params.detalheLote ?? {}),
        },
        resultado: "ok",
        ts,
      },
      itens: params.itens.map(({ item, para: paraItem, motivo, origem }) => ({
        id: item.id,
        de: item.estado,
        para: paraItem,
        motivo,
        evento: {
          requisicaoId: req.id,
          ator,
          acao: ACAO_AUDITORIA.transicao,
          detalhe: {
            itemId: item.id,
            ordem: item.ordem,
            decisao,
            de: item.estado,
            para: paraItem,
            ...(motivo ? { motivo } : {}),
            ...(origem ? { origem } : {}),
          },
          resultado: "ok",
          ts,
        },
      })),
    });

    if (!ok) {
      // Corrida perdida entre aprovadores: a primeira decisão do lote venceu.
      const atual = repo.obterRequisicao(req.id);
      rejeitar(
        "TRANSICAO_INVALIDA",
        `Decisão não aplicada: o lote ${req.id} já saiu de "${req.estado}" ` +
          `(estado atual: "${atual?.estado ?? "desconhecido"}"` +
          (atual?.decididoPor ? `, decidida por ${atual.decididoPor}` : "") +
          `).`,
        {
          requisicaoId: req.id,
          ator,
          detalhe: { decisao, de: req.estado, para, estadoAtual: atual?.estado ?? null },
          extra: {
            estadoAtual: atual?.estado ?? null,
            decididoPor: atual?.decididoPor ?? null,
          },
        },
      );
    }

    const depois = repo.obterRequisicao(req.id);
    if (!depois) throw new Error(`Requisição ${req.id} sumiu após decisão de lote.`);
    return depois;
  }

  /**
   * Conferência RN06 (tridimensional) — consulta pura, sem efeito colateral.
   * Para itens de `proposta.movimentar` (US-09), a régua NÃO é "pendente" e
   * sim o BLOQUEIO da US-08 (pendente/executando/falha, fonte única
   * individual+lote) — a mesma definição dos índices do banco.
   */
  function conferirDuplicidadesLoteInterno(
    tipoItem: TipoAcaoSod,
    entradas: Array<{ ordem: number; documento: string | null }>,
  ): DuplicidadesLote {
    const porDocumento = new Map<string, number[]>();
    for (const e of entradas) {
      if (!e.documento) continue;
      const ordens = porDocumento.get(e.documento) ?? [];
      ordens.push(e.ordem);
      porDocumento.set(e.documento, ordens);
    }
    const dups: DuplicidadesLote = {
      intraArquivo: [],
      pendentesIndividuais: [],
      pendentesLote: [],
    };
    for (const [documento, ordens] of porDocumento) {
      if (ordens.length > 1) dups.intraArquivo.push({ documento, ordens });
      if (tipoItem === "proposta.movimentar") {
        const ativa = repo.movimentacaoAtivaPorDocumento(documento);
        if (ativa) {
          const lista = ativa.itemId ? dups.pendentesLote : dups.pendentesIndividuais;
          for (const ordem of ordens) {
            lista.push({ documento, ordem, requisicaoId: ativa.id });
          }
        }
        continue;
      }
      const individual = repo.pendentePorDocumento(tipoItem, documento);
      if (individual) {
        for (const ordem of ordens) {
          dups.pendentesIndividuais.push({ documento, ordem, requisicaoId: individual.id });
        }
      }
      const item = repo.itemPendentePorDocumento(tipoItem, documento);
      if (item) {
        for (const ordem of ordens) {
          dups.pendentesLote.push({ documento, ordem, requisicaoId: item.requisicaoId });
        }
      }
    }
    return dups;
  }

  /** Maker-checker (RN03): quem decide nunca é quem criou. */
  function exigirSegundoOperador(req: RequisicaoSod, ator: string, decisao: string): void {
    if (normalizarLogin(ator) === req.requisitante) {
      rejeitar(
        "VIOLACAO_SOD",
        "Violação de segregação de funções: o criador da requisição não pode decidi-la.",
        {
          requisicaoId: req.id,
          ator: normalizarLogin(ator),
          detalhe: { decisao, requisitante: req.requisitante },
        },
      );
    }
  }

  function exigirMotivo(
    req: RequisicaoSod,
    ator: string,
    decisao: string,
    motivo: string | undefined,
  ): string {
    const limpo = motivo?.trim() ?? "";
    if (!limpo) {
      rejeitar("MOTIVO_OBRIGATORIO", `Motivo é obrigatório para ${decisao} (RN07).`, {
        requisicaoId: req.id,
        ator: normalizarLogin(ator),
        detalhe: { decisao, de: req.estado },
      });
    }
    return limpo;
  }

  /**
   * Guarda de duplicidade (RN02): audita a tentativa e lança
   * DUPLICIDADE_PENDENTE referenciando a requisição pendente existente.
   */
  function rejeitarDuplicidade(params: {
    existente: RequisicaoSod;
    tipo: TipoAcaoSod;
    documento: string;
    ator: string;
  }): never {
    const { existente, tipo, documento, ator } = params;
    // A "chave" de tomador é o próprio documento; a de proposta é a assinatura
    // (RN04, US-04) — a mensagem descreve cada uma no vocabulário do negócio.
    const descricaoChave =
      tipo === "proposta.criar"
        ? "com a mesma assinatura (tomador, produto, parcelas, valores e 1º vencimento)"
        : `para o documento ${documento}`;
    rejeitar(
      "DUPLICIDADE_PENDENTE",
      `Já existe uma requisição pendente de ${ROTULO_TIPO_ACAO[tipo].toLowerCase()} ${descricaoChave} ` +
        `(requisição ${existente.id}, criada por ${existente.requisitante} em ${existente.criadoEm}). ` +
        `Aguarde a decisão dela ou cancele-a antes de criar outra.`,
      {
        requisicaoId: existente.id,
        ator,
        detalhe: { operacao: "criar", tipo, documento, requisicaoExistente: existente.id },
        extra: {
          requisicaoExistente: {
            id: existente.id,
            estado: existente.estado,
            requisitante: existente.requisitante,
            criadoEm: existente.criadoEm,
          },
        },
      },
    );
  }

  /**
   * Bloqueio de movimentação (US-08, RN03): já existe movimentação ATIVA
   * (pendente/executando/falha) para a proposta — requisição individual OU
   * item de lote (US-09, fonte única) — audita a tentativa e rejeita com a
   * requisição existente estruturada.
   */
  function rejeitarMovimentacaoBloqueada(params: {
    existente: MovimentacaoAtivaSod;
    documento: string;
    ator: string;
  }): never {
    const { existente, documento, ator } = params;
    const emFalha = existente.estado === "falha";
    const morada = existente.itemId
      ? `item ${existente.itemOrdem ?? "?"} da requisição-lote ${existente.id}`
      : `requisição ${existente.id}`;
    rejeitar(
      "MOVIMENTACAO_BLOQUEADA",
      `A proposta ${documento} já tem uma movimentação ativa ` +
        `(${morada}, estado "${existente.estado}", criada por ` +
        `${existente.requisitante} em ${existente.criadoEm}). ` +
        (emFalha
          ? "A falha precisa ser resolvida (retry ou descarte) antes de nova movimentação."
          : "Aguarde a decisão dela ou cancele-a antes de mover novamente."),
      {
        requisicaoId: existente.id,
        ator,
        detalhe: {
          operacao: "criar",
          tipo: "proposta.movimentar",
          documento,
          requisicaoExistente: existente.id,
          estadoExistente: existente.estado,
          ...(existente.itemId ? { itemExistente: existente.itemId } : {}),
        },
        extra: {
          requisicaoExistente: {
            id: existente.id,
            estado: existente.estado,
            requisitante: existente.requisitante,
            criadoEm: existente.criadoEm,
            ...(existente.itemId
              ? { itemId: existente.itemId, itemOrdem: existente.itemOrdem, lote: true }
              : {}),
          },
        },
      },
    );
  }

  return {
    /**
     * Cria a requisição em `pendente` com payload integral e identidade
     * normalizada. Tipos com documento passam pela guarda de duplicidade
     * (RN02): já havendo pendente do mesmo documento, nada é criado.
     * `proposta.movimentar` (US-08) tem guarda própria, mais larga: uma
     * requisição ATIVA por proposta (falha inclusive — RN03).
     */
    criarRequisicao(entrada: {
      tipo: TipoAcaoSod;
      payload: Record<string, unknown>;
      requisitante: string;
    }): RequisicaoSod {
      const requisitante = normalizarLogin(entrada.requisitante);
      if (!requisitante) throw new Error("Requisitante vazio — sessão sem login utilizável.");

      const documento = extrairDocumentoSod(entrada.tipo, entrada.payload);
      if (entrada.tipo === "proposta.movimentar") {
        if (!documento) {
          throw new Error(
            "Payload de movimentação sem o nº da proposta — a guarda de bloqueio é obrigatória.",
          );
        }
        const ativa = repo.movimentacaoAtivaPorDocumento(documento);
        if (ativa) {
          rejeitarMovimentacaoBloqueada({ existente: ativa, documento, ator: requisitante });
        }
      } else if (documento) {
        const existente = repo.pendentePorDocumento(entrada.tipo, documento);
        if (existente) {
          rejeitarDuplicidade({ existente, tipo: entrada.tipo, documento, ator: requisitante });
        }
        // RN06 (US-06), recíproca: documento pendente como ITEM de lote também
        // bloqueia a individual — a regra é "uma pendência por documento",
        // independentemente do envelope (individual ou lote).
        const itemPendente = repo.itemPendentePorDocumento(entrada.tipo, documento);
        if (itemPendente) {
          const lote = repo.obterRequisicao(itemPendente.requisicaoId);
          rejeitar(
            "DUPLICIDADE_PENDENTE",
            `O documento ${documento} já está pendente no item ${itemPendente.ordem} de uma ` +
              `requisição-lote (${itemPendente.requisicaoId}` +
              (lote ? `, criada por ${lote.requisitante} em ${lote.criadoEm}` : "") +
              `). Aguarde a decisão do lote ou cancele-o antes de criar outra.`,
            {
              requisicaoId: itemPendente.requisicaoId,
              ator: requisitante,
              detalhe: { operacao: "criar", tipo: entrada.tipo, documento, itemId: itemPendente.id },
              extra: {
                requisicaoExistente: lote
                  ? {
                      id: lote.id,
                      estado: lote.estado,
                      requisitante: lote.requisitante,
                      criadoEm: lote.criadoEm,
                    }
                  : { id: itemPendente.requisicaoId },
              },
            },
          );
        }
      }

      const id = randomUUID();
      const ts = agora();
      try {
        repo.criarRequisicao(
          { id, tipo: entrada.tipo, payload: entrada.payload, documento, requisitante, criadoEm: ts },
          {
            requisicaoId: id,
            ator: requisitante,
            acao: ACAO_AUDITORIA.criacao,
            detalhe: { tipo: entrada.tipo, payload: entrada.payload },
            resultado: "ok",
            ts,
          },
        );
      } catch (e) {
        // Corrida perdida (US-08, Cenário 3): outra movimentação da MESMA
        // proposta inseriu entre a checagem e o INSERT — exatamente uma vence,
        // decidido pelo índice `idx_sod_req_mov_ativa` no banco.
        if (
          entrada.tipo === "proposta.movimentar" &&
          documento &&
          ehViolacaoBloqueioMovimentacao(e)
        ) {
          const ativa = repo.movimentacaoAtivaPorDocumento(documento);
          if (ativa) {
            rejeitarMovimentacaoBloqueada({ existente: ativa, documento, ator: requisitante });
          }
        }
        // Corrida perdida: outra submissão do mesmo documento inseriu entre a
        // checagem e o INSERT — o índice único parcial garantiu a RN02.
        if (documento && ehViolacaoDuplicidadePendente(e)) {
          const existente = repo.pendentePorDocumento(entrada.tipo, documento);
          if (existente) {
            rejeitarDuplicidade({ existente, tipo: entrada.tipo, documento, ator: requisitante });
          }
        }
        throw e;
      }
      const criada = repo.obterRequisicao(id);
      if (!criada) throw new Error(`Requisição ${id} não encontrada logo após criar.`);
      return criada;
    },

    /** Decisão de aprovação: pendente → aprovada/executando (execução chega na US-03). */
    aprovar(id: string, aprovador: string): RequisicaoSod {
      const req = exigirRequisicao(id, normalizarLogin(aprovador), "aprovar");
      exigirSegundoOperador(req, aprovador, "aprovar");
      return transicionar({
        req,
        para: "aprovada/executando",
        ator: normalizarLogin(aprovador),
        decisao: "aprovar",
        ehDecisor: true,
      });
    },

    /** Decisão de reprovação: pendente → reprovada. Motivo obrigatório (RN07). */
    reprovar(id: string, aprovador: string, motivo: string | undefined): RequisicaoSod {
      const req = exigirRequisicao(id, normalizarLogin(aprovador), "reprovar");
      exigirSegundoOperador(req, aprovador, "reprovar");
      const limpo = exigirMotivo(req, aprovador, "reprovar", motivo);
      return transicionar({
        req,
        para: "reprovada",
        ator: normalizarLogin(aprovador),
        decisao: "reprovar",
        motivo: limpo,
        ehDecisor: true,
      });
    },

    /** Cancelamento: SOMENTE o criador, SOMENTE em `pendente`. */
    cancelar(id: string, solicitante: string): RequisicaoSod {
      const ator = normalizarLogin(solicitante);
      const req = exigirRequisicao(id, ator, "cancelar");
      if (ator !== req.requisitante) {
        rejeitar(
          "CANCELAMENTO_NEGADO",
          "Somente o criador da requisição pode cancelá-la.",
          {
            requisicaoId: req.id,
            ator,
            detalhe: { decisao: "cancelar", requisitante: req.requisitante },
          },
        );
      }
      // Lote (US-06): cancelamento em cascata — os itens pendentes caem junto,
      // na MESMA transação (nunca fica item pendente órfão de lote cancelado).
      if (ehTipoLote(req.tipo)) {
        const pendentes = repo.itensDoLote(req.id).filter((i) => i.estado === "pendente");
        return aplicarDecisaoLoteInterno({
          req,
          para: "cancelada",
          ator,
          decisao: "cancelar",
          itens: pendentes.map((item) => ({ item, para: "cancelada" as const, origem: "lote" })),
        });
      }
      return transicionar({ req, para: "cancelada", ator, decisao: "cancelar" });
    },

    /**
     * Retry manual: falha → aprovada/executando. FUNCIONALIDADE da Onda 2
     * (US-10) — sem rota nesta fase; existe para a máquina de estados nascer
     * completa e testada. Nunca pelo requisitante (mesma regra SoD).
     */
    retryFalha(id: string, aprovador: string): RequisicaoSod {
      const req = exigirRequisicao(id, normalizarLogin(aprovador), "retry");
      exigirSegundoOperador(req, aprovador, "retry");
      return transicionar({
        req,
        para: "aprovada/executando",
        ator: normalizarLogin(aprovador),
        decisao: "retry",
        ehDecisor: true,
      });
    },

    /** Descarte: falha → descartada, motivo obrigatório. Onda 2 (US-10) — sem rota nesta fase. */
    descartarFalha(id: string, ator: string, motivo: string | undefined): RequisicaoSod {
      const req = exigirRequisicao(id, normalizarLogin(ator), "descartar");
      const limpo = exigirMotivo(req, ator, "descartar", motivo);
      return transicionar({
        req,
        para: "descartada",
        ator: normalizarLogin(ator),
        decisao: "descartar",
        motivo: limpo,
        ehDecisor: true,
      });
    },

    /**
     * Marca o INÍCIO da execução na trilha (US-03): entre a transição
     * `pendente → aprovada/executando` e a chamada Sinqia. Evento puro de
     * auditoria — não muda estado.
     */
    registrarInicioExecucao(id: string, ator: string): void {
      const req = exigirRequisicao(id, normalizarLogin(ator), "inicio_execucao");
      repo.inserirEvento({
        requisicaoId: req.id,
        ator: normalizarLogin(ator),
        acao: ACAO_AUDITORIA.inicioExecucao,
        detalhe: { tipo: req.tipo, estado: req.estado },
        resultado: "ok",
        ts: agora(),
      });
    },

    /**
     * Conclusão da execução (US-03): `aprovada/executando → executada|falha`,
     * com a resposta/erro INTEGRAL da Sinqia anexada à requisição (RN05) e à
     * trilha de auditoria. Sem retry automático (RN07): `falha` é repouso.
     */
    concluirExecucao(
      id: string,
      ator: string,
      desfecho: "executada" | "falha",
      resultado: Record<string, unknown> = {},
    ): RequisicaoSod {
      const req = exigirRequisicao(id, normalizarLogin(ator), "concluir_execucao");
      return transicionar({
        req,
        para: desfecho,
        ator: normalizarLogin(ator),
        decisao: "concluir_execucao",
        resultado,
      });
    },

    /**
     * Detalhe: requisição + histórico completo de auditoria dela. Lotes
     * (US-06) trazem também os itens (na ordem do arquivo) e o placar (RN01).
     */
    detalharRequisicao(id: string): {
      requisicao: RequisicaoSod;
      historico: ReturnType<SodRepositorio["eventosDaRequisicao"]>;
      itens?: ItemLoteSod[];
      placar?: ReturnType<SodRepositorio["placarDoLote"]>;
      placarPorTipo?: ReturnType<SodRepositorio["placarPorTipo"]>;
    } {
      const req = repo.obterRequisicao(id);
      if (!req) throw new SodError("REQUISICAO_NAO_ENCONTRADA", `Requisição ${id} não encontrada.`);
      const base = { requisicao: req, historico: repo.eventosDaRequisicao(id) };
      if (!ehTipoLote(req.tipo)) return base;
      return {
        ...base,
        itens: repo.itensDoLote(id),
        placar: repo.placarDoLote(id),
        // Dois níveis (US-07): tomadores × propostas no lote composto.
        placarPorTipo: repo.placarPorTipo(id),
      };
    },

    /**
     * Feature flags por tipo (US-05). `flagAtiva` é a fonte de `aprovacaoAtiva`
     * (flags.ts); `definirFlag` é a ÚNICA porta de mudança (CLI operacional —
     * RN03: sem tela) e exige o ator para a auditoria RN05. Mudança de flag
     * NÃO toca requisição nenhuma (RN04): o ciclo de vida segue soberano.
     */
    flagAtiva: repo.flagAtiva.bind(repo),
    listarFlags: repo.listarFlags.bind(repo),
    definirFlag(tipo: TipoAcaoSod, ativa: boolean, ator: string) {
      const normalizado = normalizarLogin(ator);
      if (!normalizado) {
        throw new Error("Mudança de flag exige o login de quem muda (auditoria RN05).");
      }
      return repo.definirFlag({ tipo, ativa, ator: normalizado, agora: agora() });
    },

    /* ------------------- Requisição-LOTE (US-06) ------------------- */

    /**
     * Conferência de duplicidade TRIDIMENSIONAL (RN06), sem efeito colateral:
     * intra-arquivo + requisições individuais pendentes + itens pendentes de
     * outros lotes, por documento normalizado. A criação usa esta MESMA
     * conferência como guarda; a rota de validação a expõe para a UI apontar
     * os conflitos ANTES do envio.
     */
    conferirDuplicidadesLote: conferirDuplicidadesLoteInterno,

    /**
     * Cria a requisição-LOTE em `pendente`, com todos os itens `pendente` e
     * payload integral por item (RN08), na mesma transação. A guarda RN06
     * roda ANTES (tridimensional) e o índice único parcial cobre a corrida
     * entre uploads simultâneos. Zero Sinqia neste caminho.
     */
    criarRequisicaoLote(entrada: {
      tipo: TipoAcaoSod;
      payload: Record<string, unknown>;
      requisitante: string;
      itens: Array<{
        ordem: number;
        tipo: TipoAcaoSod;
        payload: Record<string, unknown>;
        documento: string | null;
        /**
         * Vínculo tomador→proposta do lote COMPOSTO (US-07): a ORDEM do item
         * de tomador (deste mesmo arquivo) do qual esta proposta depende —
         * o domínio resolve a ordem para o id gerado do item.
         */
        dependeDeOrdem?: number;
      }>;
    }): RequisicaoSod {
      const requisitante = normalizarLogin(entrada.requisitante);
      if (!requisitante) throw new Error("Requisitante vazio — sessão sem login utilizável.");
      if (!ehTipoLote(entrada.tipo)) {
        throw new Error(`Tipo ${entrada.tipo} não é um tipo de lote.`);
      }
      if (entrada.itens.length === 0) {
        rejeitar("LOTE_INVALIDO", "Um lote precisa de ao menos um item.", {
          requisicaoId: null,
          ator: requisitante,
          detalhe: { operacao: "criar_lote", tipo: entrada.tipo },
        });
      }

      const rejeitarDuplicidadeLote = (dups: DuplicidadesLote): never => {
        const partes: string[] = [];
        if (dups.intraArquivo.length > 0) {
          partes.push(`${dups.intraArquivo.length} documento(s) repetido(s) no arquivo`);
        }
        if (dups.pendentesIndividuais.length > 0) {
          partes.push(
            `${dups.pendentesIndividuais.length} linha(s) com requisição individual pendente`,
          );
        }
        if (dups.pendentesLote.length > 0) {
          partes.push(`${dups.pendentesLote.length} linha(s) pendente(s) em outro lote`);
        }
        rejeitar(
          "DUPLICIDADE_PENDENTE",
          `Duplicidade impede a criação do lote: ${partes.join("; ")}. ` +
            `Resolva os conflitos (ou aguarde as decisões pendentes) e envie novamente.`,
          {
            requisicaoId: null,
            ator: requisitante,
            detalhe: { operacao: "criar_lote", tipo: entrada.tipo, duplicidades: dups },
            extra: { duplicidades: dups },
          },
        );
      };

      // Lote COMPOSTO (US-07): itens de mais de um tipo — a conferência RN06
      // roda POR TIPO (a chave de tomador é o documento; a de proposta é a
      // assinatura) e os resultados são somados.
      const tiposDosItens = [...new Set(entrada.itens.map((i) => i.tipo))];
      const conferirTodosOsTipos = (): DuplicidadesLote => {
        const soma: DuplicidadesLote = {
          intraArquivo: [],
          pendentesIndividuais: [],
          pendentesLote: [],
        };
        for (const tipoItem of tiposDosItens) {
          const parcial = conferirDuplicidadesLoteInterno(
            tipoItem,
            entrada.itens
              .filter((i) => i.tipo === tipoItem)
              .map((i) => ({ ordem: i.ordem, documento: i.documento })),
          );
          soma.intraArquivo.push(...parcial.intraArquivo);
          soma.pendentesIndividuais.push(...parcial.pendentesIndividuais);
          soma.pendentesLote.push(...parcial.pendentesLote);
        }
        return soma;
      };
      const dups = conferirTodosOsTipos();
      if (temDuplicidades(dups)) rejeitarDuplicidadeLote(dups);

      const id = randomUUID();
      const ts = agora();

      // Vínculos do lote composto (US-07): resolve dependeDeOrdem → id gerado.
      // Profundidade fixa 1: um item referenciado por outro não pode, ele
      // próprio, depender de terceiro — vínculo inválido é bug de montagem.
      const itensComId = entrada.itens.map((i) => ({ ...i, id: randomUUID() }));
      const porOrdem = new Map(itensComId.map((i) => [i.ordem, i]));
      const referenciados = new Set(
        itensComId.map((i) => i.dependeDeOrdem).filter((o): o is number => o !== undefined),
      );
      for (const i of itensComId) {
        if (i.dependeDeOrdem === undefined) continue;
        const pai = porOrdem.get(i.dependeDeOrdem);
        // `pai.ordem < i.ordem` também garante a ordem de execução (tomador
        // antes da proposta) e a ordem de INSERT que a FK autorreferente exige.
        if (!pai || pai.ordem >= i.ordem || pai.dependeDeOrdem !== undefined) {
          throw new Error(
            `Vínculo inválido no lote: o item ${i.ordem} depende do item ${i.dependeDeOrdem}, ` +
              `que não existe, não vem antes dele ou tem dependência própria (profundidade > 1).`,
          );
        }
        if (referenciados.has(i.ordem)) {
          throw new Error(
            `Vínculo inválido no lote: o item ${i.ordem} depende de outro E é dependido — profundidade > 1.`,
          );
        }
      }

      try {
        repo.criarRequisicaoLote(
          { id, tipo: entrada.tipo, payload: entrada.payload, requisitante, criadoEm: ts },
          itensComId.map((i) => ({
            id: i.id,
            ordem: i.ordem,
            tipo: i.tipo,
            payload: i.payload,
            documento: i.documento,
            dependeDeItemId:
              i.dependeDeOrdem !== undefined ? porOrdem.get(i.dependeDeOrdem)!.id : null,
          })),
          {
            requisicaoId: id,
            ator: requisitante,
            acao: ACAO_AUDITORIA.criacao,
            detalhe: {
              tipo: entrada.tipo,
              payload: entrada.payload,
              totalItens: entrada.itens.length,
            },
            resultado: "ok",
            ts,
          },
        );
      } catch (e) {
        // Corrida perdida: outro lote/arquivo inseriu item pendente do mesmo
        // documento entre a conferência e o INSERT — o índice garantiu a RN06.
        // Para movimentação (US-09), o índice de bloqueio de itens decide a
        // corrida lote×lote pela mesma via.
        if (ehViolacaoDuplicidadeItemPendente(e) || ehViolacaoBloqueioMovimentacaoItem(e)) {
          rejeitarDuplicidadeLote(conferirTodosOsTipos());
        }
        throw e;
      }
      const criada = repo.obterRequisicao(id);
      if (!criada) throw new Error(`Requisição-lote ${id} não encontrada logo após criar.`);
      return criada;
    },

    /**
     * Decisão BIDIRECIONAL do lote (US-06, RN02/RN03): direção-base
     * (aprovar/reprovar) + exceções por item com motivo, aplicada ATOMICAMENTE
     * (primeira decisão do lote vence). Itens reprovados transicionam já na
     * decisão; itens aprovados permanecem `pendente` — a fila de execução —
     * até a reivindicação atômica de cada um (RN05).
     */
    decidirLote(
      id: string,
      aprovador: string,
      entrada: { decisao: "aprovar" | "reprovar"; motivo?: string; excecoes?: ExcecaoLote[] },
    ): { requisicao: RequisicaoSod; aprovados: ItemLoteSod[]; placar: ReturnType<SodRepositorio["placarDoLote"]> } {
      const ator = normalizarLogin(aprovador);
      const req = exigirRequisicao(id, ator, "decidir_lote");
      if (!ehTipoLote(req.tipo)) {
        rejeitar("LOTE_INVALIDO", `A requisição ${id} não é um lote — decida-a individualmente.`, {
          requisicaoId: req.id,
          ator,
          detalhe: { decisao: entrada.decisao, tipo: req.tipo },
        });
      }
      exigirSegundoOperador(req, aprovador, entrada.decisao);

      const itens = repo.itensDoLote(id);
      const pendentes = itens.filter((i) => i.estado === "pendente");
      const porId = new Map(pendentes.map((i) => [i.id, i]));

      const excecoes = entrada.excecoes ?? [];
      const idsExcecao = new Set<string>();
      for (const e of excecoes) {
        const motivoLimpo = e.motivo?.trim() ?? "";
        if (!motivoLimpo) {
          rejeitar("MOTIVO_OBRIGATORIO", "Toda exceção de item exige motivo (RN03).", {
            requisicaoId: req.id,
            ator,
            detalhe: { decisao: entrada.decisao, itemId: e.itemId },
          });
        }
        if (idsExcecao.has(e.itemId) || !porId.has(e.itemId)) {
          rejeitar(
            "LOTE_INVALIDO",
            `Exceção inválida: o item ${e.itemId} não é um item pendente deste lote (ou está repetido).`,
            {
              requisicaoId: req.id,
              ator,
              detalhe: { decisao: entrada.decisao, itemId: e.itemId },
            },
          );
        }
        idsExcecao.add(e.itemId);
      }

      // Motivo do LOTE é obrigatório na reprovação (RN03); na aprovação é livre.
      const motivoLote =
        entrada.decisao === "reprovar"
          ? exigirMotivo(req, aprovador, "reprovar", entrada.motivo)
          : entrada.motivo?.trim() || undefined;

      let aprovados = pendentes.filter((i) =>
        entrada.decisao === "aprovar" ? !idsExcecao.has(i.id) : idsExcecao.has(i.id),
      );
      const reprovados = pendentes.filter((i) =>
        entrada.decisao === "aprovar" ? idsExcecao.has(i.id) : !idsExcecao.has(i.id),
      );
      const motivoPorItem = new Map(excecoes.map((e) => [e.itemId, e.motivo.trim()]));

      /*
       * PROPAGAÇÃO do lote composto (US-07, RN06/Cenário 4): uma proposta
       * vinculada a um tomador que NÃO vai executar não pode executar.
       *  - Direção-base aprovar + exceção no tomador → as propostas
       *    vinculadas são reprovadas JUNTO, com o motivo do tomador propagado
       *    (a UI avisa o impacto antes da confirmação; aqui é a garantia).
       *  - Exceção que APROVA uma proposta cujo tomador está sendo reprovado
       *    é contraditória → decisão inteira rejeitada, nada muda.
       */
      const reprovadosIds = new Set(reprovados.map((i) => i.id));
      const propagados: Array<{ item: ItemLoteSod; paiOrdem: number; motivo: string }> = [];
      for (const item of aprovados) {
        const paiId = item.dependeDeItemId;
        if (!paiId || !reprovadosIds.has(paiId)) continue;
        const pai = porId.get(paiId)!;
        if (idsExcecao.has(item.id)) {
          rejeitar(
            "LOTE_INVALIDO",
            `Exceção contraditória: o item ${item.ordem} (proposta) depende do tomador do ` +
              `item ${pai.ordem}, que está sendo reprovado — aprovar a proposta sem o tomador é impossível.`,
            {
              requisicaoId: req.id,
              ator,
              detalhe: { decisao: entrada.decisao, itemId: item.id, dependeDeItemId: paiId },
            },
          );
        }
        propagados.push({
          item,
          paiOrdem: pai.ordem,
          motivo:
            `Reprovada em propagação: o tomador vinculado (item ${pai.ordem}) foi reprovado — ` +
            (motivoPorItem.get(paiId) ?? motivoLote ?? "sem motivo registrado"),
        });
      }
      const propagadosIds = new Set(propagados.map((p) => p.item.id));
      aprovados = aprovados.filter((i) => !propagadosIds.has(i.id));

      // Só quando HÁ pendentes: sem nenhum, é decisão concorrente atrasada —
      // o núcleo abaixo responde com o estado atual e quem decidiu (409).
      // Conta APÓS a propagação: exceções que derrubam todas as propostas
      // vinculadas também esvaziam a execução.
      if (entrada.decisao === "aprovar" && pendentes.length > 0 && aprovados.length === 0) {
        rejeitar(
          "LOTE_INVALIDO",
          "Nenhuma linha restaria para executar (exceções + propagação de tomadores reprovados) — " +
            "para não executar nada, use a reprovação do lote (motivo obrigatório).",
          {
            requisicaoId: req.id,
            ator,
            detalhe: {
              decisao: entrada.decisao,
              excecoes: excecoes.length,
              propagados: propagados.length,
            },
          },
        );
      }

      const para: EstadoRequisicao = aprovados.length > 0 ? "aprovada/executando" : "reprovada";
      const requisicao = aplicarDecisaoLoteInterno({
        req,
        para,
        ator,
        decisao: entrada.decisao,
        motivo: motivoLote,
        ehDecisor: true,
        detalheLote: {
          direcaoBase: entrada.decisao,
          aprovados: aprovados.length,
          reprovados: reprovados.length + propagados.length,
          // Motivo das exceções APROVADAS (base reprovar) só existe aqui e na
          // trilha — item.motivo é reservado à reprovação.
          excecoes: excecoes.map((e) => ({
            itemId: e.itemId,
            ordem: porId.get(e.itemId)?.ordem ?? null,
            motivo: e.motivo.trim(),
          })),
          ...(propagados.length > 0
            ? {
                propagados: propagados.map((p) => ({
                  itemId: p.item.id,
                  ordem: p.item.ordem,
                  tomadorOrdem: p.paiOrdem,
                })),
              }
            : {}),
        },
        itens: [
          ...reprovados.map((item) => ({
            item,
            para: "reprovada" as const,
            motivo: motivoPorItem.get(item.id) ?? motivoLote,
            origem: idsExcecao.has(item.id) ? "excecao" : "lote",
          })),
          ...propagados.map(({ item, motivo }) => ({
            item,
            para: "reprovada" as const,
            motivo,
            origem: "propagacao",
          })),
        ],
      });

      return { requisicao, aprovados, placar: repo.placarDoLote(id) };
    },

    /**
     * Reivindica UM item para execução (RN05): transição atômica
     * `pendente → aprovada/executando`. Null = o item não estava mais
     * pendente (já executado, reprovado ou reivindicado por outra execução) —
     * o chamador simplesmente pula, sem tocar a Sinqia.
     */
    iniciarItemExecucao(itemId: string, ator: string): ItemLoteSod | null {
      const item = repo.obterItem(itemId);
      if (!item) return null;
      const normalizado = normalizarLogin(ator);
      const ok = repo.transicionarItem({
        id: itemId,
        de: "pendente",
        para: "aprovada/executando",
        agora: agora(),
        evento: {
          requisicaoId: item.requisicaoId,
          ator: normalizado,
          acao: ACAO_AUDITORIA.inicioExecucao,
          detalhe: { itemId, ordem: item.ordem, tipo: item.tipo },
          resultado: "ok",
          ts: agora(),
        },
      });
      return ok ? repo.obterItem(itemId) : null;
    },

    /** Conclui a execução de um item: `aprovada/executando → executada|falha`. */
    concluirItemExecucao(
      itemId: string,
      ator: string,
      desfecho: "executada" | "falha",
      resultado: Record<string, unknown> = {},
    ): ItemLoteSod {
      const item = repo.obterItem(itemId);
      if (!item) throw new Error(`Item ${itemId} não encontrado ao concluir execução.`);
      const ok = repo.transicionarItem({
        id: itemId,
        de: "aprovada/executando",
        para: desfecho,
        resultado,
        agora: agora(),
        evento: {
          requisicaoId: item.requisicaoId,
          ator: normalizarLogin(ator),
          acao: ACAO_AUDITORIA.transicao,
          detalhe: {
            itemId,
            ordem: item.ordem,
            decisao: "concluir_execucao",
            de: "aprovada/executando",
            para: desfecho,
            resultado,
          },
          resultado: "ok",
          ts: agora(),
        },
      });
      if (!ok) {
        throw new Error(
          `Item ${itemId} não estava em execução ao concluir — estado inconsistente.`,
        );
      }
      const depois = repo.obterItem(itemId);
      if (!depois) throw new Error(`Item ${itemId} sumiu após conclusão.`);
      return depois;
    },

    /**
     * Interrupção da execução (Cenário 4): os itens ainda `pendente` vão a
     * `falha` com a causa — nenhum fica órfão, nenhum é executado depois.
     */
    falharItensPendentesDoLote(
      requisicaoId: string,
      ator: string,
      causa: string,
      mensagem: string,
    ): number {
      const normalizado = normalizarLogin(ator);
      let n = 0;
      for (const item of repo.itensDoLote(requisicaoId)) {
        if (item.estado !== "pendente") continue;
        const ok = repo.transicionarItem({
          id: item.id,
          de: "pendente",
          para: "falha",
          resultado: {
            desfecho: "falha",
            causa,
            mensagem,
            publico: { desfecho: "falha", httpStatus: null, mensagens: mensagem },
          },
          agora: agora(),
          evento: {
            requisicaoId,
            ator: normalizado,
            acao: ACAO_AUDITORIA.transicao,
            detalhe: {
              itemId: item.id,
              ordem: item.ordem,
              decisao: "interromper_lote",
              de: "pendente",
              para: "falha",
              causa,
            },
            resultado: "ok",
            ts: agora(),
          },
        });
        if (ok) n++;
      }
      return n;
    },

    /**
     * Falha UM item ainda `pendente` sem tocar a Sinqia (US-07, Cenário 3):
     * a proposta cujo tomador vinculado não chegou a `executada` cai aqui,
     * com a causa e a referência ao item do tomador no resultado. Atômico
     * ("primeira vence"): false = o item já não estava pendente.
     */
    falharItemPendente(
      itemId: string,
      ator: string,
      causa: string,
      mensagem: string,
      extra: Record<string, unknown> = {},
    ): boolean {
      const item = repo.obterItem(itemId);
      if (!item) return false;
      return repo.transicionarItem({
        id: itemId,
        de: "pendente",
        para: "falha",
        resultado: {
          desfecho: "falha",
          causa,
          mensagem,
          ...extra,
          publico: { desfecho: "falha", httpStatus: null, mensagens: mensagem },
        },
        agora: agora(),
        evento: {
          requisicaoId: item.requisicaoId,
          ator: normalizarLogin(ator),
          acao: ACAO_AUDITORIA.transicao,
          detalhe: {
            itemId,
            ordem: item.ordem,
            decisao: "falhar_item_dependente",
            de: "pendente",
            para: "falha",
            causa,
            ...extra,
          },
          resultado: "ok",
          ts: agora(),
        },
      });
    },

    /**
     * Retry manual de UM item de lote (US-10): falha → aprovada/executando.
     * Elegibilidade RN04: proposta só pode ser reprocessada se o tomador vinculado
     * (dependeDeItemId) estiver `executada`.
     */
    retryItemFalha(itemId: string, aprovador: string): ItemLoteSod {
      const ator = normalizarLogin(aprovador);
      const item = repo.obterItem(itemId);
      if (!item) throw new SodError("REQUISICAO_NAO_ENCONTRADA", `Item ${itemId} não encontrado.`);
      
      const req = repo.obterRequisicao(item.requisicaoId);
      if (!req) throw new Error("Lote pai não encontrado.");
      exigirSegundoOperador(req, aprovador, "retry_item");

      if (!transicaoItemPermitida(item.estado, "aprovada/executando")) {
        rejeitar("TRANSICAO_INVALIDA", `Transição inválida: ${item.estado} → aprovada/executando (item ${itemId}).`, {
          requisicaoId: req.id,
          ator,
          detalhe: { decisao: "retry_item", itemId, de: item.estado, para: "aprovada/executando" },
        });
      }

      if (item.dependeDeItemId) {
        const pai = repo.obterItem(item.dependeDeItemId);
        if (pai && pai.estado !== "executada") {
           rejeitar("LOTE_INVALIDO", `Item inelegível: o tomador vinculado (item ${pai.ordem}) está em "${pai.estado}" (precisa estar "executada").`, {
             requisicaoId: req.id,
             ator,
             detalhe: { decisao: "retry_item", itemId, dependeDeItemId: item.dependeDeItemId, estadoPai: pai.estado }
           });
        }
      }

      const ok = repo.transicionarItem({
        id: itemId,
        de: "falha",
        para: "aprovada/executando",
        agora: agora(),
        evento: {
          requisicaoId: req.id,
          ator,
          acao: ACAO_AUDITORIA.transicao,
          detalhe: {
            itemId,
            ordem: item.ordem,
            decisao: "retry",
            de: "falha",
            para: "aprovada/executando"
          },
          resultado: "ok",
          ts: agora(),
        }
      });
      
      if (!ok) {
        const atual = repo.obterItem(itemId);
        rejeitar("TRANSICAO_INVALIDA", `Decisão não aplicada: o item ${itemId} já saiu de "falha" (estado atual: "${atual?.estado ?? "desconhecido"}").`, {
          requisicaoId: req.id, ator, detalhe: { decisao: "retry_item", itemId, de: "falha", para: "aprovada/executando", estadoAtual: atual?.estado ?? null }
        });
      }
      
      if (req.estado === "falha") {
         repo.transicionar({
           id: req.id,
           de: "falha",
           para: "aprovada/executando",
           agora: agora(),
           evento: {
             requisicaoId: req.id,
             ator,
             acao: ACAO_AUDITORIA.transicao,
             detalhe: {
               decisao: "retry_lote_implicito",
               de: "falha",
               para: "aprovada/executando"
             },
             resultado: "ok",
             ts: agora(),
           }
         });
      }

      const depois = repo.obterItem(itemId);
      if (!depois) throw new Error(`Item ${itemId} sumiu após retry.`);
      return depois;
    },

    /** Descarte de UM item de lote (US-10): falha → descartada, motivo obrigatório. */
    descartarItemFalha(itemId: string, ator: string, motivo: string | undefined): ItemLoteSod {
      const normalizado = normalizarLogin(ator);
      const item = repo.obterItem(itemId);
      if (!item) throw new SodError("REQUISICAO_NAO_ENCONTRADA", `Item ${itemId} não encontrado.`);
      
      const req = repo.obterRequisicao(item.requisicaoId);
      if (!req) throw new Error("Lote pai não encontrado.");
      
      const limpo = exigirMotivo(req, ator, "descartar_item", motivo);
      
      if (!transicaoItemPermitida(item.estado, "descartada")) {
        rejeitar("TRANSICAO_INVALIDA", `Transição inválida: ${item.estado} → descartada (item ${itemId}).`, {
          requisicaoId: req.id,
          ator: normalizado,
          detalhe: { decisao: "descartar_item", itemId, de: item.estado, para: "descartada" },
        });
      }

      const ok = repo.transicionarItem({
        id: itemId,
        de: "falha",
        para: "descartada",
        motivo: limpo,
        agora: agora(),
        evento: {
          requisicaoId: req.id,
          ator: normalizado,
          acao: ACAO_AUDITORIA.transicao,
          detalhe: {
            itemId,
            ordem: item.ordem,
            decisao: "descartar",
            de: "falha",
            para: "descartada",
            motivo: limpo
          },
          resultado: "ok",
          ts: agora(),
        }
      });
      
      if (!ok) {
        const atual = repo.obterItem(itemId);
        rejeitar("TRANSICAO_INVALIDA", `Decisão não aplicada: o item ${itemId} já saiu de "falha" (estado atual: "${atual?.estado ?? "desconhecido"}").`, {
          requisicaoId: req.id, ator: normalizado, detalhe: { decisao: "descartar_item", itemId, de: "falha", para: "descartada", estadoAtual: atual?.estado ?? null }
        });
      }
      
      if (req.estado === "falha") {
         const placar = repo.placarDoLote(req.id);
         const novoDesfecho = derivarDesfechoLote(placar);
         if (novoDesfecho !== "falha") {
             repo.transicionar({
               id: req.id,
               de: "falha",
               para: novoDesfecho,
               agora: agora(),
               evento: {
                 requisicaoId: req.id,
                 ator: normalizado,
                 acao: ACAO_AUDITORIA.transicao,
                 detalhe: {
                   decisao: "concluir_lote_implicito",
                   de: "falha",
                   para: novoDesfecho,
                   placar
                 },
                 resultado: "ok",
                 ts: agora(),
               }
             });
         }
      }

      const depois = repo.obterItem(itemId);
      if (!depois) throw new Error(`Item ${itemId} sumiu após descarte.`);
      return depois;
    },

    /**
     * Conclusão do LOTE (RN01, estado derivado): agrega o placar dos itens e
     * transiciona `aprovada/executando → executada|falha` com o placar (e o
     * contexto de interrupção, se houve) anexado ao resultado.
     */
    concluirLote(
      id: string,
      ator: string,
      extra: Record<string, unknown> = {},
    ): RequisicaoSod {
      const normalizado = normalizarLogin(ator);
      const req = exigirRequisicao(id, normalizado, "concluir_lote");
      const placar = repo.placarDoLote(id);
      const desfecho = derivarDesfechoLote(placar);
      return transicionar({
        req,
        para: desfecho,
        ator: normalizado,
        decisao: "concluir_execucao",
        resultado: { desfecho, placar, ...extra },
      });
    },

    obterRequisicao: repo.obterRequisicao.bind(repo),
    obterItem: repo.obterItem.bind(repo),
    itensDoLote: repo.itensDoLote.bind(repo),
    placarDoLote: repo.placarDoLote.bind(repo),
    /** Placar de dois níveis (US-07): um placar por tipo de item do lote. */
    placarPorTipo: repo.placarPorTipo.bind(repo),
    /** Propostas vinculadas a um tomador (US-07; insumo do retry da US-10). */
    itensDependentes: repo.itensDependentes.bind(repo),
    itemPendentePorDocumento: repo.itemPendentePorDocumento.bind(repo),

    listarRequisicoes: repo.listarRequisicoes.bind(repo),
    listarRequisitantes: repo.requisitantes.bind(repo),
    listarAuditoria: repo.listarEventos.bind(repo),
    /**
     * Consulta pura da guarda: a requisição pendente de um (tipo, chave).
     * A US-04 usa com ("tomador.cadastrar", cpf) na pré-condição RN05 —
     * proposta para tomador ainda em aprovação é bloqueada na criação.
     */
    pendentePorDocumento: repo.pendentePorDocumento.bind(repo),

    /**
     * Bloqueio de movimentação CONSULTÁVEL (US-08, RN03): a movimentação
     * ativa de uma proposta e a lista completa do ambiente. Fonte ÚNICA
     * (US-09): requisições individuais E itens de lote, contra a mesma
     * definição de "ativa" (ESTADOS_BLOQUEIO_MOVIMENTACAO, shared) — a dos
     * índices que decidem as corridas de criação.
     */
    movimentacaoAtivaPorProposta(nrProsp: number | string): MovimentacaoAtivaSod | null {
      return repo.movimentacaoAtivaPorDocumento(String(nrProsp).replace(/\D/g, ""));
    },
    listarMovimentacoesAtivas: repo.listarMovimentacoesAtivas.bind(repo),
  };
}

export type SodServico = ReturnType<typeof criarSodServico>;
