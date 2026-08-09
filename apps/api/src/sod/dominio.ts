import { randomUUID } from "node:crypto";
import {
  normalizarLogin,
  transicaoPermitida,
  type EstadoRequisicao,
  type TipoAcaoSod,
} from "@cadastro-lote/shared";
import type { RequisicaoSod, SodRepositorio } from "./repositorio.js";

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
  | "CANCELAMENTO_NEGADO";

export class SodError extends Error {
  constructor(
    public readonly codigo: CodigoErroSod,
    mensagem: string,
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
    throw new SodError(codigo, mensagem);
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
      rejeitar(
        "TRANSICAO_INVALIDA",
        `Transição inválida: ${req.estado} → ${para} (requisição ${req.id}).`,
        {
          requisicaoId: req.id,
          ator,
          detalhe: { decisao, de: req.estado, para },
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
        },
        resultado: "ok",
        ts: agora(),
      },
    });

    if (!ok) {
      // Corrida perdida: outra decisão mudou o estado entre a leitura e o
      // UPDATE. A primeira venceu (RN: jamais segunda execução) — audita e erra.
      const atual = repo.obterRequisicao(req.id);
      rejeitar(
        "TRANSICAO_INVALIDA",
        `Decisão não aplicada: a requisição ${req.id} já saiu de "${req.estado}" ` +
          `(estado atual: "${atual?.estado ?? "desconhecido"}").`,
        {
          requisicaoId: req.id,
          ator,
          detalhe: { decisao, de: req.estado, para, estadoAtual: atual?.estado ?? null },
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

  return {
    /** Cria a requisição em `pendente` com payload integral e identidade normalizada. */
    criarRequisicao(entrada: {
      tipo: TipoAcaoSod;
      payload: Record<string, unknown>;
      requisitante: string;
    }): RequisicaoSod {
      const requisitante = normalizarLogin(entrada.requisitante);
      if (!requisitante) throw new Error("Requisitante vazio — sessão sem login utilizável.");
      const id = randomUUID();
      const ts = agora();
      repo.criarRequisicao(
        { id, tipo: entrada.tipo, payload: entrada.payload, requisitante, criadoEm: ts },
        {
          requisicaoId: id,
          ator: requisitante,
          acao: ACAO_AUDITORIA.criacao,
          detalhe: { tipo: entrada.tipo, payload: entrada.payload },
          resultado: "ok",
          ts,
        },
      );
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
     * TODO US-03: stub de conclusão da execução. Na US-03 a execução real na
     * sessão Sinqia do aprovador substitui isto; até lá, SÓ OS TESTES chamam
     * este método para exercitar aprovada/executando → executada|falha.
     */
    concluirExecucaoStub(
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
        decisao: "concluir_execucao(stub US-03)",
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
    listarAuditoria: repo.listarEventos.bind(repo),
  };
}

export type SodServico = ReturnType<typeof criarSodServico>;
