import type { FastifyInstance } from "fastify";
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
  type SituacaoJobState,
} from "./situacao-job.js";

interface UploadPayload {
  filename: string;
  content: string;
  username: string;
  password: string;
  control: BatchControl;
}

/** Lê o multipart: 1 arquivo + campos username/password/control(JSON). */
async function readUpload(req: any): Promise<UploadPayload> {
  let filename = "";
  let content = "";
  let username = "";
  let password = "";
  let controlRaw = "{}";

  const parts = req.parts();
  for await (const part of parts) {
    if (part.type === "file") {
      filename = part.filename ?? "";
      const buf = await part.toBuffer();
      content = buf.toString("utf8");
    } else {
      const value = part.value as string;
      if (part.fieldname === "username") username = value;
      else if (part.fieldname === "password") password = value;
      else if (part.fieldname === "control") controlRaw = value || "{}";
    }
  }

  if (!filename || !content) throw new Error("Arquivo não enviado.");
  if (!username || !password) throw new Error("Usuário e senha são obrigatórios.");

  const control = batchControlSchema.parse(JSON.parse(controlRaw));
  return { filename, content, username, password, control };
}

export async function registerRoutes(app: FastifyInstance) {
  // Health + info de ambiente (sem segredos).
  app.get("/api/health", async () => ({
    ok: true,
    env: env.SINQIA_ENV,
    baseUrl: env.SINQIA_BASE_URL,
  }));

  // Template CSV para download.
  app.get("/api/template.csv", async (_req, reply) => {
    const csv = buildTemplateCsv();
    reply
      .header("Content-Type", "text/csv; charset=utf-8")
      .header("Content-Disposition", 'attachment; filename="template.csv"')
      .send("﻿" + csv); // BOM para Excel abrir acentos corretamente
  });

  // Dry-run: login (confirma credencial+VPN) + parse + validação. NÃO cadastra.
  app.post("/api/validate", async (req, reply) => {
    let payload: UploadPayload;
    try {
      payload = await readUpload(req);
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }

    // Confirma credencial + acesso (VPN) fazendo login de verdade.
    try {
      await login(payload.username, payload.password);
    } catch (e) {
      const status = e instanceof SinqiaAuthError ? e.httpStatus : 502;
      return reply.code(status === 401 || status === 403 ? 401 : 502).send({
        error: (e as Error).message,
        stage: "login",
      });
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
      username: payload.username,
      password: payload.password,
    });

    return reply.send({
      jobId,
      total: rows.length,
      validas: validas.length,
      puladas: rows.length - validas.length,
      env: env.SINQIA_ENV,
    });
  });

  // SSE de progresso do job.
  app.get("/api/import/stream/:jobId", async (req, reply) => {
    const { jobId } = req.params as { jobId: string };
    const job = getJob(jobId);
    if (!job) return reply.code(404).send({ error: "Job não encontrado." });

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

    // Reenvia resultados já processados (se o cliente conectou tarde).
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

    const emitter = getEmitter(jobId);
    const listener = (payload: { event: string; data: unknown }) => {
      send(payload.event, payload.data);
      if (payload.event === "done") {
        reply.raw.end();
      }
    };
    emitter?.on("progress", listener);

    req.raw.on("close", () => {
      emitter?.off("progress", listener);
    });
  });

  /* ---------------------------------------------------------------- */
  /* Situação de cliente                                               */
  /* ---------------------------------------------------------------- */

  /**
   * Carrega TODOS os clientes (varre as páginas com um login só).
   *
   * A tela filtra localmente por número/nome/documento — filtrar só a página
   * corrente não acharia ninguém numa base grande.
   */
  app.post("/api/clientes", async (req, reply) => {
    const parsed = listarClientesBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Requisição inválida." });
    }
    const { username, password, tipoPessoa } = parsed.data;

    let token: string;
    try {
      token = await login(username, password);
    } catch (e) {
      const status = e instanceof SinqiaAuthError ? e.httpStatus : 502;
      return reply
        .code(status === 401 || status === 403 ? 401 : 502)
        .send({ error: (e as Error).message, stage: "login" });
    }

    try {
      const res = await listarTodosClientes(token, tipoPessoa);
      return reply.send({ env: env.SINQIA_ENV, ...res });
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message, stage: "listar" });
    }
  });

  // Inicia a alteração de situação em lote. Progresso via SSE.
  app.post("/api/situacao", async (req, reply) => {
    const parsed = alterarSituacaoBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Requisição inválida." });
    }
    const { username, password, cdSituacao, alvos } = parsed.data;

    const jobId = startSituacaoJob({ alvos, cdSituacao, username, password });
    return reply.send({ jobId, total: alvos.length, env: env.SINQIA_ENV });
  });

  // SSE de progresso da alteração de situação.
  app.get("/api/situacao/stream/:jobId", async (req, reply) => {
    const { jobId } = req.params as { jobId: string };
    const job = getSituacaoJob(jobId);
    if (!job) return reply.code(404).send({ error: "Job não encontrado." });
    streamJob(req, reply, job, getSituacaoEmitter(jobId));
  });

  // Aviso de produção (a UI usa para exigir confirmação extra).
  app.get("/api/env", async () => ({
    env: env.SINQIA_ENV,
    isProd: isProd(),
    baseUrl: env.SINQIA_BASE_URL,
  }));
}

/* ------------------------------------------------------------------ */
/* Schemas dos corpos JSON das rotas de situação                       */
/* ------------------------------------------------------------------ */

const credenciaisSchema = {
  username: z.string().min(1, "Usuário é obrigatório."),
  password: z.string().min(1, "Senha é obrigatória."),
};

/**
 * Só credenciais + tipoPessoa: paginação e busca não vêm mais da tela — o
 * backend varre todas as páginas e o filtro acontece no front.
 */
const listarClientesBodySchema = z.object({
  ...credenciaisSchema,
  tipoPessoa: z.string().optional(),
});

const alterarSituacaoBodySchema = z.object({
  ...credenciaisSchema,
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

/** Handler SSE compartilhado pelos jobs de cadastro e de situação. */
function streamJob(
  req: any,
  reply: any,
  job: SituacaoJobState,
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
