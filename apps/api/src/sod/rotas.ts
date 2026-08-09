import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  criarRequisicaoSodSchema,
  decisaoSodSchema,
  estadoRequisicaoSchema,
  tipoAcaoSodSchema,
  normalizarLogin,
} from "@cadastro-lote/shared";
import { env } from "./../env.js";
import { getSession, motivoTexto, type Session } from "./../session.js";
import { abrirBancoSod, criarSodRepositorio } from "./repositorio.js";
import { criarSodServico, SodError, type CodigoErroSod, type SodServico } from "./dominio.js";

/**
 * Esteira de Aprovação (SoD) — endpoints internos do BFF (US-01).
 *
 * Uso interno pelas próximas histórias (US-02 em diante); a execução na
 * Sinqia NÃO acontece aqui (chega na US-03). Nenhum fluxo existente usa
 * esta camada ainda — o corte é a US-05 (feature flag).
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
};

function responderErroSod(reply: FastifyReply, e: unknown): FastifyReply {
  if (e instanceof SodError) {
    return reply.code(STATUS_POR_CODIGO[e.codigo]).send({ error: e.message, code: e.codigo });
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

/** Serviço padrão do runtime: mesmo arquivo SQLite e ambiente da base local. */
function servicoPadrao(): SodServico {
  const db = abrirBancoSod(env.SQLITE_PATH);
  return criarSodServico(criarSodRepositorio(db, env.SINQIA_ENV));
}

export async function registerSodRoutes(
  app: FastifyInstance,
  /** Injetável nos testes (banco temporário); o runtime usa o padrão. */
  servico: SodServico = servicoPadrao(),
) {
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
    const requisicao = servico.criarRequisicao({
      tipo: parsed.data.tipo,
      payload: parsed.data.payload,
      requisitante: session.username,
    });
    return reply.code(201).send({ requisicao });
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
    const { requisitante, ...resto } = parsed.data;
    return reply.send(
      servico.listarRequisicoes({
        ...resto,
        // Filtro por requisitante compara na forma normalizada (RN05).
        ...(requisitante ? { requisitante: normalizarLogin(requisitante) } : {}),
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
   * Aplicar decisão. Aprovar leva a `aprovada/executando` e PARA aí nesta
   * fase — a execução na Sinqia chega na US-03.
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
        case "aprovar":
          return reply.send({ requisicao: servico.aprovar(id, ator) });
        case "reprovar":
          return reply.send({ requisicao: servico.reprovar(id, ator, body.data.motivo) });
        case "cancelar":
          return reply.send({ requisicao: servico.cancelar(id, ator) });
      }
    } catch (e) {
      return responderErroSod(reply, e);
    }
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
