import { randomUUID } from "node:crypto";
import {
  extrairDocumentoSod,
  normalizarLogin,
  ROTULO_TIPO_ACAO,
  transicaoPermitida,
  type EstadoRequisicao,
  type TipoAcaoSod,
} from "@cadastro-lote/shared";
import {
  ehViolacaoDuplicidadePendente,
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
  | "DUPLICIDADE_PENDENTE";

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

  return {
    /**
     * Cria a requisição em `pendente` com payload integral e identidade
     * normalizada. Tipos com documento passam pela guarda de duplicidade
     * (RN02): já havendo pendente do mesmo documento, nada é criado.
     */
    criarRequisicao(entrada: {
      tipo: TipoAcaoSod;
      payload: Record<string, unknown>;
      requisitante: string;
    }): RequisicaoSod {
      const requisitante = normalizarLogin(entrada.requisitante);
      if (!requisitante) throw new Error("Requisitante vazio — sessão sem login utilizável.");

      const documento = extrairDocumentoSod(entrada.tipo, entrada.payload);
      if (documento) {
        const existente = repo.pendentePorDocumento(entrada.tipo, documento);
        if (existente) {
          rejeitarDuplicidade({ existente, tipo: entrada.tipo, documento, ator: requisitante });
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

    /** Detalhe: requisição + histórico completo de auditoria dela. */
    detalharRequisicao(id: string) {
      const req = repo.obterRequisicao(id);
      if (!req) throw new SodError("REQUISICAO_NAO_ENCONTRADA", `Requisição ${id} não encontrada.`);
      return { requisicao: req, historico: repo.eventosDaRequisicao(id) };
    },

    listarRequisicoes: repo.listarRequisicoes.bind(repo),
    listarRequisitantes: repo.requisitantes.bind(repo),
    listarAuditoria: repo.listarEventos.bind(repo),
    /**
     * Consulta pura da guarda: a requisição pendente de um (tipo, chave).
     * A US-04 usa com ("tomador.cadastrar", cpf) na pré-condição RN05 —
     * proposta para tomador ainda em aprovação é bloqueada na criação.
     */
    pendentePorDocumento: repo.pendentePorDocumento.bind(repo),
  };
}

export type SodServico = ReturnType<typeof criarSodServico>;
