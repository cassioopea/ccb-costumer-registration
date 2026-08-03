import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  batchControlSchema,
  cdSituacaoSchema,
  type BatchControl,
  type Cliente,
} from "@cadastro-lote/shared";
import { env, isProd } from "./env.js";
import { buildTemplateCsv } from "./template.js";
import { parseByFilename, validateRows, buildRequest } from "./parse-input.js";
import { listarTodosClientes, login, SinqiaAuthError } from "./sinqia-client.js";
import { getEmitter, getJob, startJob } from "./batch.js";
import {
  getSituacaoEmitter,
  getSituacaoJob,
  startSituacaoJob,
} from "./situacao-job.js";
import {
  createSession,
  describeToken,
  destroySession,
  getSession,
  motivoTexto,
  sessionPublica,
  type Session,
} from "./session.js";

/** Nome do cookie de sessão. httpOnly — o JS da página nunca lê. */
const COOKIE_SID = "sid";

/**
 * Código que o front usa para abrir o modal de reautenticação em vez de
 * derrubar a tela (preserva arquivo selecionado, base carregada e seleção).
 */
const CODE_SESSAO_EXPIRADA = "SESSAO_EXPIRADA";

interface UploadPayload {
  filename: string;
  content: string;
  control: BatchControl;
}

/**
 * Lê o multipart: 1 arquivo + campo control(JSON).
 * Credenciais não vêm mais aqui — a autenticação é a sessão (cookie).
 */
async function readUpload(req: any): Promise<UploadPayload> {
  let filename = "";
  let content = "";
  let controlRaw = "{}";

  const parts = req.parts();
  for await (const part of parts) {
    if (part.type === "file") {
      filename = part.filename ?? "";
      const buf = await part.toBuffer();
      content = buf.toString("utf8");
    } else {
      const value = part.value as string;
      if (part.fieldname === "control") controlRaw = value || "{}";
    }
  }

  if (!filename || !content) throw new Error("Arquivo não enviado.");

  const control = batchControlSchema.parse(JSON.parse(controlRaw));
  return { filename, content, control };
}

/**
 * Resolve a sessão do cookie. Em falha, responde 401 e devolve null — quem
 * chamou deve retornar imediatamente.
 */
function exigirSessao(req: FastifyRequest, reply: FastifyReply): Session | null {
  const sid = (req.cookies as Record<string, string | undefined>)?.[COOKIE_SID];
  const res = getSession(sid);
  if (!res.ok) {
    // Cookie inútil: limpa para não ficar mandando um id morto.
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

export async function registerRoutes(app: FastifyInstance) {
  /* ---------------------------------------------------------------- */
  /* Público (a tela de login precisa antes de qualquer sessão)        */
  /* ---------------------------------------------------------------- */

  app.get("/api/health", async () => ({
    ok: true,
    env: env.SINQIA_ENV,
    baseUrl: env.SINQIA_BASE_URL,
  }));

  // Aviso de produção — a tela de login mostra o ambiente ANTES de digitar senha.
  app.get("/api/env", async () => ({
    env: env.SINQIA_ENV,
    isProd: isProd(),
    baseUrl: env.SINQIA_BASE_URL,
  }));

  app.get("/api/template.csv", async (_req, reply) => {
    const csv = buildTemplateCsv();
    reply
      .header("Content-Type", "text/csv; charset=utf-8")
      .header("Content-Disposition", 'attachment; filename="template.csv"')
      .send("﻿" + csv); // BOM para Excel abrir acentos corretamente
  });

  /* ---------------------------------------------------------------- */
  /* Sessão                                                            */
  /* ---------------------------------------------------------------- */

  /**
   * Login único. A senha é usada aqui e descartada — só o token fica na sessão.
   * Serve tanto para o primeiro login quanto para a reautenticação.
   */
  app.post("/api/login", async (req, reply) => {
    const parsed = loginBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: parsed.error.issues[0]?.message ?? "Requisição inválida." });
    }
    const { username, password } = parsed.data;

    let token: string;
    try {
      token = await login(username, password);
    } catch (e) {
      const status = e instanceof SinqiaAuthError ? e.httpStatus : 502;
      return reply
        .code(status === 401 || status === 403 ? 401 : 502)
        .send({ error: (e as Error).message, stage: "login" });
    }

    // Sessão anterior (se houver) é substituída.
    const sidAntigo = (req.cookies as Record<string, string | undefined>)?.[COOKIE_SID];
    destroySession(sidAntigo);

    const session = createSession(username, token);
    const info = describeToken(token);

    // Diagnóstico do formato/TTL do token — responde "quanto tempo o token
    // fica ativo". NUNCA loga o token em si.
    app.log.info(
      `Login OK (${username}) — token ${info.formato}` +
        (info.ttlSegundos !== null
          ? `, TTL ${info.ttlSegundos}s (~${Math.round(info.ttlSegundos / 60)} min)`
          : ", validade não informada pelo token"),
    );

    reply.setCookie(COOKIE_SID, session.id, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      secure: false, // ferramenta local em http://127.0.0.1
    });

    return reply.send({ env: env.SINQIA_ENV, ...sessionPublica(session) });
  });

  app.post("/api/logout", async (req, reply) => {
    const sid = (req.cookies as Record<string, string | undefined>)?.[COOKIE_SID];
    destroySession(sid);
    reply.clearCookie(COOKIE_SID, { path: "/" });
    return reply.send({ ok: true });
  });

  /** Rehidrata a sessão após reload da página. */
  app.get("/api/session", async (req, reply) => {
    const session = exigirSessao(req, reply);
    if (!session) return;
    return reply.send({ env: env.SINQIA_ENV, ...sessionPublica(session) });
  });

  /* ---------------------------------------------------------------- */
  /* Cadastro em lote                                                  */
  /* ---------------------------------------------------------------- */

  // Dry-run: parse + validação. NÃO cadastra.
  app.post("/api/validate", async (req, reply) => {
    const session = exigirSessao(req, reply);
    if (!session) return;

    let payload: UploadPayload;
    try {
      payload = await readUpload(req);
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }

    let clientes: Cliente[];
    try {
      clientes = parseByFilename(payload.filename, payload.content);
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message, stage: "parse" });
    }

    const rows = validateRows(clientes);
    // Prévia dos payloads montados (com os campos de controle do lote).
    const preview = rows.map((r) => {
      try {
        return { index: r.index, payload: buildRequest(r.cliente, payload.control) };
      } catch (e) {
        return { index: r.index, error: (e as Error).message };
      }
    });

    const totalErros = rows.filter((r) => r.errors.length > 0).length;
    return reply.send({
      env: env.SINQIA_ENV,
      total: rows.length,
      totalErros,
      valido: totalErros === 0,
      rows: rows.map((r) => ({
        index: r.index,
        nome: r.nome,
        documento: r.documento,
        tipo: r.tipo,
        errors: r.errors,
      })),
      preview,
    });
  });

  // Executa o lote. Retorna jobId imediatamente; progresso via SSE.
  app.post("/api/import", async (req, reply) => {
    const session = exigirSessao(req, reply);
    if (!session) return;

    let payload: UploadPayload;
    try {
      payload = await readUpload(req);
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }

    let clientes: Cliente[];
    try {
      clientes = parseByFilename(payload.filename, payload.content);
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message, stage: "parse" });
    }

    // Modo "pular inválidas": linhas com erro são PULADAS (não enviadas à Sinqia);
    // só as válidas são cadastradas. Bloqueia apenas se NENHUMA linha for válida.
    const rows = validateRows(clientes);
    const validas = rows.filter((r) => r.errors.length === 0);
    if (validas.length === 0) {
      return reply.code(422).send({
        error: "Nenhuma linha válida para executar. Corrija o arquivo e valide novamente.",
        total: rows.length,
        invalidas: rows.length,
      });
    }

    const jobId = startJob({
      items: rows.map((r) => ({
        index: r.index,
        nome: r.nome,
        documento: r.documento,
        tipo: r.tipo,
        cliente: r.cliente,
        errors: r.errors,
      })),
      control: payload.control,
      token: session.token,
      sessionId: session.id,
    });

    return reply.send({
      jobId,
      total: rows.length,
      validas: validas.length,
      puladas: rows.length - validas.length,
      env: env.SINQIA_ENV,
    });
  });

  // SSE de progresso do lote de cadastro.
  app.get("/api/import/stream/:jobId", async (req, reply) => {
    const session = exigirSessao(req, reply);
    if (!session) return;

    const { jobId } = req.params as { jobId: string };
    const job = getJob(jobId);
    if (!job) return reply.code(404).send({ error: "Job não encontrado." });
    if (job.sessionId !== session.id) {
      return reply.code(403).send({ error: "Este lote pertence a outra sessão." });
    }
    streamJob(req, reply, job, getEmitter(jobId));
  });

  /* ---------------------------------------------------------------- */
  /* Situação de cliente                                               */
  /* ---------------------------------------------------------------- */

  /**
   * Carrega TODOS os clientes (varre as páginas com o token da sessão).
   *
   * A tela filtra localmente por número/nome/documento — filtrar só a página
   * corrente não acharia ninguém numa base grande.
   */
  app.post("/api/clientes", async (req, reply) => {
    const session = exigirSessao(req, reply);
    if (!session) return;

    const parsed = listarClientesBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: parsed.error.issues[0]?.message ?? "Requisição inválida." });
    }

    try {
      const res = await listarTodosClientes(session.token, parsed.data.tipoPessoa);
      return reply.send({ env: env.SINQIA_ENV, ...res });
    } catch (e) {
      // 401 no meio do varrimento = sessão morta.
      if (e instanceof Error && /HTTP 401/.test(e.message)) {
        destroySession(session.id);
        reply.clearCookie(COOKIE_SID, { path: "/" });
        return reply.code(401).send({
          error: "O token da Sinqia expirou. Entre novamente.",
          code: CODE_SESSAO_EXPIRADA,
          motivo: "token",
        });
      }
      return reply.code(502).send({ error: (e as Error).message, stage: "listar" });
    }
  });

  // Inicia a alteração de situação em lote. Progresso via SSE.
  app.post("/api/situacao", async (req, reply) => {
    const session = exigirSessao(req, reply);
    if (!session) return;

    const parsed = alterarSituacaoBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: parsed.error.issues[0]?.message ?? "Requisição inválida." });
    }
    const { cdSituacao, alvos } = parsed.data;

    const jobId = startSituacaoJob({
      alvos,
      cdSituacao,
      token: session.token,
      sessionId: session.id,
    });
    return reply.send({ jobId, total: alvos.length, env: env.SINQIA_ENV });
  });

  // SSE de progresso da alteração de situação.
  app.get("/api/situacao/stream/:jobId", async (req, reply) => {
    const session = exigirSessao(req, reply);
    if (!session) return;

    const { jobId } = req.params as { jobId: string };
    const job = getSituacaoJob(jobId);
    if (!job) return reply.code(404).send({ error: "Job não encontrado." });
    if (job.sessionId !== session.id) {
      return reply.code(403).send({ error: "Esta alteração pertence a outra sessão." });
    }
    streamJob(req, reply, job, getSituacaoEmitter(jobId));
  });
}

/* ------------------------------------------------------------------ */
/* Schemas dos corpos JSON                                             */
/* ------------------------------------------------------------------ */

const loginBodySchema = z.object({
  username: z
    .string({ required_error: "Usuário é obrigatório." })
    .min(1, "Usuário é obrigatório."),
  password: z
    .string({ required_error: "Senha é obrigatória." })
    .min(1, "Senha é obrigatória."),
});

/**
 * Só tipoPessoa: paginação e busca não vêm da tela — o backend varre todas as
 * páginas e o filtro acontece no front.
 */
const listarClientesBodySchema = z.object({
  tipoPessoa: z.string().optional(),
});

const alterarSituacaoBodySchema = z.object({
  cdSituacao: cdSituacaoSchema,
  alvos: z
    .array(
      z.object({
        nrCliente: z.number().int(),
        nome: z.string().default(""),
        documento: z.string().default(""),
        situacaoAnterior: z.string().default(""),
      }),
    )
    .min(1, "Selecione ao menos um cliente."),
});

/* ------------------------------------------------------------------ */
/* SSE compartilhado pelos jobs de cadastro e de situação              */
/* ------------------------------------------------------------------ */

/** Campos comuns aos dois JobState que o stream precisa conhecer. */
interface StreamableJob {
  total: number;
  processed: number;
  success: number;
  error: number;
  done: boolean;
  results: unknown[];
}

function streamJob(
  req: any,
  reply: any,
  job: StreamableJob,
  emitter: { on: Function; off: Function } | undefined,
) {
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": env.WEB_ORIGIN,
  });

  const send = (event: string, data: unknown) => {
    reply.raw.write(`event: ${event}\n`);
    reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // Reenvia o que já foi processado (caso o cliente conecte tarde).
  send("snapshot", {
    total: job.total,
    processed: job.processed,
    success: job.success,
    error: job.error,
    results: job.results,
    done: job.done,
  });

  if (job.done) {
    send("done", { total: job.total, success: job.success, error: job.error });
    reply.raw.end();
    return;
  }

  const listener = (payload: { event: string; data: unknown }) => {
    send(payload.event, payload.data);
    if (payload.event === "done") reply.raw.end();
  };
  emitter?.on("progress", listener);

  req.raw.on("close", () => {
    emitter?.off("progress", listener);
  });
}
