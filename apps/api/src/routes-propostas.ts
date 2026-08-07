import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { dateInt, emissaoRowSchema, type CalcProspCalculo } from "@cadastro-lote/shared";
import { env } from "./env.js";
import { parseEmissoesXlsx } from "./emissoes.js";
import {
  buildCalcRequestDados,
  getCalculoCompleto,
  getCalculoEmitter,
  getCalculoJob,
  startCalculoJob,
} from "./calculo-job.js";
import {
  criarUma,
  getCriacaoEmitter,
  getCriacaoJob,
  startCriacaoJob,
  SessaoExpiradaError,
} from "./criacao-job.js";
import {
  buscarClientePorCpf,
  calcProsp,
  consultarHistoricoProposta,
  consultarPropostaPainel,
  consultarStatusTransf,
  consultarStatusWf,
  listarConvenios,
  listarFiliais,
  listarProdutos,
  transferirStatus,
} from "./sinqia-client.js";
import {
  getVerificacaoEmitter,
  getVerificacaoJob,
  startVerificacaoJob,
} from "./verificacao-job.js";
import { streamJob } from "./routes.js";
import {
  destroySession,
  extrairInstAgen,
  getSession,
  motivoTexto,
  type Session,
} from "./session.js";

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

  /* ------------------- Proposta INDIVIDUAL (fluxo unitário) ------------------- */

  /** Sessão/token da Sinqia morto no meio de uma chamada síncrona. */
  const responder401 = (reply: FastifyReply, sessionId: string) => {
    destroySession(sessionId);
    reply.clearCookie(COOKIE_SID, { path: "/" });
    return reply.code(401).send({
      error: "O token da Sinqia expirou. Entre novamente.",
      code: CODE_SESSAO_EXPIRADA,
      motivo: "token",
    });
  };

  /**
   * Passo 1 — busca o cliente por CPF (somente leitura, autoritativo no
   * ambiente ativo). As propostas existentes vêm do endpoint já existente
   * /api/clientes/:cpf/propostas.
   */
  app.get("/api/propostas/cliente/:cpf", async (req, reply) => {
    const session = exigirSessao(req, reply);
    if (!session) return;

    const cpf = String((req.params as { cpf?: string }).cpf ?? "").replace(/\D/g, "");
    if (cpf.length !== 11) {
      return reply.code(400).send({ error: "CPF deve ter 11 dígitos." });
    }

    const busca = await buscarClientePorCpf(session.token, cpf);
    if (busca.httpStatus === 401) return responder401(reply, session.id);

    return reply.send({
      env: env.SINQIA_ENV,
      httpStatus: busca.httpStatus,
      encontrado: busca.encontrado,
      nrClient: busca.nrClient,
      nome: busca.dsNome,
    });
  });

  /**
   * Passo 2 — cálculo de UMA operação (calcProsp; nada é gravado). O bloco
   * `calculo` completo fica retido no servidor por sessão: a criação parte
   * dele, nunca de valores reenviados pelo front.
   */
  app.post("/api/propostas/calcular-uma", async (req, reply) => {
    const session = exigirSessao(req, reply);
    if (!session) return;

    const parsed = calcularUmaBodySchema.safeParse(req.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return reply.code(400).send({
        error: `Requisição inválida${issue ? `: ${issue.path.join(".")} — ${issue.message}` : "."}`,
      });
    }
    const { cpf, nome, dados, params } = parsed.data;

    const request = buildCalcRequestDados({ cpf, ...dados }, params);
    const { httpStatus, calculo, analysis, rawBody } = await calcProsp(session.token, request);
    if (httpStatus === 401) return responder401(reply, session.id);

    if (!calculo) {
      return reply.code(422).send({
        error: analysis.reason ?? "A Sinqia não devolveu o cálculo.",
        httpStatus,
        messages: analysis.messagesText || rawBody?.slice(0, 300) || "",
        request,
      });
    }

    const calcId = reterCalculoIndividual({
      sessionId: session.id,
      cpf,
      nome,
      calculo,
      criadoEm: Date.now(),
    });

    return reply.send({
      env: env.SINQIA_ENV,
      calcId,
      httpStatus,
      messages: analysis.messagesText,
      request,
      resumo: {
        vlPresta: calculo.vlPresta,
        vlFinanciado: calculo.vlContra,
        vlLiquid: calculo.vlLiquid,
        vlIof: calculo.vlIof,
        vlTotal: calculo.vlTotal,
        txAm: calculo.txAm,
        txCetAm: calculo.txCetAm,
        qtPrest: calculo.qtPrest,
        dtVct1ap: calculo.dtVct1ap,
        dtVctult: calculo.dtVctult,
        vlTac: calculo.vlTac ?? 0,
        vlSeguro: calculo.vlSeguro ?? 0,
        vlOutvlr: calculo.vlOutvlr ?? 0,
      },
    });
  });

  /**
   * Passo 3 — CRIA a proposta individual (irreversível). Mesmo caminho do
   * lote: busca do cliente na hora, guarda de duplicidade, TAC via vlConces,
   * sem retry (não idempotente).
   */
  app.post("/api/propostas/criar-uma", async (req, reply) => {
    const session = exigirSessao(req, reply);
    if (!session) return;

    const parsed = criarUmaBodySchema.safeParse(req.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return reply.code(400).send({
        error: `Requisição inválida${issue ? `: ${issue.path.join(".")} — ${issue.message}` : "."}`,
      });
    }
    const { calcId, params, forcarDuplicada } = parsed.data;

    const retido = calculosIndividuais.get(calcId);
    if (!retido) {
      return reply.code(410).send({
        error: "O cálculo desta proposta não está mais em memória — recalcule antes de criar.",
      });
    }
    if (retido.sessionId !== session.id) {
      return reply.code(403).send({ error: "Este cálculo pertence a outra sessão." });
    }

    try {
      const result = await criarUma(
        session.token,
        { linha: 1, nome: retido.nome, cpf: retido.cpf, calculo: retido.calculo },
        params,
        forcarDuplicada,
      );
      // Criada com sucesso: descarta o cálculo retido para impedir reenvio
      // acidental do MESMO calcId (nova proposta exige novo cálculo).
      if (result.status === "OK") calculosIndividuais.delete(calcId);

      app.log.info(
        `Proposta individual: ${result.status} (CPF final ${retido.cpf.slice(-4)}) — ` +
          `ambiente ${env.SINQIA_ENV.toUpperCase()}`,
      );
      return reply.send({ env: env.SINQIA_ENV, ...result });
    } catch (e) {
      if (e instanceof SessaoExpiradaError) return responder401(reply, session.id);
      return reply.code(502).send({ error: (e as Error).message });
    }
  });

  /* ------------------- Painel de propostas (somente leitura) ------------------- */

  /**
   * Listagem geral de propostas com filtros e cursor — o mesmo
   * consultarPropostaPainel do Portal. Sem cursor no body, parte de agora
   * olhando para trás (mais recentes primeiro).
   */
  app.post("/api/propostas/painel", async (req, reply) => {
    const session = exigirSessao(req, reply);
    if (!session) return;

    const parsed = painelBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return reply.code(400).send({
        error: `Requisição inválida${issue ? `: ${issue.path.join(".")} — ${issue.message}` : "."}`,
      });
    }
    const { filtros, size } = parsed.data;
    const cursor = parsed.data.cursor ?? cursorAgora();

    const res = await consultarPropostaPainel(session.token, filtros, cursor, size);
    if (res.httpStatus === 401) return responder401(reply, session.id);
    if (res.httpStatus >= 400) {
      return reply
        .code(502)
        .send({ error: `A Sinqia respondeu HTTP ${res.httpStatus} no painel de propostas.` });
    }

    // Cursor da PRÓXIMA página: entrada da última linha (o front dedup por nrProsp).
    const ultima = res.propostas[res.propostas.length - 1];
    const proximoCursor =
      res.propostas.length === size && ultima?.dtEntrad
        ? {
            dtConsulta: String(ultima.dtEntrad),
            hrConsulta: `${String(ultima.hrEntrad ?? 0).padStart(4, "0")}00`,
            idSentido: "ANT" as const,
          }
        : null;

    return reply.send({
      env: env.SINQIA_ENV,
      httpStatus: res.httpStatus,
      propostas: res.propostas,
      proximoCursor,
    });
  });

  /**
   * VISÃO GERAL agregada (dashboard do Início): varre as filas do workflow
   * proposta a proposta pelo consultarPropostaPainel — o que permite filtrar
   * por convênio (cdConvProd, que o consultarStatusWf não tem) e contabilizar
   * o SLA real (atrasadas = paradas há mais de SLA_HORAS na etapa).
   */
  app.get("/api/propostas/visao-geral", async (req, reply) => {
    const session = exigirSessao(req, reply);
    if (!session) return;

    const q = visaoGeralQuerySchema.safeParse(req.query ?? {});
    if (!q.success) {
      return reply
        .code(400)
        .send({ error: q.error.issues[0]?.message ?? "Parâmetros inválidos." });
    }
    const convenio = q.data.convenio;

    const claims = extrairInstAgen(session.token);
    const wf = await consultarStatusWf(session.token, {
      nrInst: claims.nrInst ?? env.SINQIA_NR_INST,
      nrAgen: claims.nrAgen ?? env.SINQIA_NR_AGEN,
      nmLogin: session.username,
    });
    if (wf.httpStatus === 401) return responder401(reply, session.id);
    if (wf.httpStatus >= 400) {
      return reply
        .code(502)
        .send({ error: `A Sinqia respondeu HTTP ${wf.httpStatus} nas filas do workflow.` });
    }

    const ordenadas = [...wf.filas].sort((a, b) => a.nrStatus - b.nrStatus);
    /** Etapas encerradas não entram na régua de SLA (nada "atrasa" nelas). */
    const etapaEncerrada = (ds: string) => /cancelad|negad|finalizado no portal/i.test(ds);

    // Teto de chamadas da varredura — proteção contra bases gigantes.
    const MAX_CONSULTAS = 25;
    const TAMANHO_PAGINA = 200;
    let consultasUsadas = 0;
    let parcial = false;

    const filasAgregadas = [];
    for (const f of ordenadas) {
      const encerrada = etapaEncerrada(f.dsStatus);
      const base = {
        nrWf: f.nrWf,
        nrStatus: f.nrStatus,
        dsStatus: f.dsStatus,
        qtFilhos: f.qtFilhos,
      };

      if (f.qtFilhos === 0) {
        filasAgregadas.push({ ...base, noFiltro: 0, atrasadas: 0 });
        continue;
      }
      // Sem filtro de convênio, etapa encerrada dispensa varredura: a contagem
      // global serve e SLA não se aplica.
      if (encerrada && convenio === undefined) {
        filasAgregadas.push({ ...base, noFiltro: f.qtFilhos, atrasadas: 0 });
        continue;
      }
      if (consultasUsadas >= MAX_CONSULTAS) {
        parcial = true;
        filasAgregadas.push({ ...base, noFiltro: null, atrasadas: null });
        continue;
      }

      const vistos = new Set<number>();
      let atrasadas = 0;
      let cursor = cursorAgora() as {
        dtConsulta: string;
        hrConsulta: string;
        idSentido: "POS" | "ANT";
      };

      while (consultasUsadas < MAX_CONSULTAS) {
        consultasUsadas++;
        const pagina = await consultarPropostaPainel(
          session.token,
          { nrStatus: f.nrStatus, cdConvProd: convenio },
          cursor,
          TAMANHO_PAGINA,
        );
        if (pagina.httpStatus === 401) return responder401(reply, session.id);
        if (pagina.httpStatus >= 400) break;

        for (const p of pagina.propostas) {
          if (vistos.has(p.nrProsp)) continue;
          vistos.add(p.nrProsp);
          if (!encerrada && horasDesde(p.dtEntrad, p.hrEntrad) > SLA_HORAS) atrasadas++;
        }

        const ultima = pagina.propostas[pagina.propostas.length - 1];
        if (pagina.propostas.length < TAMANHO_PAGINA || !ultima?.dtEntrad) break;
        cursor = {
          dtConsulta: String(ultima.dtEntrad),
          hrConsulta: `${String(ultima.hrEntrad ?? 0).padStart(4, "0")}00`,
          idSentido: "ANT",
        };
      }
      if (consultasUsadas >= MAX_CONSULTAS) parcial = true;

      filasAgregadas.push({ ...base, noFiltro: vistos.size, atrasadas });
    }

    const totalAtrasadas = filasAgregadas.reduce((acc, f) => acc + (f.atrasadas ?? 0), 0);
    return reply.send({
      env: env.SINQIA_ENV,
      convenio: convenio ?? null,
      slaHoras: SLA_HORAS,
      parcial,
      totalAtrasadas,
      filas: filasAgregadas,
    });
  });

  /** Filas do workflow com contagem por status (dashboard da esteira). */
  app.get("/api/propostas/filas", async (req, reply) => {
    const session = exigirSessao(req, reply);
    if (!session) return;

    // Instituição/agência: claims do JWT do login; fallback = env.
    const claims = extrairInstAgen(session.token);
    const res = await consultarStatusWf(session.token, {
      nrInst: claims.nrInst ?? env.SINQIA_NR_INST,
      nrAgen: claims.nrAgen ?? env.SINQIA_NR_AGEN,
      nmLogin: session.username,
    });
    if (res.httpStatus === 401) return responder401(reply, session.id);
    if (res.httpStatus >= 400) {
      return reply
        .code(502)
        .send({ error: `A Sinqia respondeu HTTP ${res.httpStatus} nas filas do workflow.` });
    }
    return reply.send({ env: env.SINQIA_ENV, filas: res.filas });
  });

  /** Histórico (linha do tempo) de uma proposta. */
  app.get("/api/propostas-historico/:nrProsp", async (req, reply) => {
    const session = exigirSessao(req, reply);
    if (!session) return;

    const nrProsp = String((req.params as { nrProsp?: string }).nrProsp ?? "").replace(/\D/g, "");
    if (!nrProsp) return reply.code(400).send({ error: "Número de proposta inválido." });

    const res = await consultarHistoricoProposta(session.token, nrProsp);
    if (res.httpStatus === 401) return responder401(reply, session.id);
    return reply.send({ env: env.SINQIA_ENV, historicos: res.historicos });
  });

  /** Destinos permitidos a partir do status atual (somente leitura). */
  app.get("/api/propostas-transicoes", async (req, reply) => {
    const session = exigirSessao(req, reply);
    if (!session) return;

    const q = transicoesQuerySchema.safeParse(req.query ?? {});
    if (!q.success) {
      return reply
        .code(400)
        .send({ error: q.error.issues[0]?.message ?? "Parâmetros inválidos." });
    }

    const res = await consultarStatusTransf(session.token, q.data.nrWf, q.data.nrStatus);
    if (res.httpStatus === 401) return responder401(reply, session.id);
    return reply.send({ env: env.SINQIA_ENV, transicoes: res.transicoes });
  });

  /**
   * MOVE a proposta de fila (transfStatus — efeito real e irreversível pela
   * ferramenta). O destino é revalidado no servidor contra o
   * consultarStatusTransf: só transição que o workflow permite passa.
   */
  app.post("/api/propostas-transferir", async (req, reply) => {
    const session = exigirSessao(req, reply);
    if (!session) return;

    const parsed = transferirBodySchema.safeParse(req.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return reply.code(400).send({
        error: `Requisição inválida${issue ? `: ${issue.path.join(".")} — ${issue.message}` : "."}`,
      });
    }
    const b = parsed.data;

    // Revalida o destino no workflow — o front não é fonte de verdade.
    const permitidas = await consultarStatusTransf(session.token, b.nrWf, b.nrStatusAtual);
    if (permitidas.httpStatus === 401) return responder401(reply, session.id);
    const destino = permitidas.transicoes.find((t) => t.proxStatus === b.proxStatus);
    if (!destino) {
      return reply.code(422).send({
        error:
          `O workflow não permite mover do status ${b.nrStatusAtual} para ${b.proxStatus}. ` +
          "Recarregue a fila — a proposta pode ter mudado de etapa.",
      });
    }
    if (destino.exigeObservacao && !b.dsObserv.trim()) {
      return reply.code(422).send({
        error: `A transição para "${destino.dsStatus}" exige observação.`,
      });
    }

    const res = await transferirStatus(session.token, {
      nrStatus: b.proxStatus,
      dsObserv: b.dsObserv.trim(),
      nrCpf: b.nrCpf,
      nrProsp: b.nrProsp,
      nmCliente: b.nmCliente,
      nrWf: b.nrWf,
      cdProd: b.cdProd,
      nrContra: b.nrContra ?? 0,
    });
    if (res.httpStatus === 401) return responder401(reply, session.id);

    app.log.info(
      `Transferência de status: proposta ${b.nrProsp} ${b.nrStatusAtual}→${b.proxStatus} ` +
        `(${res.ok ? "OK" : "FALHOU"}) — ambiente ${env.SINQIA_ENV.toUpperCase()}`,
    );

    if (!res.ok) {
      return reply.code(502).send({
        error: `A Sinqia não confirmou a transferência: ${res.detalhe}`,
        httpStatus: res.httpStatus,
      });
    }
    return reply.send({
      env: env.SINQIA_ENV,
      ok: true,
      destino: { proxStatus: destino.proxStatus, dsStatus: destino.dsStatus },
    });
  });
}

/** Régua de SLA: acima disso na mesma etapa, a proposta conta como atrasada. */
const SLA_HORAS = 72;

/** Horas corridas desde a entrada no status (dtEntrad AAAAMMDD + hrEntrad HHMM). */
function horasDesde(dtEntrad: number | null, hrEntrad: number | null): number {
  if (!dtEntrad) return 0;
  const s = String(dtEntrad);
  if (s.length !== 8) return 0;
  const hr = String(hrEntrad ?? 0).padStart(4, "0");
  const d = new Date(
    Number(s.slice(0, 4)),
    Number(s.slice(4, 6)) - 1,
    Number(s.slice(6, 8)),
    Number(hr.slice(0, 2)),
    Number(hr.slice(2, 4)),
  );
  if (Number.isNaN(d.getTime())) return 0;
  return Math.max(0, (Date.now() - d.getTime()) / 3_600_000);
}

/** Query do GET /api/propostas/visao-geral. */
const visaoGeralQuerySchema = z.object({
  convenio: z.coerce.number().int().optional(),
});

/** Cursor inicial do painel: agora, olhando para trás (mais recentes primeiro). */
function cursorAgora(): { dtConsulta: string; hrConsulta: string; idSentido: "ANT" } {
  const d = new Date();
  const pad = (n: number, l = 2) => String(n).padStart(l, "0");
  return {
    dtConsulta: `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`,
    hrConsulta: `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`,
    idSentido: "ANT",
  };
}

/** Cálculo individual retido por sessão — insumo do criar-uma. */
interface CalculoIndividualRetido {
  sessionId: string;
  cpf: string;
  nome: string;
  calculo: CalcProspCalculo;
  criadoEm: number;
}

const calculosIndividuais = new Map<string, CalculoIndividualRetido>();
const MAX_CALCULOS_INDIVIDUAIS = 20;

function reterCalculoIndividual(entry: CalculoIndividualRetido): string {
  while (calculosIndividuais.size >= MAX_CALCULOS_INDIVIDUAIS) {
    const maisAntigo = [...calculosIndividuais.entries()].sort(
      (a, b) => a[1].criadoEm - b[1].criadoEm,
    )[0];
    if (!maisAntigo) break;
    calculosIndividuais.delete(maisAntigo[0]);
  }
  const id = randomUUID();
  calculosIndividuais.set(id, entry);
  return id;
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

const dinheiroOpcional = z.number().nonnegative().optional();

/** Body do POST /api/propostas/calcular-uma (proposta individual). */
const calcularUmaBodySchema = z.object({
  cpf: z.string().regex(/^\d{11}$/, "CPF deve ter 11 dígitos."),
  nome: z.string().default(""),
  dados: z.object({
    vlLiquido: z.number().positive("Informe o valor líquido da operação."),
    qtParcelas: z.number().int().positive("Quantidade de parcelas inválida."),
    dtVct1Ap: dateInt,
    vlTac: dinheiroOpcional,
    vlSeguro: dinheiroOpcional,
    vlOutros: dinheiroOpcional,
  }),
  params: z.object({
    txJuros: z.number().positive("Taxa de juros deve ser positiva."),
    cdProd: z.number().int(),
    idCarCtr: z.number().int(),
    dtContra: dateInt,
  }),
});

/** Body do POST /api/propostas/painel (listagem geral, somente leitura). */
const painelBodySchema = z.object({
  filtros: z
    .object({
      nrPropos: z.string().max(20).optional(),
      nrCPFCNPJ: z.string().max(14).optional(),
      nmClient: z.string().max(120).optional(),
      /** AAAAMMDD como string (formato do Portal). */
      dtPerIni: z.string().regex(/^\d{8}$/).optional(),
      dtPerFim: z.string().regex(/^\d{8}$/).optional(),
      nrStatus: z.number().int().optional(),
      cdProdut: z.number().int().optional(),
      cdConvProd: z.number().int().optional(),
    })
    .default({}),
  size: z.number().int().min(1).max(200).default(100),
  cursor: z
    .object({
      dtConsulta: z.string().regex(/^\d{8}$/),
      hrConsulta: z.string().regex(/^\d{4,6}$/),
      idSentido: z.enum(["POS", "ANT"]),
    })
    .optional(),
});

/** Query do GET /api/propostas-transicoes. */
const transicoesQuerySchema = z.object({
  nrWf: z.coerce.number().int(),
  nrStatus: z.coerce.number().int(),
});

/** Body do POST /api/propostas-transferir (move a proposta de fila). */
const transferirBodySchema = z.object({
  nrProsp: z.number().int().positive(),
  nrWf: z.number().int(),
  nrStatusAtual: z.number().int(),
  proxStatus: z.number().int(),
  dsObserv: z.string().max(500).default(""),
  nrCpf: z.string().min(11).max(14),
  nmCliente: z.string().max(120).default(""),
  cdProd: z.number().int(),
  nrContra: z.number().int().nullable().optional(),
});

/** Body do POST /api/propostas/criar-uma (proposta individual). */
const criarUmaBodySchema = z.object({
  calcId: z.string().uuid("calcId inválido."),
  params: z.object({
    txJuros: z.number().positive(),
    cdProd: z.number().int(),
    idCarCtr: z.number().int(),
    cdConven: z.string().min(1),
    /** Ausente = proposta sem loja/filial. */
    cdLoja: z.number().int().optional(),
    dtContra: dateInt,
  }),
  /** true = cria mesmo com proposta idêntica existente (reemissão consciente). */
  forcarDuplicada: z.boolean().default(false),
});
