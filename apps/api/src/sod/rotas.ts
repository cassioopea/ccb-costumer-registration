import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  criarRequisicaoSodSchema,
  decisaoSodSchema,
  estadoRequisicaoSchema,
  tipoAcaoSodSchema,
  normalizarLogin,
  type CadastrarClienteRequest,
  type TipoAcaoSod,
} from "@cadastro-lote/shared";
import { env } from "./../env.js";
import { destroySession, getSession, motivoTexto, type Session } from "./../session.js";
import {
  cadastrarCliente,
  verificarSessaoSinqia,
} from "./../sinqia-client.js";
import { abrirBancoSod, criarSodRepositorio } from "./repositorio.js";
import type { RequisicaoSod } from "./repositorio.js";
import { criarSodServico, SodError, type CodigoErroSod, type SodServico } from "./dominio.js";

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
};

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
 * Dependências da EXECUÇÃO (US-03) — injetáveis nos testes para simular
 * sucesso, erro de negócio, timeout e sessão expirada sem tocar na Sinqia.
 */
export interface RegisterSodRoutesDeps {
  cadastrarClienteFn?: typeof cadastrarCliente;
  verificarSessaoSinqiaFn?: typeof verificarSessaoSinqia;
}

/** Desfecho interno de uma execução — vira `resultado` da requisição (RN05). */
interface ResultadoExecucao {
  desfecho: "executada" | "falha";
  /** true = a Sinqia respondeu 401 no meio — a sessão do aprovador morreu. */
  sessaoExpirou: boolean;
  /** Resposta/erro INTEGRAL, anexado à requisição e à auditoria. */
  resultado: Record<string, unknown>;
  /** Resumo legível para a UI (identificação do tomador criado / erro). */
  publico: {
    desfecho: "executada" | "falha";
    httpStatus: number | null;
    mensagens: string;
    detalhe?: string;
  };
}

function falhaExecucao(
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
 * Executor do cadastro individual de tomador: o MESMO cliente
 * (`cadastrarCliente`) e o MESMO payload persistido na criação da requisição
 * (`payload.request` — RN05/RN08 da US-02), no token da SESSÃO DO APROVADOR.
 */
async function executarCadastroTomador(
  requisicao: RequisicaoSod,
  token: string,
  cadastrarClienteFn: typeof cadastrarCliente,
): Promise<ResultadoExecucao> {
  const request = requisicao.payload.request;
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    return falhaExecucao(
      { causa: "payload_sem_request", mensagem: "A requisição não contém o request Sinqia montado." },
      { httpStatus: null, mensagens: "Payload da requisição sem o request Sinqia montado." },
    );
  }

  try {
    const r = await cadastrarClienteFn(token, request as CadastrarClienteRequest);

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
 * Registro de executores por tipo de ação. A US-04 acrescenta o de proposta;
 * tipo aprovado sem executor vira `falha` registrada (nunca exceção solta).
 */
type Executor = (
  requisicao: RequisicaoSod,
  token: string,
  cadastrarClienteFn: typeof cadastrarCliente,
) => Promise<ResultadoExecucao>;

const EXECUTORES: Partial<Record<TipoAcaoSod, Executor>> = {
  "tomador.cadastrar": executarCadastroTomador,
};

export async function registerSodRoutes(
  app: FastifyInstance,
  /** Injetável nos testes (banco temporário); o runtime usa o padrão. */
  servico: SodServico = sodServicoPadrao(),
  deps: RegisterSodRoutesDeps = {},
) {
  const cadastrarClienteFn = deps.cadastrarClienteFn ?? cadastrarCliente;
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

  /** Detalhar: requisição + histórico de transições (auditoria vinculada). */
  app.get("/api/sod/requisicoes/:id", async (req, reply) => {
    const session = exigirSessao(req, reply);
    if (!session) return;

    const parsed = idParamsSchema.safeParse(req.params);
    if (!parsed.success) return reply.code(400).send({ error: "Id inválido." });
    try {
      return reply.send(servico.detalharRequisicao(parsed.data.id));
    } catch (e) {
      return responderErroSod(reply, e);
    }
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
    const body = decisaoSodSchema.safeParse(req.body);
    if (!body.success) {
      return reply
        .code(400)
        .send({ error: body.error.issues[0]?.message ?? "Decisão inválida." });
    }

    const { id } = params.data;
    const ator = session.username;
    try {
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
            ? await executor(aprovada, session.token, cadastrarClienteFn)
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
