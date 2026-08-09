import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  aprovadaNoFunil,
  batchControlSchema,
  categoriaDaEtapa,
  chaveDuplicidadeProposta,
  dateInt,
  emissaoRowSchema,
  normalizarDocumento,
  ROTULO_CONFERENCIA_PLANILHA,
  ROTULO_REFERENCIA_CALCULO,
  type BatchControl,
  type CalcProspCalculo,
  type CalcProspRequest,
  type Cliente,
  type ItemLoteSodPayload,
  type PropostaLoteItemSodPayload,
  type PropostaLoteSodPayload,
  type PropostaSodPayload,
  type TipoAcaoSod,
} from "@cadastro-lote/shared";
import {
  ajustePersonasTomadores,
  definirPersona,
  listarPersonas,
  registrarEvento,
  somarValoresRegistrados,
} from "./db.js";
import {
  getTransferenciaEmitter,
  getTransferenciaJob,
  startTransferenciaJob,
} from "./transferencia-job.js";
import { env } from "./env.js";
import { parseEmissoesXlsx } from "./emissoes.js";
import { buildTemplatePropostasCsv } from "./template.js";
import { buildRequest, parseByFilename, validateRows } from "./parse-input.js";
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
  listarClientes,
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
import { aprovacaoAtiva, type AprovacaoAtivaFn } from "./sod/flags.js";
import { guardarExecucaoDireta } from "./sod/corte.js";
import { responderErroSod, sodServicoPadrao } from "./sod/rotas.js";
import type { SodServico } from "./sod/dominio.js";

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

/**
 * Lê o multipart do arquivo de TOMADORES do lote composto (US-07): texto
 * CSV/JSON + campo control (JSON) — mesmo contrato do readUpload de routes.ts.
 */
async function readUploadTomadores(
  req: any,
): Promise<{ filename: string; content: string; control: BatchControl }> {
  let filename = "";
  let content = "";
  let controlRaw = "{}";

  const parts = req.parts();
  for await (const part of parts) {
    if (part.type === "file") {
      filename = part.filename ?? "";
      content = (await part.toBuffer()).toString("utf8");
    } else if (part.fieldname === "control") {
      controlRaw = (part.value as string) || "{}";
    }
  }
  if (!filename || !content) throw new Error("Arquivo não enviado.");
  return { filename, content, control: batchControlSchema.parse(JSON.parse(controlRaw)) };
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

/**
 * Dependências injetáveis nos testes — o runtime usa os padrões. Mesmo padrão
 * do RegisterRoutesDeps de routes.ts: os cenários da Esteira de Aprovação
 * (US-04) provam "zero criações na Sinqia" com spies, offline.
 */
export interface RegisterPropostasDeps {
  calcProspFn?: typeof calcProsp;
  buscarClientePorCpfFn?: typeof buscarClientePorCpf;
  criarUmaFn?: typeof criarUma;
  /** Movimentação individual (US-08) — spies provam "zero transfStatus" no desvio. */
  transferirStatusFn?: typeof transferirStatus;
  consultarStatusTransfFn?: typeof consultarStatusTransf;
  /** Preguiçoso: só abre o banco quando o toggle está ativo. */
  sodServico?: () => SodServico;
  aprovacaoAtivaFn?: AprovacaoAtivaFn;
}

export async function registerPropostasRoutes(
  app: FastifyInstance,
  deps: RegisterPropostasDeps = {},
) {
  const calcProspFn = deps.calcProspFn ?? calcProsp;
  const buscarClientePorCpfFn = deps.buscarClientePorCpfFn ?? buscarClientePorCpf;
  const criarUmaFn = deps.criarUmaFn ?? criarUma;
  const transferirStatusFn = deps.transferirStatusFn ?? transferirStatus;
  const consultarStatusTransfFn = deps.consultarStatusTransfFn ?? consultarStatusTransf;
  const sodServico = deps.sodServico ?? sodServicoPadrao;
  const aprovacaoAtivaFn = deps.aprovacaoAtivaFn ?? aprovacaoAtiva;
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
    // US-07: além do Excel, o mesmo layout em CSV (template para download em
    // /api/propostas/template.csv) — o parser lê os dois formatos.
    if (!lower.endsWith(".xlsx") && !lower.endsWith(".xls") && !lower.endsWith(".csv")) {
      return reply.code(400).send({
        error:
          `"${upload.filename}" não é uma planilha — o lote de propostas espera o ` +
          `Emissoes.xlsx ou um CSV com as mesmas colunas (baixe o modelo na tela).`,
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

  /** Modelo CSV do lote de propostas (mesmas colunas do Emissoes.xlsx). */
  app.get("/api/propostas/template.csv", async (_req, reply) => {
    reply
      .header("Content-Type", "text/csv; charset=utf-8")
      .header("Content-Disposition", 'attachment; filename="template-propostas.csv"')
      .send("﻿" + buildTemplatePropostasCsv()); // BOM para o Excel abrir acentos
  });

  /**
   * LOTE COMPOSTO (US-07): recebe o arquivo de TOMADORES (CSV/JSON, mesmo
   * formato do módulo Tomadores — parser e validações reusados) e o retém no
   * servidor por sessão. A criação da requisição-lote referencia o upload por
   * id — a fonte da verdade é o servidor, nunca linhas reenviadas pelo front.
   * Sob aprovação não há "pular inválidas": arquivo com erro volta inteiro.
   */
  app.post("/api/propostas/tomadores/parse", async (req, reply) => {
    const session = exigirSessao(req, reply);
    if (!session) return;

    if (!aprovacaoAtivaFn("proposta.criar_lote")) {
      return reply.code(409).send({
        error:
          "O lote composto (tomadores + propostas) só existe com a aprovação de " +
          "propostas em lote ativa. No fluxo direto, cadastre os tomadores no módulo Tomadores.",
      });
    }

    let upload: { filename: string; content: string; control: BatchControl };
    try {
      upload = await readUploadTomadores(req);
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }

    let clientes: Cliente[];
    try {
      clientes = parseByFilename(upload.filename, upload.content);
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message, stage: "parse" });
    }

    const rows = validateRows(clientes);
    const invalidas = rows.filter((r) => r.errors.length > 0);
    if (invalidas.length > 0) {
      return reply.code(422).send({
        error:
          "O arquivo de tomadores tem linhas inválidas. Sob aprovação, o lote só vira " +
          "requisição com todas as linhas válidas — corrija e envie novamente.",
        total: rows.length,
        invalidas: invalidas.length,
        rows: invalidas.map((r) => ({
          index: r.index,
          nome: r.nome,
          documento: r.documento,
          errors: r.errors,
        })),
      });
    }

    // Monta o request Sinqia de cada linha JÁ AQUI (falha de montagem volta
    // agora, não na criação) — o retido guarda o request pronto (RN08).
    let tomadores: TomadorRetido[];
    try {
      tomadores = rows.map((r) => ({
        index: r.index,
        nome: r.nome,
        documento: r.documento,
        tipo: r.tipo,
        request: buildRequest(r.cliente, upload.control) as unknown as Record<string, unknown>,
      }));
    } catch (e) {
      return reply.code(422).send({
        error: `Falha ao montar o request de uma das linhas: ${(e as Error).message}`,
      });
    }

    const uploadId = reterTomadoresUpload({
      sessionId: session.id,
      filename: upload.filename,
      control: upload.control,
      tomadores,
      criadoEm: Date.now(),
    });

    return reply.send({
      env: env.SINQIA_ENV,
      uploadId,
      arquivo: upload.filename,
      total: tomadores.length,
      tomadores: tomadores.map((t) => ({
        index: t.index,
        nome: t.nome,
        documento: t.documento,
        tipo: t.tipo,
      })),
    });
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
      calcProspFn,
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

    /*
     * Esteira de Aprovação (SoD, US-07): flag do lote de propostas ativa → o
     * lote VÁLIDO (linhas OK do cálculo, validações RN existentes já
     * passaram) vira requisição-LOTE pendente, possivelmente COMPOSTA
     * (tomadores do arquivo opcional + propostas vinculadas por CPF).
     * ZERO Sinqia neste caminho; a execução — cálculo oficial + conferência
     * automática + criação — acontece na sessão do aprovador, tomadores
     * primeiro (encadeamento persistido em `depende_de_item_id`).
     */
    if (aprovacaoAtivaFn("proposta.criar_lote")) {
      const { tomadoresUploadId, arquivo } = parsed.data;

      let tomadoresRetido: TomadoresUploadRetido | undefined;
      if (tomadoresUploadId) {
        tomadoresRetido = tomadoresUploads.get(tomadoresUploadId);
        if (!tomadoresRetido) {
          return reply.code(410).send({
            error:
              "O arquivo de tomadores não está mais em memória — reenvie-o antes de requisitar.",
          });
        }
        if (tomadoresRetido.sessionId !== session.id) {
          return reply.code(403).send({ error: "Este arquivo pertence a outra sessão." });
        }
      }

      // Vínculo por CPF: proposta cujo documento está no arquivo de
      // tomadores depende do cadastro dele (RN03).
      const ordemTomadorPorDoc = new Map<string, number>();
      const docsPropostas = new Set(items.map((i) => normalizarDocumento(i.cpf)));

      // Tomador sem NENHUMA proposta vinculada não pertence ao composto —
      // provável engano de arquivo; volta inteiro (mesma régua da decisão 7).
      const semVinculo = (tomadoresRetido?.tomadores ?? []).filter(
        (t) => !docsPropostas.has(normalizarDocumento(t.documento)),
      );
      if (semVinculo.length > 0) {
        return reply.code(422).send({
          error:
            `${semVinculo.length} tomador(es) do arquivo não têm proposta correspondente na ` +
            "planilha (vínculo por CPF) — remova-os do arquivo ou confira os CPFs.",
          tomadoresSemVinculo: semVinculo.map((t) => ({
            index: t.index,
            nome: t.nome,
            documento: t.documento,
          })),
        });
      }

      // RN05 (herdada da US-04): proposta SEM vínculo neste lote cujo tomador
      // está pendente em OUTRA requisição aguarda a decisão de lá.
      const docsNoArquivo = new Set(
        (tomadoresRetido?.tomadores ?? []).map((t) => normalizarDocumento(t.documento)),
      );
      const bloqueadas: Array<{ linha: number; requisicaoId: string }> = [];
      for (const item of items) {
        const docItem = normalizarDocumento(item.cpf);
        if (docsNoArquivo.has(docItem)) continue;
        const individual = sodServico().pendentePorDocumento("tomador.cadastrar", docItem);
        const emLote = individual
          ? null
          : sodServico().itemPendentePorDocumento("tomador.cadastrar", docItem);
        if (individual || emLote) {
          bloqueadas.push({
            linha: item.linha,
            requisicaoId: individual ? individual.id : emLote!.requisicaoId,
          });
        }
      }
      if (bloqueadas.length > 0) {
        return reply.code(409).send({
          error:
            `${bloqueadas.length} linha(s) têm tomador com cadastro pendente de aprovação em ` +
            "outra requisição — aguarde a decisão (ou inclua o tomador no arquivo deste lote).",
          code: "TOMADOR_PENDENTE",
          linhas: bloqueadas,
        });
      }

      // Itens: tomadores PRIMEIRO (ordem de execução do encadeamento).
      const itensLote: Array<{
        ordem: number;
        tipo: TipoAcaoSod;
        payload: Record<string, unknown>;
        documento: string | null;
        dependeDeOrdem?: number;
      }> = [];
      let ordem = 0;
      for (const t of tomadoresRetido?.tomadores ?? []) {
        ordem++;
        const payloadTomador: ItemLoteSodPayload = {
          ordem,
          resumo: { nome: t.nome, documento: t.documento, tipo: t.tipo as "PF" | "PJ" | "?" },
          control: tomadoresRetido!.control as unknown as Record<string, unknown>,
          request: t.request,
        };
        ordemTomadorPorDoc.set(normalizarDocumento(t.documento), ordem);
        itensLote.push({
          ordem,
          tipo: "tomador.cadastrar",
          payload: payloadTomador as unknown as Record<string, unknown>,
          documento: normalizarDocumento(t.documento) || null,
        });
      }
      for (const item of items) {
        ordem++;
        const r = porLinha.get(item.linha)!;
        const calcRequest = r.request;
        const payloadProposta: PropostaLoteItemSodPayload = {
          ordem,
          resumo: { nome: item.nome, documento: item.cpf, linha: item.linha },
          proposta: {
            cpf: item.cpf,
            nome: item.nome,
            dados: {
              vlLiquido: calcRequest.vlContra,
              qtParcelas: calcRequest.qtPrest,
              dtVct1Ap: calcRequest.dtVct1Ap,
              ...(calcRequest.vlTac ? { vlTac: calcRequest.vlTac } : {}),
              ...(calcRequest.vlSeguro ? { vlSeguro: calcRequest.vlSeguro } : {}),
              ...(calcRequest.vlOutvlr ? { vlOutros: calcRequest.vlOutvlr } : {}),
            },
            params,
            forcarDuplicada: forcarDuplicadas,
          },
          calcRequest: calcRequest as unknown as Record<string, unknown>,
          // Cálculo do REQUISITANTE (fase 2), rotulado — o oficial é da execução.
          referencia: {
            rotulo: ROTULO_REFERENCIA_CALCULO,
            calculadoEm: new Date(calcJob.startedAt).toISOString(),
            resumo: {
              vlPresta: item.calculo.vlPresta,
              vlFinanciado: item.calculo.vlContra,
              vlLiquid: item.calculo.vlLiquid,
              vlIof: item.calculo.vlIof,
              vlTotal: item.calculo.vlTotal,
              txAm: item.calculo.txAm,
              txCetAm: item.calculo.txCetAm,
              qtPrest: item.calculo.qtPrest,
              dtVct1ap: item.calculo.dtVct1ap,
              dtVctult: item.calculo.dtVctult,
              vlTac: item.calculo.vlTac ?? 0,
              vlSeguro: item.calculo.vlSeguro ?? 0,
              vlOutvlr: item.calculo.vlOutvlr ?? 0,
            },
          },
          // Valores da PLANILHA, rotulados — a conferência que BLOQUEIA (RN02).
          conferencia: {
            rotulo: ROTULO_CONFERENCIA_PLANILHA,
            linha: item.linha,
            vlParcelaInicial: r.vlPrestaExcel,
            vlLiquido: r.vlLiquidoExcel,
            vlFinanciado: r.vlFinanciadoExcel,
          },
        };
        itensLote.push({
          ordem,
          tipo: "proposta.criar",
          payload: payloadProposta as unknown as Record<string, unknown>,
          documento: chaveDuplicidadeProposta(
            payloadProposta as unknown as Record<string, unknown>,
          ),
          ...(ordemTomadorPorDoc.has(normalizarDocumento(item.cpf))
            ? { dependeDeOrdem: ordemTomadorPorDoc.get(normalizarDocumento(item.cpf)) }
            : {}),
        });
      }

      const vinculos = itensLote.filter((i) => i.dependeDeOrdem !== undefined).length;
      const lotePayload: PropostaLoteSodPayload = {
        arquivo: { nome: arquivo?.trim() || "Emissões", totalItens: itensLote.length },
        ...(tomadoresRetido
          ? {
              arquivoTomadores: {
                nome: tomadoresRetido.filename,
                totalItens: tomadoresRetido.tomadores.length,
              },
              control: tomadoresRetido.control as unknown as Record<string, unknown>,
            }
          : {}),
        params: params as unknown as Record<string, unknown>,
        composto: !!tomadoresRetido,
        vinculos,
      };

      try {
        const requisicao = sodServico().criarRequisicaoLote({
          tipo: "proposta.criar_lote",
          payload: lotePayload as unknown as Record<string, unknown>,
          requisitante: session.username,
          itens: itensLote,
        });
        // Consumidos: os insumos agora vivem na requisição.
        if (tomadoresUploadId) tomadoresUploads.delete(tomadoresUploadId);
        app.log.info(
          `Lote de propostas virou requisição SoD ${requisicao.id} ` +
            `(${itensLote.length} item(ns), ${vinculos} vínculo(s)` +
            `${tomadoresRetido ? ", COMPOSTO" : ""}) — ambiente ${env.SINQIA_ENV.toUpperCase()}`,
        );
        return reply.code(201).send({
          env: env.SINQIA_ENV,
          aprovacao: true,
          requisicao: {
            id: requisicao.id,
            estado: requisicao.estado,
            criadoEm: requisicao.criadoEm,
            totalItens: itensLote.length,
            composto: !!tomadoresRetido,
            vinculos,
          },
        });
      } catch (e) {
        // Duplicidade RN06 → 409 com as três dimensões estruturadas.
        return responderErroSod(reply, e);
      }
    }

    // Corte SoD (US-05, RN01): barreira centralizada IMEDIATAMENTE antes da
    // execução direta — segura flag ativada entre as duas leituras.
    if (guardarExecucaoDireta("proposta.criar_lote", reply, aprovacaoAtivaFn)) return;

    const selecionados = piloto ? items.slice(0, 1) : items;
    const jobId = startCriacaoJob({
      items: selecionados,
      params,
      forcarDuplicadas,
      token: session.token,
      sessionId: session.id,
      username: session.username,
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

    const busca = await buscarClientePorCpfFn(session.token, cpf);
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
    const { httpStatus, calculo, analysis, rawBody } = await calcProspFn(session.token, request);
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
      // `dados` e `request` também retidos: com a aprovação ativa (US-04),
      // eles viram os INSUMOS persistidos da requisição — a execução recalcula.
      dados,
      request,
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

    /*
     * Esteira de Aprovação (SoD, US-04): toggle do tipo ativo → a proposta
     * VÁLIDA (cálculo retido = validações RN03 já passaram) vira requisição
     * pendente pela camada da US-01, com os INSUMOS persistidos e os valores
     * do cálculo do requisitante anexados como REFERÊNCIA rotulada (RN06).
     * NENHUMA criação na Sinqia neste caminho; o cálculo oficial e a criação
     * acontecem na sessão do aprovador (executor da US-04). Toggle inativo →
     * fluxo direto intacto.
     */
    if (aprovacaoAtivaFn("proposta.criar")) {
      // RN05: tomador com cadastro ainda em aprovação → aguarde a decisão dele.
      const tomadorPendente = sodServico().pendentePorDocumento(
        "tomador.cadastrar",
        retido.cpf,
      );
      if (tomadorPendente) {
        return reply.code(409).send({
          error:
            "O cadastro deste tomador está em uma requisição pendente de aprovação — " +
            "aguarde a aprovação do tomador antes de requisitar a proposta.",
          code: "TOMADOR_PENDENTE",
          requisicaoTomador: {
            id: tomadorPendente.id,
            estado: tomadorPendente.estado,
            requisitante: tomadorPendente.requisitante,
            criadoEm: tomadorPendente.criadoEm,
          },
        });
      }

      // RN05: tomador existente e apto no ambiente ativo (mesma checagem que o
      // fluxo direto faz na criação — aqui antecipada para a requisição).
      const busca = await buscarClientePorCpfFn(session.token, retido.cpf);
      if (busca.httpStatus === 401) return responder401(reply, session.id);
      if (!busca.encontrado || busca.nrClient === null) {
        return reply.code(422).send({
          error:
            "Cliente não cadastrado neste ambiente — cadastre o tomador antes (módulo Tomadores).",
          code: "TOMADOR_INEXISTENTE",
          httpStatus: busca.httpStatus,
        });
      }

      const payloadSod: PropostaSodPayload = {
        proposta: {
          cpf: retido.cpf,
          nome: busca.dsNome || retido.nome,
          dados: retido.dados,
          params,
          forcarDuplicada,
        },
        calcRequest: retido.request as unknown as Record<string, unknown>,
        referencia: {
          rotulo: ROTULO_REFERENCIA_CALCULO,
          calculadoEm: new Date(retido.criadoEm).toISOString(),
          resumo: {
            vlPresta: retido.calculo.vlPresta,
            vlFinanciado: retido.calculo.vlContra,
            vlLiquid: retido.calculo.vlLiquid,
            vlIof: retido.calculo.vlIof,
            vlTotal: retido.calculo.vlTotal,
            txAm: retido.calculo.txAm,
            txCetAm: retido.calculo.txCetAm,
            qtPrest: retido.calculo.qtPrest,
            dtVct1ap: retido.calculo.dtVct1ap,
            dtVctult: retido.calculo.dtVctult,
            vlTac: retido.calculo.vlTac ?? 0,
            vlSeguro: retido.calculo.vlSeguro ?? 0,
            vlOutvlr: retido.calculo.vlOutvlr ?? 0,
          },
        },
      };

      try {
        const requisicao = sodServico().criarRequisicao({
          tipo: "proposta.criar",
          payload: payloadSod as unknown as Record<string, unknown>,
          requisitante: session.username,
        });
        // Requisição criada: os insumos agora vivem nela — descarta o retido
        // para impedir reenvio acidental do MESMO calcId.
        calculosIndividuais.delete(calcId);
        app.log.info(
          `Proposta individual virou requisição SoD ${requisicao.id} ` +
            `(CPF final ${retido.cpf.slice(-4)}) — ambiente ${env.SINQIA_ENV.toUpperCase()}`,
        );
        return reply.code(201).send({
          env: env.SINQIA_ENV,
          aprovacao: true,
          requisicao: {
            id: requisicao.id,
            estado: requisicao.estado,
            criadoEm: requisicao.criadoEm,
          },
        });
      } catch (e) {
        // Duplicidade pendente (RN04) → 409 com a requisição existente.
        return responderErroSod(reply, e);
      }
    }

    // Corte SoD (US-05, RN01): barreira centralizada IMEDIATAMENTE antes da
    // execução direta — mesma mecânica do /api/cadastrar (ver sod/corte.ts).
    if (guardarExecucaoDireta("proposta.criar", reply, aprovacaoAtivaFn)) return;

    try {
      const result = await criarUmaFn(
        session.token,
        { linha: 1, nome: retido.nome, cpf: retido.cpf, calculo: retido.calculo },
        params,
        forcarDuplicada,
        { usuario: session.username, origem: "individual" },
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

    // Cache curto por ambiente+convênio: a varredura + históricos custam
    // dezenas de chamadas; o botão de recarregar passa forcar=1.
    const chaveCache = `${env.SINQIA_ENV}|${convenio ?? "todos"}`;
    if (!q.data.forcar) {
      const emCache = cacheVisaoGeral.get(chaveCache);
      if (emCache && Date.now() - emCache.ts < CACHE_VISAO_MS) {
        return reply.send(emCache.payload);
      }
    }

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
    const MAX_CONSULTAS = 30;
    const TAMANHO_PAGINA = 200;
    let consultasUsadas = 0;
    let parcial = false;

    /** Retrato mínimo de cada proposta varrida — insumo de valor/funil/SLA. */
    interface Varrida {
      nrProsp: number;
      nrStatus: number | null;
      dsStatus: string;
      vlSolic: number | null;
      dtSolic: number | null;
      dtEntrad: number | null;
      hrEntrad: number | null;
      cdConv: number | null;
      nmConv: string;
      cdProd: number | null;
    }
    const varridas: Varrida[] = [];

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
          varridas.push({
            nrProsp: p.nrProsp,
            nrStatus: p.nrStatus,
            dsStatus: p.dsStatus,
            vlSolic: p.vlSolic,
            dtSolic: p.dtSolic,
            dtEntrad: p.dtEntrad,
            hrEntrad: p.hrEntrad,
            cdConv: p.cdConv,
            nmConv: p.nmConv,
            cdProd: p.cdProd,
          });
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

    /* ---------- Bloco executivo: VALOR (efetivadas = etapa concluída) ---------- */
    const efetivadas = varridas.filter(
      (s) => categoriaDaEtapa(s.nrStatus, s.dsStatus) === "concluida",
    );
    const mesReferencia = (s: Varrida) => mesDe(s.dtSolic ?? s.dtEntrad);
    const agora = new Date();
    const mesAtual = `${agora.getFullYear()}${String(agora.getMonth() + 1).padStart(2, "0")}`;
    const dataAnterior = new Date(agora.getFullYear(), agora.getMonth() - 1, 1);
    const mesAnterior = `${dataAnterior.getFullYear()}${String(dataAnterior.getMonth() + 1).padStart(2, "0")}`;

    const somaDoMes = (mes: string) =>
      efetivadas
        .filter((s) => mesReferencia(s) === mes)
        .reduce((acc, s) => acc + (s.vlSolic ?? 0), 0);

    const tickets = efetivadas
      .map((s) => s.vlSolic ?? 0)
      .filter((v) => v > 0)
      .sort((a, b) => a - b);

    // Barras mensais (últimos 6 meses com dado), empilhadas por convênio.
    const porMesMapa = new Map<string, Map<string, { cdConv: number | null; nmConv: string; total: number }>>();
    for (const s of efetivadas) {
      const mes = mesReferencia(s);
      if (!mes) continue;
      if (!porMesMapa.has(mes)) porMesMapa.set(mes, new Map());
      const chave = String(s.cdConv ?? "sem");
      const grupo = porMesMapa.get(mes)!;
      if (!grupo.has(chave)) grupo.set(chave, { cdConv: s.cdConv, nmConv: s.nmConv, total: 0 });
      grupo.get(chave)!.total += s.vlSolic ?? 0;
    }
    const porMes = [...porMesMapa.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .slice(-6)
      .map(([mes, grupos]) => ({ mes, series: [...grupos.values()] }));

    // Líquido/financiado exatos: só do que a FERRAMENTA criou (base local).
    let liquido: { somaLiquid: number; somaFinan: number; encontrados: number } | null = null;
    try {
      liquido = somarValoresRegistrados(efetivadas.map((s) => s.nrProsp));
    } catch {
      liquido = null;
    }

    const valor = {
      moeda: "vlSolic (valor solicitado)",
      originadoMesAtual: somaDoMes(mesAtual),
      originadoMesAnterior: somaDoMes(mesAnterior),
      ticketMedio:
        tickets.length > 0 ? tickets.reduce((a, b) => a + b, 0) / tickets.length : null,
      ticketMediana: mediana(tickets),
      contratos: efetivadas.length,
      liquidoLiberado: liquido && liquido.encontrados > 0 ? liquido.somaLiquid : null,
      liquidoCobertura: liquido ? liquido.encontrados : 0,
      porMes,
    };

    /* ---------- Bloco executivo: FUNIL ---------- */
    // Tomadores = PERSONA tomadora, não a base inteira: pessoas físicas
    // (regra automática) + PJs promovidas − PFs despromovidas (exceções na
    // base local). Com filtro de convênio ativo o degrau fica null (o número
    // é global; comparar com um recorte distorceria o funil).
    let tomadores: number | null = null;
    if (convenio === undefined) {
      try {
        const r = await listarClientes(session.token, { page: 0, size: 1, tipoPessoa: "F" });
        if (r.httpStatus === 401) return responder401(reply, session.id);
        if (r.httpStatus >= 200 && r.httpStatus < 300 && r.page.totalElements !== null) {
          const ajuste = ajustePersonasTomadores();
          tomadores = Math.max(
            0,
            r.page.totalElements + ajuste.pjTomadoras - ajuste.pfNaoTomadoras,
          );
        }
      } catch {
        tomadores = null;
      }
    }
    const funil = {
      tomadores,
      propostas: varridas.length,
      aprovadas: varridas.filter((s) => aprovadaNoFunil(s.nrStatus, s.dsStatus)).length,
      efetivadas: efetivadas.length,
    };

    /* ---------- Bloco executivo: VELOCIDADE (histórico das efetivadas) ---------- */
    const CAP_HISTORICOS = 40;
    const amostra = efetivadas.slice(0, CAP_HISTORICOS);
    const ciclosDias: number[] = [];
    const etapaSomas = new Map<string, { somaHoras: number; n: number }>();
    for (const s of amostra) {
      const h = await consultarHistoricoProposta(session.token, s.nrProsp);
      if (h.httpStatus === 401) return responder401(reply, session.id);
      const eventos = h.historicos
        .map((x) => ({ ...x, t: parseDtIn(x.dtIn) }))
        .filter((x): x is typeof x & { t: number } => x.t !== null)
        .sort((a, b) => a.nrSeq - b.nrSeq);
      if (eventos.length >= 2) {
        ciclosDias.push((eventos[eventos.length - 1].t - eventos[0].t) / 86_400_000);
        for (let i = 0; i < eventos.length - 1; i++) {
          const duracaoH = (eventos[i + 1].t - eventos[i].t) / 3_600_000;
          if (duracaoH < 0) continue;
          const chave = eventos[i].dsStatus || "—";
          const acc = etapaSomas.get(chave) ?? { somaHoras: 0, n: 0 };
          acc.somaHoras += duracaoH;
          acc.n++;
          etapaSomas.set(chave, acc);
        }
      }
    }
    // Throughput: efetivadas por semana (entrada na etapa final), últimas 8.
    const porSemana = new Map<string, number>();
    for (const s of efetivadas) {
      const chave = inicioSemana(s.dtEntrad);
      if (!chave) continue;
      porSemana.set(chave, (porSemana.get(chave) ?? 0) + 1);
    }
    const velocidade = {
      base: amostra.length,
      capAtingido: efetivadas.length > amostra.length,
      cicloMedioDias:
        ciclosDias.length > 0
          ? ciclosDias.reduce((a, b) => a + b, 0) / ciclosDias.length
          : null,
      cicloMedianaDias: mediana([...ciclosDias].sort((a, b) => a - b)),
      tempoPorEtapa: [...etapaSomas.entries()]
        .map(([dsStatus, acc]) => ({ dsStatus, mediaHoras: acc.somaHoras / acc.n, n: acc.n }))
        .sort((a, b) => b.mediaHoras - a.mediaHoras)
        .slice(0, 8),
      throughputSemanas: [...porSemana.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .slice(-8)
        .map(([semana, total]) => ({ semana, total })),
    };

    const payload = {
      env: env.SINQIA_ENV,
      convenio: convenio ?? null,
      slaHoras: SLA_HORAS,
      parcial,
      totalAtrasadas,
      filas: filasAgregadas,
      valor,
      funil,
      velocidade,
      geradoEm: new Date().toISOString(),
    };
    cacheVisaoGeral.set(chaveCache, { ts: Date.now(), payload });
    return reply.send(payload);
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

    // Revalida o destino no workflow — o front não é fonte de verdade. A
    // MESMA validação vale para o fluxo direto e para o desvio de requisição
    // (decisão 7 do CONTEXTO: o aprovador confere mérito, não formato).
    const permitidas = await consultarStatusTransfFn(session.token, b.nrWf, b.nrStatusAtual);
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

    /*
     * Esteira de Aprovação (US-08): com a flag ativa, a movimentação vira
     * requisição `pendente` com o payload da RN02 — identificação completa
     * (proposta, origem, destino, observação) + o request EXATO do
     * transfStatus. ZERO movimentação na Sinqia neste caminho; a execução
     * acontece na sessão do aprovador (executor da US-08). O bloqueio de UMA
     * requisição ativa por proposta é verificado no domínio E garantido no
     * banco (índice parcial — corrida de criação simultânea coberta).
     */
    if (aprovacaoAtivaFn("proposta.movimentar")) {
      const payloadSod = {
        movimentacao: {
          nrProsp: b.nrProsp,
          nmCliente: b.nmCliente,
          nrCpf: b.nrCpf,
          nrWf: b.nrWf,
          origem: { nrStatus: b.nrStatusAtual, dsStatus: b.dsStatusAtual ?? "" },
          destino: { proxStatus: destino.proxStatus, dsStatus: destino.dsStatus },
          dsObserv: b.dsObserv.trim(),
          cdProd: b.cdProd,
          nrContra: b.nrContra ?? null,
        },
        request: {
          nrStatus: b.proxStatus,
          dsObserv: b.dsObserv.trim(),
          nrCpf: b.nrCpf,
          nrProsp: b.nrProsp,
          nmCliente: b.nmCliente,
          nrWf: b.nrWf,
          cdProd: b.cdProd,
          nrContra: b.nrContra ?? 0,
        },
      };
      try {
        const requisicao = sodServico().criarRequisicao({
          tipo: "proposta.movimentar",
          payload: payloadSod as unknown as Record<string, unknown>,
          requisitante: session.username,
        });
        return reply.code(201).send({
          env: env.SINQIA_ENV,
          aprovacao: true,
          requisicao: {
            id: requisicao.id,
            estado: requisicao.estado,
            criadoEm: requisicao.criadoEm,
          },
          destino: { proxStatus: destino.proxStatus, dsStatus: destino.dsStatus },
        });
      } catch (e) {
        // Bloqueio por proposta (RN03) → 409 com a requisição existente.
        return responderErroSod(reply, e);
      }
    }

    // Corte SoD (US-05, RN01): barreira centralizada IMEDIATAMENTE antes da
    // execução direta — segura flag ativada entre as duas leituras.
    if (guardarExecucaoDireta("proposta.movimentar", reply, aprovacaoAtivaFn)) return;

    const res = await transferirStatusFn(session.token, {
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
    // Trilha de eventos da base local (logs; base das futuras aprovações).
    try {
      registrarEvento("transferencia_status", session.username, {
        nrProsp: b.nrProsp,
        de: b.nrStatusAtual,
        para: b.proxStatus,
        ok: res.ok,
        dsObserv: b.dsObserv,
      });
    } catch {
      /* apoio, nunca derruba o fluxo */
    }

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

  /**
   * Transferência EM LOTE — move várias propostas da MESMA fila para o mesmo
   * destino (uma chamada transfStatus por proposta, via job com progresso).
   * O destino é revalidado uma única vez contra o workflow.
   */
  app.post("/api/propostas-transferir-lote", async (req, reply) => {
    const session = exigirSessao(req, reply);
    if (!session) return;

    const parsed = transferirLoteBodySchema.safeParse(req.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return reply.code(400).send({
        error: `Requisição inválida${issue ? `: ${issue.path.join(".")} — ${issue.message}` : "."}`,
      });
    }
    const b = parsed.data;

    const permitidas = await consultarStatusTransf(session.token, b.nrWf, b.nrStatusAtual);
    if (permitidas.httpStatus === 401) return responder401(reply, session.id);
    const destino = permitidas.transicoes.find((t) => t.proxStatus === b.proxStatus);
    if (!destino) {
      return reply.code(422).send({
        error:
          `O workflow não permite mover do status ${b.nrStatusAtual} para ${b.proxStatus}. ` +
          "Recarregue a fila — as propostas podem ter mudado de etapa.",
      });
    }
    if (destino.exigeObservacao && !b.dsObserv.trim()) {
      return reply.code(422).send({
        error: `A transição para "${destino.dsStatus}" exige observação.`,
      });
    }

    const jobId = startTransferenciaJob({
      items: b.itens.map((i) => ({ ...i, nrContra: i.nrContra ?? 0 })),
      nrWf: b.nrWf,
      nrStatusAtual: b.nrStatusAtual,
      proxStatus: b.proxStatus,
      dsObserv: b.dsObserv.trim(),
      token: session.token,
      sessionId: session.id,
      username: session.username,
    });

    app.log.info(
      `Transferência em LOTE iniciada: ${b.itens.length} proposta(s) ` +
        `${b.nrStatusAtual}→${b.proxStatus} — ambiente ${env.SINQIA_ENV.toUpperCase()}`,
    );
    return reply.send({
      jobId,
      total: b.itens.length,
      destino: { proxStatus: destino.proxStatus, dsStatus: destino.dsStatus },
      env: env.SINQIA_ENV,
    });
  });

  // SSE de progresso da transferência em lote.
  app.get("/api/propostas-transferir-lote/stream/:jobId", async (req, reply) => {
    const session = exigirSessao(req, reply);
    if (!session) return;

    const { jobId } = req.params as { jobId: string };
    const job = getTransferenciaJob(jobId);
    if (!job) return reply.code(404).send({ error: "Job não encontrado." });
    if (job.sessionId !== session.id) {
      return reply.code(403).send({ error: "Esta transferência pertence a outra sessão." });
    }
    streamJob(req, reply, job, getTransferenciaEmitter(jobId));
  });

  /* ------------------- Personas (base local) ------------------- */

  /** Exceções de persona do ambiente ativo (a regra PF=tomador é implícita). */
  app.get("/api/personas", async (req, reply) => {
    const session = exigirSessao(req, reply);
    if (!session) return;
    try {
      return reply.send({ env: env.SINQIA_ENV, overrides: listarPersonas() });
    } catch (e) {
      return reply.code(500).send({ error: (e as Error).message });
    }
  });

  /** Define a persona de um cliente (grava só o desvio da regra). */
  app.post("/api/personas", async (req, reply) => {
    const session = exigirSessao(req, reply);
    if (!session) return;

    const parsed = personaBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: parsed.error.issues[0]?.message ?? "Requisição inválida." });
    }
    const { documento, tpPessoa, tomador } = parsed.data;
    try {
      definirPersona(documento, tpPessoa, tomador, session.username);
      registrarEvento("persona_definida", session.username, { documento: `...${documento.slice(-4)}`, tpPessoa, tomador });
      return reply.send({ env: env.SINQIA_ENV, ok: true });
    } catch (e) {
      return reply.code(500).send({ error: (e as Error).message });
    }
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
  /** 1 = ignora o cache (botão de recarregar do dashboard). */
  forcar: z.coerce.boolean().optional(),
});

/** Cache curto da visão geral — a varredura + históricos custam dezenas de chamadas. */
const cacheVisaoGeral = new Map<string, { ts: number; payload: unknown }>();
const CACHE_VISAO_MS = 3 * 60_000;

/** "AAAAMMDD" (número) → "AAAAMM"; null quando não dá para saber. */
function mesDe(data: number | null): string | null {
  if (!data) return null;
  const s = String(data);
  return s.length === 8 ? s.slice(0, 6) : null;
}

/** Mediana de um array JÁ ORDENADO; null quando vazio. */
function mediana(ordenado: number[]): number | null {
  if (ordenado.length === 0) return null;
  const meio = Math.floor(ordenado.length / 2);
  return ordenado.length % 2 === 1
    ? ordenado[meio]
    : (ordenado[meio - 1] + ordenado[meio]) / 2;
}

/** "dd/mm/aaaa hh:mm" (dtIn do histórico) → epoch ms; null se não parsear. */
function parseDtIn(dtIn: string): number | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})/.exec(dtIn.trim());
  if (!m) return null;
  const d = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]), Number(m[4]), Number(m[5]));
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

/** Segunda-feira da semana de uma data AAAAMMDD → "AAAA-MM-DD" (chave ordenável). */
function inicioSemana(data: number | null): string | null {
  if (!data) return null;
  const s = String(data);
  if (s.length !== 8) return null;
  const d = new Date(Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1, Number(s.slice(6, 8)));
  if (Number.isNaN(d.getTime())) return null;
  const diaSemana = (d.getDay() + 6) % 7; // 0 = segunda
  d.setDate(d.getDate() - diaSemana);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

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
  /** Dados da operação como digitados (US-04: insumos da requisição). */
  dados: {
    vlLiquido: number;
    qtParcelas: number;
    dtVct1Ap: number;
    vlTac?: number;
    vlSeguro?: number;
    vlOutros?: number;
  };
  /** Request EXATO enviado ao calcProsp (US-04: a execução recalcula com ele). */
  request: CalcProspRequest;
  calculo: CalcProspCalculo;
  criadoEm: number;
}

const calculosIndividuais = new Map<string, CalculoIndividualRetido>();
const MAX_CALCULOS_INDIVIDUAIS = 20;

/* -------- Arquivo de TOMADORES retido (lote composto — US-07) -------- */

/** Linha VÁLIDA do arquivo de tomadores, com o request Sinqia já montado. */
interface TomadorRetido {
  index: number;
  nome: string;
  documento: string;
  tipo: string;
  request: Record<string, unknown>;
}

interface TomadoresUploadRetido {
  sessionId: string;
  filename: string;
  control: BatchControl;
  tomadores: TomadorRetido[];
  criadoEm: number;
}

const tomadoresUploads = new Map<string, TomadoresUploadRetido>();
const MAX_TOMADORES_UPLOADS = 10;

function reterTomadoresUpload(entry: TomadoresUploadRetido): string {
  while (tomadoresUploads.size >= MAX_TOMADORES_UPLOADS) {
    const maisAntigo = [...tomadoresUploads.entries()].sort(
      (a, b) => a[1].criadoEm - b[1].criadoEm,
    )[0];
    if (!maisAntigo) break;
    tomadoresUploads.delete(maisAntigo[0]);
  }
  const id = randomUUID();
  tomadoresUploads.set(id, entry);
  return id;
}

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
  /**
   * US-07 (sob aprovação): id do arquivo de TOMADORES retido no servidor —
   * presença = lote COMPOSTO (tomadores + propostas vinculadas por CPF).
   */
  tomadoresUploadId: z.string().uuid().optional(),
  /** US-07 (sob aprovação): nome do arquivo de propostas, para exibição. */
  arquivo: z.string().max(200).optional(),
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
  /** Nome da etapa de ORIGEM (exibição) — vai no payload da requisição US-08. */
  dsStatusAtual: z.string().max(120).optional(),
  proxStatus: z.number().int(),
  dsObserv: z.string().max(500).default(""),
  nrCpf: z.string().min(11).max(14),
  nmCliente: z.string().max(120).default(""),
  cdProd: z.number().int(),
  nrContra: z.number().int().nullable().optional(),
});

/** Body do POST /api/propostas-transferir-lote. */
const transferirLoteBodySchema = z.object({
  nrWf: z.number().int(),
  nrStatusAtual: z.number().int(),
  proxStatus: z.number().int(),
  dsObserv: z.string().max(500).default(""),
  itens: z
    .array(
      z.object({
        nrProsp: z.number().int().positive(),
        nrCpf: z.string().min(11).max(14),
        nmCliente: z.string().max(120).default(""),
        cdProd: z.number().int(),
        nrContra: z.number().int().nullable().optional(),
      }),
    )
    .min(1, "Selecione ao menos uma proposta.")
    .max(400, "No máximo 400 propostas por lote."),
});

/** Body do POST /api/personas. */
const personaBodySchema = z.object({
  documento: z.string().regex(/^\d{11}(\d{3})?$/, "Documento deve ter 11 ou 14 dígitos."),
  tpPessoa: z.enum(["F", "J"]),
  tomador: z.boolean(),
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
