import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { dateInt, emissaoRowSchema } from "@cadastro-lote/shared";
import { env } from "./env.js";
import { parseEmissoesXlsx } from "./emissoes.js";
import {
  getCalculoCompleto,
  getCalculoEmitter,
  getCalculoJob,
  startCalculoJob,
} from "./calculo-job.js";
import { getCriacaoEmitter, getCriacaoJob, startCriacaoJob } from "./criacao-job.js";
import { listarConvenios, listarFiliais, listarProdutos } from "./sinqia-client.js";
import {
  getVerificacaoEmitter,
  getVerificacaoJob,
  startVerificacaoJob,
} from "./verificacao-job.js";
import { streamJob } from "./routes.js";
import { destroySession, getSession, motivoTexto, type Session } from "./session.js";

/**
 * Rotas do módulo PROPOSTAS (Esteira de Originação).
 *
 * Fase 1: só o parse/pré-visualização do Emissoes.xlsx — nenhuma chamada à
 * Sinqia além da sessão. Cálculo (Fase 2) e criação (Fase 3) entram depois.
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

/** Lê o multipart preservando o binário (xlsx NÃO pode virar string utf8). */
async function readBinaryUpload(req: any): Promise<{ filename: string; buffer: Buffer }> {
  let filename = "";
  let buffer: Buffer | null = null;

  const parts = req.parts();
  for await (const part of parts) {
    if (part.type === "file") {
      filename = part.filename ?? "";
      buffer = await part.toBuffer();
    }
  }
  if (!filename || !buffer || buffer.length === 0) throw new Error("Arquivo não enviado.");
  return { filename, buffer };
}

export async function registerPropostasRoutes(app: FastifyInstance) {
  /**
   * Parse + pré-visualização do Emissoes.xlsx. Não toca na Sinqia.
   * Exige sessão mesmo assim: o arquivo contém dados pessoais de tomadores.
   */
  app.post("/api/propostas/parse", async (req, reply) => {
    const session = exigirSessao(req, reply);
    if (!session) return;

    let upload: { filename: string; buffer: Buffer };
    try {
      upload = await readBinaryUpload(req);
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }

    const lower = upload.filename.toLowerCase();
    if (!lower.endsWith(".xlsx") && !lower.endsWith(".xls")) {
      return reply.code(400).send({
        error: `"${upload.filename}" não é uma planilha Excel — o lote de propostas espera o Emissoes.xlsx.`,
      });
    }

    try {
      const { rows, porSituacao, avisos } = parseEmissoesXlsx(upload.buffer);
      // Garante o contrato compartilhado antes de mandar ao front.
      const validated = rows.map((r) => emissaoRowSchema.parse(r));
      return reply.send({
        env: env.SINQIA_ENV,
        arquivo: upload.filename,
        total: validated.length,
        porSituacao,
        avisos,
        rows: validated,
      });
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message, stage: "parse-xlsx" });
    }
  });

  /**
   * Fase 2 — cálculo em lote (calcProsp) + conferência com o Excel.
   * SOMENTE cálculo: nenhuma proposta é criada aqui. Progresso via SSE.
   */
  app.post("/api/propostas/calcular", async (req, reply) => {
    const session = exigirSessao(req, reply);
    if (!session) return;

    const parsed = calcularBodySchema.safeParse(req.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return reply.code(400).send({
        error: `Requisição inválida${issue ? `: ${issue.path.join(".")} — ${issue.message}` : "."}`,
      });
    }

    // Defensivo: linha com erro de parse não tem dados para calcular.
    const aptas = parsed.data.rows.filter((r) => r.erros.length === 0);
    if (aptas.length === 0) {
      return reply.code(422).send({
        error: "Nenhuma linha apta para cálculo (todas têm problemas de dados).",
      });
    }

    const jobId = startCalculoJob({
      rows: aptas,
      params: parsed.data.params,
      token: session.token,
      sessionId: session.id,
    });

    return reply.send({
      jobId,
      total: aptas.length,
      ignoradas: parsed.data.rows.length - aptas.length,
      env: env.SINQIA_ENV,
    });
  });

  // SSE de progresso do cálculo.
  app.get("/api/propostas/calcular/stream/:jobId", async (req, reply) => {
    const session = exigirSessao(req, reply);
    if (!session) return;

    const { jobId } = req.params as { jobId: string };
    const job = getCalculoJob(jobId);
    if (!job) return reply.code(404).send({ error: "Job não encontrado." });
    if (job.sessionId !== session.id) {
      return reply.code(403).send({ error: "Este cálculo pertence a outra sessão." });
    }
    streamJob(req, reply, job, getCalculoEmitter(jobId));
  });

  /**
   * Verifica na Sinqia (somente leitura) se cada cliente do Emissoes existe e
   * se o nrClient cadastrado bate com o derivado do ID_Sinqia.
   */
  app.post("/api/propostas/verificar-clientes", async (req, reply) => {
    const session = exigirSessao(req, reply);
    if (!session) return;

    const parsed = verificarBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: parsed.error.issues[0]?.message ?? "Requisição inválida." });
    }

    const jobId = startVerificacaoJob({
      alvos: parsed.data.alvos,
      token: session.token,
      sessionId: session.id,
    });
    return reply.send({ jobId, total: parsed.data.alvos.length, env: env.SINQIA_ENV });
  });

  // SSE de progresso da verificação.
  app.get("/api/propostas/verificar-clientes/stream/:jobId", async (req, reply) => {
    const session = exigirSessao(req, reply);
    if (!session) return;

    const { jobId } = req.params as { jobId: string };
    const job = getVerificacaoJob(jobId);
    if (!job) return reply.code(404).send({ error: "Job não encontrado." });
    if (job.sessionId !== session.id) {
      return reply.code(403).send({ error: "Esta verificação pertence a outra sessão." });
    }
    streamJob(req, reply, job, getVerificacaoEmitter(jobId));
  });

  /**
   * Lookups dos parâmetros do lote (somente leitura): produtos da
   * característica, convênios de produção e filiais (= loja) do convênio.
   * Falha parcial não derruba a resposta — cada lista vem vazia com aviso.
   */
  app.get("/api/propostas/lookups", async (req, reply) => {
    const session = exigirSessao(req, reply);
    if (!session) return;

    const q = lookupsQuerySchema.safeParse(req.query ?? {});
    if (!q.success) {
      return reply
        .code(400)
        .send({ error: q.error.issues[0]?.message ?? "Parâmetros inválidos." });
    }
    const { idCarctr, convenio } = q.data;

    const avisos: string[] = [];
    const [produtos, convenios, filiais] = await Promise.all([
      // Produtos são configurados por convênio — o filtro acompanha o select.
      listarProdutos(session.token, idCarctr, convenio).catch((e) => {
        avisos.push(`Produtos: ${(e as Error).message}`);
        return { httpStatus: 0, options: [] };
      }),
      listarConvenios(session.token).catch((e) => {
        avisos.push(`Convênios: ${(e as Error).message}`);
        return { httpStatus: 0, options: [] };
      }),
      convenio !== undefined
        ? listarFiliais(session.token, convenio).catch((e) => {
            avisos.push(`Filiais: ${(e as Error).message}`);
            return { httpStatus: 0, options: [] };
          })
        : Promise.resolve({ httpStatus: 0, options: [] }),
    ]);

    // 401 em qualquer lookup = sessão/token morto.
    if ([produtos, convenios, filiais].some((r) => r.httpStatus === 401)) {
      destroySession(session.id);
      reply.clearCookie(COOKIE_SID, { path: "/" });
      return reply.code(401).send({
        error: "O token da Sinqia expirou. Entre novamente.",
        code: CODE_SESSAO_EXPIRADA,
        motivo: "token",
      });
    }

    if (produtos.httpStatus >= 400) avisos.push(`Produtos: HTTP ${produtos.httpStatus}.`);
    if (convenios.httpStatus >= 400) avisos.push(`Convênios: HTTP ${convenios.httpStatus}.`);
    if (convenio !== undefined && filiais.httpStatus >= 400) {
      avisos.push(`Filiais do convênio ${convenio}: HTTP ${filiais.httpStatus}.`);
    }

    return reply.send({
      env: env.SINQIA_ENV,
      produtos: produtos.options,
      convenios: convenios.options,
      filiais: filiais.options,
      avisos,
    });
  });

  /**
   * Fase 3 — CRIA as propostas na Sinqia (irreversível).
   *
   * Usa os cálculos retidos do job da Fase 2 (`calcJobId`): só linhas que
   * terminaram OK lá podem ser criadas — a fonte da verdade é o servidor,
   * não o que o front mandar.
   */
  app.post("/api/propostas/criar", async (req, reply) => {
    const session = exigirSessao(req, reply);
    if (!session) return;

    const parsed = criarBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: parsed.error.issues[0]?.message ?? "Requisição inválida." });
    }
    const { calcJobId, linhas, params, piloto, forcarDuplicadas } = parsed.data;

    const calcJob = getCalculoJob(calcJobId);
    if (!calcJob) {
      return reply.code(410).send({
        error: "O cálculo deste lote não está mais em memória — recalcule antes de criar.",
      });
    }
    if (calcJob.sessionId !== session.id) {
      return reply.code(403).send({ error: "Este cálculo pertence a outra sessão." });
    }
    if (!calcJob.done) {
      return reply.code(409).send({ error: "Aguarde o cálculo terminar antes de criar." });
    }

    // Fonte da verdade: resultados OK do job de cálculo.
    const porLinha = new Map(calcJob.results.map((r) => [r.linha, r]));
    const items = [];
    for (const linha of linhas) {
      const r = porLinha.get(linha);
      if (!r || r.status !== "OK") continue; // só OK vira proposta
      const calculo = getCalculoCompleto(calcJobId, linha);
      if (!calculo) continue;
      items.push({ linha: r.linha, nome: r.nome, cpf: r.cpf, calculo });
    }
    if (items.length === 0) {
      return reply.code(422).send({
        error: "Nenhuma linha OK disponível para criação (recalcule se necessário).",
      });
    }

    const selecionados = piloto ? items.slice(0, 1) : items;
    const jobId = startCriacaoJob({
      items: selecionados,
      params,
      forcarDuplicadas,
      token: session.token,
      sessionId: session.id,
    });

    app.log.info(
      `Criação de propostas iniciada: ${selecionados.length} linha(s)` +
        `${piloto ? " (PILOTO)" : ""} — ambiente ${env.SINQIA_ENV.toUpperCase()}`,
    );
    return reply.send({
      jobId,
      total: selecionados.length,
      ignoradas: linhas.length - items.length,
      piloto: Boolean(piloto),
      env: env.SINQIA_ENV,
    });
  });

  // SSE de progresso da criação.
  app.get("/api/propostas/criar/stream/:jobId", async (req, reply) => {
    const session = exigirSessao(req, reply);
    if (!session) return;

    const { jobId } = req.params as { jobId: string };
    const job = getCriacaoJob(jobId);
    if (!job) return reply.code(404).send({ error: "Job não encontrado." });
    if (job.sessionId !== session.id) {
      return reply.code(403).send({ error: "Esta criação pertence a outra sessão." });
    }
    streamJob(req, reply, job, getCriacaoEmitter(jobId));
  });
}

/** Query do GET /api/propostas/lookups. */
const lookupsQuerySchema = z.object({
  idCarctr: z.coerce.number().int().default(31),
  convenio: z.coerce.number().int().optional(),
});

/** Body do POST /api/propostas/criar. */
const criarBodySchema = z.object({
  calcJobId: z.string().uuid("calcJobId inválido."),
  linhas: z.array(z.number().int().positive()).min(1, "Selecione ao menos uma linha OK."),
  params: z.object({
    txJuros: z.number().positive(),
    cdProd: z.number().int(),
    idCarCtr: z.number().int(),
    cdConven: z.string().min(1),
    /** Ausente = proposta sem loja/filial. */
    cdLoja: z.number().int().optional(),
    dtContra: dateInt,
  }),
  /** true = cria SÓ a primeira linha, para inspecionar antes do restante. */
  piloto: z.boolean().default(false),
  /**
   * true = cria mesmo quando o cliente já tem proposta com assinatura idêntica
   * (reemissão consciente). Default: pular duplicadas.
   */
  forcarDuplicadas: z.boolean().default(false),
});

/** Body do POST /api/propostas/verificar-clientes. */
const verificarBodySchema = z.object({
  alvos: z
    .array(
      z.object({
        linha: z.number().int().positive(),
        nome: z.string().default(""),
        cpf: z.string().min(11).max(14),
        nrClient: z.number().int().nullable(),
      }),
    )
    .min(1, "Nenhuma linha para verificar.")
    .max(500),
});

/** Body do POST /api/propostas/calcular. Limite de 500 linhas por lote. */
const calcularBodySchema = z.object({
  rows: z.array(emissaoRowSchema).min(1, "Selecione ao menos uma linha.").max(500),
  params: z.object({
    txJuros: z.number().positive("Taxa de juros deve ser positiva."),
    cdProd: z.number().int(),
    idCarCtr: z.number().int(),
    dtContra: dateInt,
  }),
});
