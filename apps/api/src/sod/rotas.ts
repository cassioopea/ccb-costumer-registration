import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  criarRequisicaoSodSchema,
  decisaoComExcecoesSchema,
  ehTipoLote,
  estadoRequisicaoSchema,
  tipoAcaoSodSchema,
  normalizarLogin,
} from "@cadastro-lote/shared";
import { env } from "./../env.js";
import { destroySession, getSession, motivoTexto, type Session } from "./../session.js";
import {
  cadastrarCliente,
  calcProsp,
  consultarHistoricoProposta,
  consultarStatusTransf,
  transferirStatus,
  verificarSessaoSinqia,
  alterarSituacaoCliente,
  listarPropostasPorCpf,
} from "./../sinqia-client.js";
import { criarUma } from "./../criacao-job.js";
import { abrirBancoSod, criarSodRepositorio, type ItemLoteSod } from "./repositorio.js";
import { criarSodServico, SodError, type CodigoErroSod, type SodServico } from "./dominio.js";
import { EXECUTORES, falhaExecucao, type ExecucaoDeps } from "./execucao.js";
import { iniciarExecucaoLote } from "./execucao-lote.js";

/**
 * Esteira de Aprovação (SoD) — endpoints internos do BFF.
 *
 * US-01: criação/listagem/detalhe/decisão. US-03: a aprovação passa a EXECUTAR
 * na Sinqia, na sessão do aprovador (decisão B2'), em três tempos:
 *  (i)   pré-verificação da sessão Sinqia do aprovador (RN03) — sessão
 *        inválida bloqueia ANTES de qualquer transição;
 *  (ii)  transição atômica `pendente → aprovada/executando` (RN06);
 *  (iii) chamada Sinqia com o MESMO cliente e token de sessão do fluxo direto;
 *        resposta/erro INTEGRAL anexado (RN05/RN07), sem retry automático.
 */

const COOKIE_SID = "sid";
const CODE_SESSAO_EXPIRADA = "SESSAO_EXPIRADA";

/** Mesmo contrato do exigirSessao de routes.ts (duplicado de propósito até a extração de um core/). */
function exigirSessao(req: FastifyRequest, reply: FastifyReply): Session | null {
  const sid = (req.cookies as Record<string, string | undefined>)?.[COOKIE_SID];
  const res = getSession(sid);
  if (!res.ok) {
    reply.clearCookie(COOKIE_SID, { path: "/" });
    reply.code(401).send({
      error: motivoTexto(res.motivo),
      code: CODE_SESSAO_EXPIRADA,
      motivo: res.motivo,
    });
    return null;
  }
  return res.session;
}

/** Cada código de erro do domínio tem um status HTTP fixo. */
const STATUS_POR_CODIGO: Record<CodigoErroSod, number> = {
  REQUISICAO_NAO_ENCONTRADA: 404,
  TRANSICAO_INVALIDA: 409,
  VIOLACAO_SOD: 403,
  CANCELAMENTO_NEGADO: 403,
  MOTIVO_OBRIGATORIO: 400,
  DUPLICIDADE_PENDENTE: 409,
  MOVIMENTACAO_BLOQUEADA: 409,
  LOTE_INVALIDO: 400,
};

/**
 * Visão ENXUTA de um item de lote para listagem/polling: sem o payload
 * integral e sem o envelope Sinqia completo — o detalhe de UM item
 * (GET .../itens/:itemId) traz tudo. 70 itens × envelope integral a cada
 * poll de 1,5s seria desperdício puro.
 */
function itemParaLista(item: ItemLoteSod) {
  const resumo = (item.payload as { resumo?: Record<string, unknown> }).resumo ?? {};
  const resultado = item.resultado as
    | { publico?: Record<string, unknown>; causa?: unknown; duracaoMs?: unknown }
    | null;
  return {
    id: item.id,
    ordem: item.ordem,
    tipo: item.tipo,
    estado: item.estado,
    documento: item.documento,
    // Vínculo tomador→proposta do lote composto (US-07) — a UI agrupa por ele.
    dependeDeItemId: item.dependeDeItemId,
    motivo: item.motivo,
    resumo,
    resultado: resultado
      ? {
          ...(resultado.publico ?? {}),
          ...(resultado.causa !== undefined ? { causa: resultado.causa } : {}),
          ...(resultado.duracaoMs !== undefined ? { duracaoMs: resultado.duracaoMs } : {}),
        }
      : null,
    atualizadoEm: item.atualizadoEm,
  };
}

export function responderErroSod(reply: FastifyReply, e: unknown): FastifyReply {
  if (e instanceof SodError) {
    return reply
      .code(STATUS_POR_CODIGO[e.codigo])
      .send({ error: e.message, code: e.codigo, ...(e.extra ?? {}) });
  }
  throw e;
}

const paginacaoSchema = {
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
};

const listarRequisicoesQuerySchema = z.object({
  estado: estadoRequisicaoSchema.optional(),
  tipo: tipoAcaoSodSchema.optional(),
  requisitante: z.string().optional(),
  /** "asc" = mais antiga primeiro (painel de pendências, RN01). Default desc. */
  ordem: z.enum(["asc", "desc"]).optional(),
  /**
   * "Minhas requisições" (US-02): força requisitante = identidade da SESSÃO,
   * ignorando o parâmetro `requisitante` — o cliente não escolhe quem é.
   * (Sem z.coerce.boolean: ele trataria "0"/"false" como true.)
   */
  minhas: z
    .string()
    .optional()
    .transform((v) => v === "1" || v === "true"),
  ...paginacaoSchema,
});

const auditoriaQuerySchema = z.object({
  ator: z.string().optional(),
  requisicaoId: z.string().optional(),
  de: z.string().datetime({ offset: true }).optional(),
  ate: z.string().datetime({ offset: true }).optional(),
  ...paginacaoSchema,
});

const idParamsSchema = z.object({ id: z.string().uuid() });

/**
 * Serviço padrão do runtime: mesmo arquivo SQLite e ambiente da base local.
 * SINGLETON preguiçoso — o /api/cadastrar (routes.ts) e as rotas SoD
 * compartilham a MESMA conexão em vez de abrir o arquivo duas vezes.
 */
let servicoRuntime: SodServico | null = null;
export function sodServicoPadrao(): SodServico {
  if (!servicoRuntime) {
    const db = abrirBancoSod(env.SQLITE_PATH);
    servicoRuntime = criarSodServico(criarSodRepositorio(db, env.SINQIA_ENV));
  }
  return servicoRuntime;
}

/**
 * Dependências da EXECUÇÃO (US-03/US-04) — injetáveis nos testes para simular
 * sucesso, erro de negócio, timeout e sessão expirada sem tocar na Sinqia.
 * Os executores em si vivem em execucao.ts (registro EXECUTORES por tipo).
 */
export interface RegisterSodRoutesDeps {
  cadastrarClienteFn?: typeof cadastrarCliente;
  verificarSessaoSinqiaFn?: typeof verificarSessaoSinqia;
  calcProspFn?: typeof calcProsp;
  criarUmaFn?: typeof criarUma;
  /** Movimentação de proposta (US-08) — o MESMO cliente do fluxo direto. */
  transferirStatusFn?: typeof transferirStatus;
  consultarStatusTransfFn?: typeof consultarStatusTransf;
  consultarHistoricoPropostaFn?: typeof consultarHistoricoProposta;
  alterarSituacaoClienteFn?: typeof alterarSituacaoCliente;
  listarPropostasPorCpfFn?: typeof listarPropostasPorCpf;
}

export async function registerSodRoutes(
  app: FastifyInstance,
  /** Injetável nos testes (banco temporário); o runtime usa o padrão. */
  servico: SodServico = sodServicoPadrao(),
  deps: RegisterSodRoutesDeps = {},
) {
  const execucaoDeps: ExecucaoDeps = {
    cadastrarClienteFn: deps.cadastrarClienteFn ?? cadastrarCliente,
    calcProspFn: deps.calcProspFn ?? calcProsp,
    criarUmaFn: deps.criarUmaFn ?? criarUma,
    transferirStatusFn: deps.transferirStatusFn ?? transferirStatus,
    consultarStatusTransfFn: deps.consultarStatusTransfFn ?? consultarStatusTransf,
    consultarHistoricoPropostaFn: deps.consultarHistoricoPropostaFn ?? consultarHistoricoProposta,
    alterarSituacaoClienteFn: deps.alterarSituacaoClienteFn ?? alterarSituacaoCliente,
    listarPropostasPorCpfFn: deps.listarPropostasPorCpfFn ?? listarPropostasPorCpf,
  };
  const verificarSessaoSinqiaFn = deps.verificarSessaoSinqiaFn ?? verificarSessaoSinqia;
  /** Criar requisição — o requisitante é SEMPRE a sessão, nunca o body. */
  app.post("/api/sod/requisicoes", async (req, reply) => {
    const session = exigirSessao(req, reply);
    if (!session) return;

    const parsed = criarRequisicaoSodSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: parsed.error.issues[0]?.message ?? "Requisição inválida." });
    }
    try {
      const requisicao = servico.criarRequisicao({
        tipo: parsed.data.tipo,
        payload: parsed.data.payload,
        requisitante: session.username,
      });
      return reply.code(201).send({ requisicao });
    } catch (e) {
      // Duplicidade pendente (RN02) → 409 com a requisição existente.
      return responderErroSod(reply, e);
    }
  });

  /** Listar com filtros (estado, tipo, requisitante) e paginação. */
  app.get("/api/sod/requisicoes", async (req, reply) => {
    const session = exigirSessao(req, reply);
    if (!session) return;

    const parsed = listarRequisicoesQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: parsed.error.issues[0]?.message ?? "Filtros inválidos." });
    }
    const { requisitante, minhas, ...resto } = parsed.data;
    // `minhas` prevalece: a identidade vem da sessão, nunca do query param.
    const filtroRequisitante = minhas
      ? normalizarLogin(session.username)
      : requisitante
        ? normalizarLogin(requisitante)
        : undefined;
    return reply.send(
      servico.listarRequisicoes({
        ...resto,
        // Filtro por requisitante compara na forma normalizada (RN05).
        ...(filtroRequisitante ? { requisitante: filtroRequisitante } : {}),
      }),
    );
  });

  /**
   * Retorna a contagem agregada de pendências para o badge de navegação (US-11).
   * Considera apenas as requisições decidíveis pelo operador logado (lotes contam como 1).
   * `count` é o total (contrato original do badge); `pendentes`/`falhas` são a
   * quebra que a fila usa para não esconder falhas no filtro padrão.
   */
  app.get("/api/sod/pendencias-badge", async (req, reply) => {
    const session = exigirSessao(req, reply);
    if (!session) return;

    const c = servico.contarPendenciasBadge(session.username);
    return reply.send({ count: c.total, pendentes: c.pendentes, falhas: c.falhas });
  });

  /**
   * Detalhar: requisição + histórico (auditoria vinculada). Lotes (US-06)
   * trazem também o placar e os itens em visão enxuta — é este endpoint que a
   * UI consulta em polling durante a execução (progresso quase em tempo real).
   */
  app.get("/api/sod/requisicoes/:id", async (req, reply) => {
    const session = exigirSessao(req, reply);
    if (!session) return;

    const parsed = idParamsSchema.safeParse(req.params);
    if (!parsed.success) return reply.code(400).send({ error: "Id inválido." });
    try {
      const detalhe = servico.detalharRequisicao(parsed.data.id);
      return reply.send({
        requisicao: detalhe.requisicao,
        historico: detalhe.historico,
        ...(detalhe.itens ? { itens: detalhe.itens.map(itemParaLista) } : {}),
        ...(detalhe.placar ? { placar: detalhe.placar } : {}),
        // Dois níveis (US-07): placar por tipo de item (tomadores × propostas).
        ...(detalhe.placarPorTipo ? { placarPorTipo: detalhe.placarPorTipo } : {}),
      });
    } catch (e) {
      return responderErroSod(reply, e);
    }
  });

  /** Detalhe INTEGRAL de um item de lote: payload + resposta Sinqia completa. */
  app.get("/api/sod/requisicoes/:id/itens/:itemId", async (req, reply) => {
    const session = exigirSessao(req, reply);
    if (!session) return;

    const parsed = z
      .object({ id: z.string().uuid(), itemId: z.string().uuid() })
      .safeParse(req.params);
    if (!parsed.success) return reply.code(400).send({ error: "Id inválido." });
    const item = servico.obterItem(parsed.data.itemId);
    if (!item || item.requisicaoId !== parsed.data.id) {
      return reply.code(404).send({ error: "Item não encontrado neste lote." });
    }
    return reply.send({ item });
  });

  /**
   * Aplicar decisão. Reprovar e cancelar são transições puras (nunca chamam a
   * Sinqia). Aprovar (US-03) executa o fluxo B2' em três tempos — ver o
   * comentário do topo do arquivo.
   */
  app.post("/api/sod/requisicoes/:id/decisao", async (req, reply) => {
    const session = exigirSessao(req, reply);
    if (!session) return;

    const params = idParamsSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "Id inválido." });
    const body = decisaoComExcecoesSchema.safeParse(req.body);
    if (!body.success) {
      return reply
        .code(400)
        .send({ error: body.error.issues[0]?.message ?? "Decisão inválida." });
    }

    const { id } = params.data;
    const ator = session.username;
    const excecoes = body.data.excecoes ?? [];

    // Exceções são um conceito de LOTE (US-06). O alvo pode não existir —
    // nesse caso o domínio responde 404 auditado pelo fluxo normal abaixo.
    const alvo = servico.obterRequisicao(id);
    const ehLote = !!alvo && ehTipoLote(alvo.tipo);
    if (!ehLote && excecoes.length > 0) {
      return reply
        .code(400)
        .send({ error: "Exceções por item só se aplicam a requisições de lote." });
    }

    try {
      /*
       * Decisão de LOTE (US-06): direção-base + exceções, aplicada
       * atomicamente; itens aprovados executam SEQUENCIALMENTE na sessão do
       * aprovador, em background — a resposta volta já, e o progresso é
       * consultado por polling do detalhe.
       */
      if (ehLote && (body.data.decisao === "aprovar" || body.data.decisao === "reprovar")) {
        // (i) Pré-verificação da sessão Sinqia (RN03) — apenas quando a
        // decisão vai EXECUTAR algo (aprovação, ou reprovação com exceções
        // aprovadas). Reprovar-todos nunca sonda nem chama a Sinqia.
        const vaiExecutar =
          body.data.decisao === "aprovar" || excecoes.length > 0;
        if (vaiExecutar) {
          const sessaoSinqia = await verificarSessaoSinqiaFn(session.token);
          if (sessaoSinqia === "invalida") {
            destroySession(session.id);
            reply.clearCookie(COOKIE_SID, { path: "/" });
            return reply.code(401).send({
              error:
                "Sua sessão na Sinqia não é mais válida. Entre novamente e repita a decisão — o lote continua pendente.",
              code: CODE_SESSAO_EXPIRADA,
              motivo: "token",
            });
          }
          if (sessaoSinqia === "indisponivel") {
            return reply.code(502).send({
              error:
                "A Sinqia está indisponível — não foi possível confirmar sua sessão. Nada foi alterado; o lote continua pendente.",
            });
          }
        }

        // (ii) Decisão atômica (primeira vence) + transição dos reprovados.
        const decisao = servico.decidirLote(id, ator, {
          decisao: body.data.decisao,
          motivo: body.data.motivo,
          excecoes,
        });

        // (iii) Execução sequencial em background, na sessão do aprovador.
        if (decisao.aprovados.length > 0) {
          servico.registrarInicioExecucao(id, ator);
          void iniciarExecucaoLote(
            decisao.requisicao,
            { token: session.token, ator: normalizarLogin(ator), sessionId: session.id },
            { servico, deps: execucaoDeps },
          );
        }
        return reply.send({
          requisicao: decisao.requisicao,
          placar: decisao.placar,
          execucao:
            decisao.aprovados.length > 0
              ? { emAndamento: true, aprovados: decisao.aprovados.length }
              : undefined,
        });
      }

      switch (body.data.decisao) {
        case "aprovar": {
          // (i) Pré-verificação da sessão Sinqia do APROVADOR (RN03): sessão
          // inválida bloqueia ANTES de qualquer transição — a requisição
          // permanece `pendente` e a UI orienta a reautenticação.
          const sessaoSinqia = await verificarSessaoSinqiaFn(session.token);
          if (sessaoSinqia === "invalida") {
            destroySession(session.id);
            reply.clearCookie(COOKIE_SID, { path: "/" });
            return reply.code(401).send({
              error:
                "Sua sessão na Sinqia não é mais válida. Entre novamente e repita a aprovação — a requisição continua pendente.",
              code: CODE_SESSAO_EXPIRADA,
              motivo: "token",
            });
          }
          if (sessaoSinqia === "indisponivel") {
            return reply.code(502).send({
              error:
                "A Sinqia está indisponível — não foi possível confirmar sua sessão. Nada foi alterado; a requisição continua pendente.",
            });
          }

          // (ii) Transição atômica pendente → aprovada/executando (RN06):
          // maker-checker e "primeira decisão vence" no domínio/persistência.
          const aprovada = servico.aprovar(id, ator);

          // (iii) Execução na SESSÃO DO APROVADOR (B2'), com o payload
          // persistido na requisição (RN05) — jamais reconstruído.
          servico.registrarInicioExecucao(id, ator);
          const executor = EXECUTORES[aprovada.tipo];
          const execucao = executor
            ? await executor(aprovada, { token: session.token, ator }, execucaoDeps)
            : falhaExecucao(
                { causa: "tipo_sem_executor", tipo: aprovada.tipo },
                { httpStatus: null, mensagens: `Tipo ${aprovada.tipo} ainda não tem executor.` },
              );
          const requisicao = servico.concluirExecucao(
            id,
            ator,
            execucao.desfecho,
            execucao.resultado,
          );

          // Sessão morreu DURANTE a execução: falha registrada com causa
          // (já persistida acima) + orientação de reautenticação na resposta.
          if (execucao.sessaoExpirou) {
            destroySession(session.id);
            reply.clearCookie(COOKIE_SID, { path: "/" });
            return reply.code(401).send({
              error:
                "O token da Sinqia expirou durante a execução. A requisição foi marcada como falha; entre novamente.",
              code: CODE_SESSAO_EXPIRADA,
              motivo: "token",
              requisicao,
              execucao: execucao.publico,
            });
          }
          return reply.send({ requisicao, execucao: execucao.publico });
        }
        case "reprovar":
          return reply.send({ requisicao: servico.reprovar(id, ator, body.data.motivo) });
        case "cancelar":
          return reply.send({ requisicao: servico.cancelar(id, ator) });
      }
    } catch (e) {
      return responderErroSod(reply, e);
    }
  });

  app.post("/api/sod/requisicoes/:id/retry", async (req, reply) => {
    const session = exigirSessao(req, reply);
    if (!session) return;
    const params = idParamsSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "Id inválido." });
    const { id } = params.data;
    const ator = session.username;

    try {
      const sessaoSinqia = await verificarSessaoSinqiaFn(session.token);
      if (sessaoSinqia === "invalida") {
        destroySession(session.id);
        reply.clearCookie(COOKIE_SID, { path: "/" });
        return reply.code(401).send({ error: "Sua sessão na Sinqia não é mais válida. Entre novamente e repita a decisão.", code: CODE_SESSAO_EXPIRADA, motivo: "token" });
      }
      if (sessaoSinqia === "indisponivel") return reply.code(502).send({ error: "A Sinqia está indisponível — não foi possível confirmar sua sessão." });

      const aprovada = servico.retryFalha(id, ator);
      servico.registrarInicioExecucao(id, ator);
      const executor = EXECUTORES[aprovada.tipo];
      const execucao = executor
        ? await executor(aprovada, { token: session.token, ator }, execucaoDeps)
        : falhaExecucao({ causa: "tipo_sem_executor", tipo: aprovada.tipo }, { httpStatus: null, mensagens: `Tipo ${aprovada.tipo} sem executor.` });
      
      const requisicao = servico.concluirExecucao(id, ator, execucao.desfecho, execucao.resultado);

      if (execucao.sessaoExpirou) {
        destroySession(session.id);
        reply.clearCookie(COOKIE_SID, { path: "/" });
        return reply.code(401).send({
          error: "O token expirou durante a execução.",
          code: CODE_SESSAO_EXPIRADA,
          motivo: "token",
          requisicao,
          execucao: execucao.publico,
        });
      }
      return reply.send({ requisicao, execucao: execucao.publico });
    } catch (e) {
      return responderErroSod(reply, e);
    }
  });

  app.post("/api/sod/requisicoes/:id/descarte", async (req, reply) => {
    const session = exigirSessao(req, reply);
    if (!session) return;
    const params = idParamsSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "Id inválido." });
    const body = z.object({ motivo: z.string().trim().min(1, "Motivo obrigatório") }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues[0]?.message ?? "Decisão inválida." });

    try {
      return reply.send({ requisicao: servico.descartarFalha(params.data.id, session.username, body.data.motivo) });
    } catch (e) {
      return responderErroSod(reply, e);
    }
  });

  app.post("/api/sod/requisicoes/:id/retry-lote", async (req, reply) => {
    const session = exigirSessao(req, reply);
    if (!session) return;
    const params = idParamsSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "Id inválido." });
    const { id } = params.data;
    const ator = session.username;

    try {
      const lote = servico.obterRequisicao(id);
      if (!lote || !ehTipoLote(lote.tipo)) {
         return reply.code(400).send({ error: "Requisição não encontrada ou não é lote." });
      }

      const sessaoSinqia = await verificarSessaoSinqiaFn(session.token);
      if (sessaoSinqia === "invalida") {
        destroySession(session.id);
        reply.clearCookie(COOKIE_SID, { path: "/" });
        return reply.code(401).send({ error: "Sua sessão na Sinqia não é mais válida.", code: CODE_SESSAO_EXPIRADA, motivo: "token" });
      }
      if (sessaoSinqia === "indisponivel") return reply.code(502).send({ error: "A Sinqia está indisponível." });

      const itens = servico.itensDoLote(id);
      let disparou = 0;
      for (const item of itens) {
         if (item.estado !== "falha") continue;
         if (item.dependeDeItemId) {
            const pai = servico.obterItem(item.dependeDeItemId);
            if (pai && pai.estado !== "executada") continue;
         }
         servico.retryItemFalha(item.id, ator);
         disparou++;
      }

      if (disparou > 0) {
        servico.registrarInicioExecucao(id, ator);
        void iniciarExecucaoLote(lote, { token: session.token, ator: normalizarLogin(ator), sessionId: session.id }, { servico, deps: execucaoDeps });
      } else {
        throw new SodError("TRANSICAO_INVALIDA", "Nenhum item elegível para reprocessamento.");
      }
      
      const detalhe = servico.detalharRequisicao(id);
      return reply.send({
        requisicao: detalhe.requisicao,
        placar: detalhe.placar,
        execucao: disparou > 0 ? { emAndamento: true, aprovados: disparou } : undefined
      });
    } catch (e) {
      return responderErroSod(reply, e);
    }
  });

  app.post("/api/sod/requisicoes/:id/itens/:itemId/retry", async (req, reply) => {
    const session = exigirSessao(req, reply);
    if (!session) return;
    const parsed = z.object({ id: z.string().uuid(), itemId: z.string().uuid() }).safeParse(req.params);
    if (!parsed.success) return reply.code(400).send({ error: "Id inválido." });
    const { id, itemId } = parsed.data;
    const ator = session.username;

    try {
      const sessaoSinqia = await verificarSessaoSinqiaFn(session.token);
      if (sessaoSinqia === "invalida") {
        destroySession(session.id);
        reply.clearCookie(COOKIE_SID, { path: "/" });
        return reply.code(401).send({ error: "Sua sessão na Sinqia não é mais válida.", code: CODE_SESSAO_EXPIRADA, motivo: "token" });
      }
      if (sessaoSinqia === "indisponivel") return reply.code(502).send({ error: "A Sinqia está indisponível." });

      servico.retryItemFalha(itemId, ator);
      
      const lote = servico.obterRequisicao(id);
      if (lote) {
         servico.registrarInicioExecucao(id, ator);
         void iniciarExecucaoLote(lote, { token: session.token, ator: normalizarLogin(ator), sessionId: session.id }, { servico, deps: execucaoDeps });
      }

      const detalhe = servico.detalharRequisicao(id);
      return reply.send({
        requisicao: detalhe.requisicao,
        placar: detalhe.placar,
        execucao: { emAndamento: true, aprovados: 1 }
      });
    } catch (e) {
      return responderErroSod(reply, e);
    }
  });

  app.post("/api/sod/requisicoes/:id/itens/:itemId/descarte", async (req, reply) => {
    const session = exigirSessao(req, reply);
    if (!session) return;
    const parsed = z.object({ id: z.string().uuid(), itemId: z.string().uuid() }).safeParse(req.params);
    if (!parsed.success) return reply.code(400).send({ error: "Id inválido." });
    const body = z.object({ motivo: z.string().trim().min(1, "Motivo obrigatório") }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues[0]?.message ?? "Decisão inválida." });

    try {
      servico.descartarItemFalha(parsed.data.itemId, session.username, body.data.motivo);
      const detalhe = servico.detalharRequisicao(parsed.data.id);
      return reply.send({ requisicao: detalhe.requisicao, placar: detalhe.placar });
    } catch (e) {
      return responderErroSod(reply, e);
    }
  });


  /**
   * Movimentações ATIVAS do ambiente (US-08, RN05) — UMA consulta agregada
   * para o indicador do Painel de Propostas (nunca uma chamada por proposta).
   * Fonte ÚNICA do bloqueio por proposta (US-09): a lista cobre requisições
   * INDIVIDUAIS e itens de LOTE de movimentação — `lote`/`itemId` distinguem.
   * Ativa = pendente, executando ou falha (ESTADOS_BLOQUEIO_MOVIMENTACAO).
   */
  app.get("/api/sod/movimentacoes-ativas", async (req, reply) => {
    const session = exigirSessao(req, reply);
    if (!session) return;

    const movimentacoes = servico.listarMovimentacoesAtivas().map((r) => {
      const mov = (r.payload as { movimentacao?: Record<string, unknown> }).movimentacao ?? {};
      const resultado = r.resultado as { causa?: unknown } | null;
      return {
        requisicaoId: r.id,
        estado: r.estado,
        nrProsp: Number(r.documento) || null,
        requisitante: r.requisitante,
        criadoEm: r.criadoEm,
        origem: mov.origem ?? null,
        destino: mov.destino ?? null,
        lote: r.itemId !== null,
        ...(r.itemId ? { itemId: r.itemId } : {}),
        ...(r.estado === "falha" && typeof resultado?.causa === "string"
          ? { causaFalha: resultado.causa }
          : {}),
      };
    });
    return reply.send({ movimentacoes });
  });

  /**
   * Criadores distintos das requisições (default: pendentes) — alimenta o
   * filtro "criador" do painel de pendências sem varrer páginas na UI.
   */
  app.get("/api/sod/requisitantes", async (req, reply) => {
    const session = exigirSessao(req, reply);
    if (!session) return;

    const parsed = z
      .object({ estado: estadoRequisicaoSchema.optional() })
      .safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: "Filtros inválidos." });
    return reply.send({
      requisitantes: servico.listarRequisitantes({
        estado: parsed.data.estado ?? "pendente",
      }),
    });
  });

  /** Trilha de auditoria com filtros (ator, requisição, período). */
  app.get("/api/sod/auditoria", async (req, reply) => {
    const session = exigirSessao(req, reply);
    if (!session) return;

    const parsed = auditoriaQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: parsed.error.issues[0]?.message ?? "Filtros inválidos." });
    }
    const { ator, ...resto } = parsed.data;
    return reply.send(
      servico.listarAuditoria({
        ...resto,
        ...(ator ? { ator: normalizarLogin(ator) } : {}),
      }),
    );
  });
}
