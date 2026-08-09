import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  batchControlSchema,
  cdSituacaoSchema,
  normalizarDocumento,
  normalizeCamposObrigatorios,
  temDuplicidades,
  TIPO_ITEM_DO_LOTE,
  type BatchControl,
  type Cliente,
  type ItemLoteSodPayload,
  type LoteSodPayload,
} from "@cadastro-lote/shared";
import { env, isProd } from "./env.js";
import { buildTemplateCsv } from "./template.js";
import { parseByFilename, parseFlatRow, validateRows, buildRequest } from "./parse-input.js";
import {
  cadastrarCliente,
  consultarCamposObrigatorios,
  consultarDadosProposta,
  listarPropostasPorCpf,
  listarTodosClientes,
  login,
  SinqiaAuthError,
} from "./sinqia-client.js";
import { getEmitter, getJob, startJob } from "./batch.js";
import { getOnboarding, salvarOnboarding } from "./db.js";
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
import { aprovacaoAtiva, type AprovacaoAtivaFn } from "./sod/flags.js";
import { guardarExecucaoDireta } from "./sod/corte.js";
import { responderErroSod, sodServicoPadrao } from "./sod/rotas.js";
import type { SodServico } from "./sod/dominio.js";

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

/**
 * Dependências injetáveis nos testes — o runtime usa os padrões. Existem para
 * os cenários da Esteira de Aprovação provarem "zero chamadas à Sinqia" (spy
 * em cadastrarCliente) e usarem banco/toggle temporários, offline.
 */
export interface RegisterRoutesDeps {
  cadastrarClienteFn?: typeof cadastrarCliente;
  /** Preguiçoso: só abre o banco quando o toggle está ativo. */
  sodServico?: () => SodServico;
  aprovacaoAtivaFn?: AprovacaoAtivaFn;
}

export async function registerRoutes(app: FastifyInstance, deps: RegisterRoutesDeps = {}) {
  const cadastrarClienteFn = deps.cadastrarClienteFn ?? cadastrarCliente;
  const sodServico = deps.sodServico ?? sodServicoPadrao;
  const aprovacaoAtivaFn = deps.aprovacaoAtivaFn ?? aprovacaoAtiva;
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
    // Toggles da Esteira de Aprovação (SoD) — a UI adapta CTAs e mensagens.
    aprovacao: {
      cadastroTomadorIndividual: aprovacaoAtivaFn("tomador.cadastrar"),
      criacaoPropostaIndividual: aprovacaoAtivaFn("proposta.criar"),
      cadastroTomadorLote: aprovacaoAtivaFn("tomador.cadastrar_lote"),
      criacaoPropostaLote: aprovacaoAtivaFn("proposta.criar_lote"),
      movimentacaoProposta: aprovacaoAtivaFn("proposta.movimentar"),
      movimentacaoPropostaMassa: aprovacaoAtivaFn("proposta.movimentar_massa"),
    },
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
  /* Onboarding (estado por usuário, na base local)                    */
  /* ---------------------------------------------------------------- */

  app.get("/api/onboarding", async (req, reply) => {
    const session = exigirSessao(req, reply);
    if (!session) return;
    try {
      return reply.send({ env: env.SINQIA_ENV, ...getOnboarding(session.username) });
    } catch (e) {
      return reply.code(500).send({ error: (e as Error).message });
    }
  });

  app.put("/api/onboarding", async (req, reply) => {
    const session = exigirSessao(req, reply);
    if (!session) return;
    const parsed = onboardingPatchSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: parsed.error.issues[0]?.message ?? "Requisição inválida." });
    }
    try {
      const estado = salvarOnboarding(session.username, parsed.data);
      return reply.send({ env: env.SINQIA_ENV, ...estado });
    } catch (e) {
      return reply.code(500).send({ error: (e as Error).message });
    }
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

    /*
     * Esteira de Aprovação (SoD, US-06): com a flag do lote ativa, a
     * conferência aponta a duplicidade TRIDIMENSIONAL (RN06) ANTES do envio —
     * intra-arquivo, pendentes individuais e itens pendentes de outros lotes.
     * Consulta pura, zero Sinqia, zero efeito colateral.
     */
    const aprovacaoLote = aprovacaoAtivaFn("tomador.cadastrar_lote");
    const duplicidades = aprovacaoLote
      ? sodServico().conferirDuplicidadesLote(
          TIPO_ITEM_DO_LOTE["tomador.cadastrar_lote"]!,
          rows.map((r) => ({
            ordem: r.index,
            documento: normalizarDocumento(r.documento ?? "") || null,
          })),
        )
      : undefined;

    return reply.send({
      env: env.SINQIA_ENV,
      total: rows.length,
      totalErros,
      valido: totalErros === 0 && (!duplicidades || !temDuplicidades(duplicidades)),
      rows: rows.map((r) => ({
        index: r.index,
        nome: r.nome,
        documento: r.documento,
        tipo: r.tipo,
        errors: r.errors,
      })),
      preview,
      ...(aprovacaoLote ? { aprovacao: true, duplicidades } : {}),
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

    /*
     * Esteira de Aprovação (SoD, US-06): flag do lote ativa → o upload VÁLIDO
     * vira requisição-LOTE pendente (um item por linha, payload integral com o
     * request Sinqia já montado). Diferença deliberada do fluxo direto: sob
     * aprovação NÃO existe "pular inválidas" — o aprovador confere mérito, não
     * formato (decisão 7 do CONTEXTO), então arquivo com erro volta inteiro.
     * Zero Sinqia neste caminho; duplicidade RN06 → 409 estruturado.
     */
    if (aprovacaoAtivaFn("tomador.cadastrar_lote")) {
      if (validas.length < rows.length) {
        return reply.code(422).send({
          error:
            "O arquivo tem linhas inválidas. Sob aprovação, o lote só vira requisição com todas as linhas válidas — corrija e envie novamente.",
          total: rows.length,
          invalidas: rows.length - validas.length,
          rows: rows
            .filter((r) => r.errors.length > 0)
            .map((r) => ({ index: r.index, nome: r.nome, documento: r.documento, errors: r.errors })),
        });
      }

      const tipoItem = TIPO_ITEM_DO_LOTE["tomador.cadastrar_lote"]!;
      let itens: Array<{
        ordem: number;
        tipo: typeof tipoItem;
        payload: Record<string, unknown>;
        documento: string | null;
      }>;
      try {
        itens = rows.map((r) => {
          const request = buildRequest(r.cliente, payload.control);
          const itemPayload: ItemLoteSodPayload = {
            ordem: r.index,
            resumo: { nome: r.nome, documento: r.documento, tipo: r.tipo },
            control: payload.control as Record<string, unknown>,
            request: request as unknown as Record<string, unknown>,
          };
          return {
            ordem: r.index,
            tipo: tipoItem,
            payload: itemPayload as unknown as Record<string, unknown>,
            documento: normalizarDocumento(r.documento ?? "") || null,
          };
        });
      } catch (e) {
        return reply.code(422).send({
          error: `Falha ao montar o request de uma das linhas: ${(e as Error).message}`,
        });
      }

      try {
        const lotePayload: LoteSodPayload = {
          control: payload.control as Record<string, unknown>,
          arquivo: { nome: payload.filename, totalItens: itens.length },
        };
        const requisicao = sodServico().criarRequisicaoLote({
          tipo: "tomador.cadastrar_lote",
          payload: lotePayload as unknown as Record<string, unknown>,
          requisitante: session.username,
          itens,
        });
        return reply.code(201).send({
          aprovacao: true,
          requisicao: {
            id: requisicao.id,
            estado: requisicao.estado,
            criadoEm: requisicao.criadoEm,
            totalItens: itens.length,
          },
          total: rows.length,
          env: env.SINQIA_ENV,
        });
      } catch (e) {
        // Duplicidade RN06 → 409 com as três dimensões estruturadas.
        return responderErroSod(reply, e);
      }
    }

    // Corte SoD (US-05, RN01): barreira centralizada IMEDIATAMENTE antes da
    // execução direta — segura flag ativada entre as duas leituras.
    if (guardarExecucaoDireta("tomador.cadastrar_lote", reply, aprovacaoAtivaFn)) return;

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
  /* Cadastro individual (1 cliente, pela tela)                        */
  /* ---------------------------------------------------------------- */

  /**
   * Campos obrigatórios do cadastro, direto da Sinqia.
   *
   * Devolve o resultado normalizado E o corpo cru: o Swagger declara como
   * resposta o modelo completo do cliente, o que não diz a semântica em runtime.
   * Com o cru na tela, descobrimos o formato real sem chutar.
   */
  app.get("/api/campos-obrigatorios", async (req, reply) => {
    const session = exigirSessao(req, reply);
    if (!session) return;

    try {
      const res = await consultarCamposObrigatorios(session.token);

      if (res.httpStatus === 401) {
        destroySession(session.id);
        reply.clearCookie(COOKIE_SID, { path: "/" });
        return reply.code(401).send({
          error: "O token da Sinqia expirou. Entre novamente.",
          code: CODE_SESSAO_EXPIRADA,
          motivo: "token",
        });
      }
      // 204 = não há campos obrigatórios parametrizados.
      if (res.httpStatus === 204) {
        return reply.send({
          httpStatus: 204,
          paths: [],
          formato: "sem-registro",
          bruto: null,
        });
      }
      if (res.httpStatus < 200 || res.httpStatus >= 300) {
        return reply.code(502).send({
          error: `A Sinqia respondeu HTTP ${res.httpStatus} ao consultar campos obrigatórios.`,
          httpStatus: res.httpStatus,
          rawBody: res.rawBody,
        });
      }

      const norm = normalizeCamposObrigatorios(res.body);
      return reply.send({
        httpStatus: res.httpStatus,
        ...norm,
        bruto: res.body,
        rawBody: res.rawBody,
      });
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message, stage: "campos-obrigatorios" });
    }
  });

  /**
   * Valida e (se não for dry-run) cadastra UM cliente.
   *
   * Recebe o mapa achatado do formulário — o mesmo formato de uma linha de CSV —
   * e passa pelo mesmo `parseFlatRow` → `clienteSchema` → `buildRequest` do
   * lote. Síncrono: um cliente não precisa de job nem SSE.
   */
  app.post("/api/cadastrar", async (req, reply) => {
    const session = exigirSessao(req, reply);
    if (!session) return;

    const parsed = cadastrarUmBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: parsed.error.issues[0]?.message ?? "Requisição inválida." });
    }
    const { campos, control, dryRun } = parsed.data;

    let cliente: Cliente;
    try {
      cliente = parseFlatRow(campos);
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message, stage: "parse" });
    }

    // Mesma validação do lote — erros por caminho de campo.
    const [row] = validateRows([cliente]);
    if (row.errors.length > 0) {
      return reply.send({
        valido: false,
        errors: row.errors,
        tipo: row.tipo,
        env: env.SINQIA_ENV,
      });
    }

    let payload;
    try {
      payload = buildRequest(row.cliente, control);
    } catch (e) {
      return reply.send({
        valido: false,
        errors: [(e as Error).message],
        tipo: row.tipo,
        env: env.SINQIA_ENV,
      });
    }

    // Dry-run: devolve o payload montado sem tocar na Sinqia.
    if (dryRun) {
      return reply.send({
        valido: true,
        dryRun: true,
        tipo: row.tipo,
        payload,
        env: env.SINQIA_ENV,
      });
    }

    /*
     * Esteira de Aprovação (SoD, US-02): toggle do tipo ativo → a submissão
     * VÁLIDA vira requisição pendente pela camada da US-01, com payload
     * integral (campos como digitados + controles + request Sinqia montado).
     * NENHUMA chamada à Sinqia neste caminho (RN04); a execução acontece na
     * sessão do aprovador (US-03). Toggle inativo → fluxo direto intacto.
     */
    if (aprovacaoAtivaFn("tomador.cadastrar")) {
      try {
        const requisicao = sodServico().criarRequisicao({
          tipo: "tomador.cadastrar",
          payload: { campos, control, request: payload },
          requisitante: session.username,
        });
        return reply.code(201).send({
          valido: true,
          aprovacao: true,
          tipo: row.tipo,
          requisicao: {
            id: requisicao.id,
            estado: requisicao.estado,
            criadoEm: requisicao.criadoEm,
          },
          env: env.SINQIA_ENV,
        });
      } catch (e) {
        // Duplicidade pendente (RN02) → 409 com a requisição existente.
        return responderErroSod(reply, e);
      }
    }

    // Corte SoD (US-05, RN01): barreira centralizada IMEDIATAMENTE antes da
    // execução direta. Com o desvio acima, é inalcançável em operação normal —
    // segura flag ativada entre as duas leituras e rotas futuras sem desvio.
    if (guardarExecucaoDireta("tomador.cadastrar", reply, aprovacaoAtivaFn)) return;

    try {
      const { httpStatus, analysis } = await cadastrarClienteFn(session.token, payload);
      if (httpStatus === 401) {
        destroySession(session.id);
        reply.clearCookie(COOKIE_SID, { path: "/" });
        return reply.code(401).send({
          error: "O token da Sinqia expirou. Entre novamente.",
          code: CODE_SESSAO_EXPIRADA,
          motivo: "token",
        });
      }
      return reply.send({
        valido: true,
        dryRun: false,
        tipo: row.tipo,
        // OK/ERRO vem da análise do envelope, não do HTTP 200.
        status: analysis.ok ? "OK" : "ERRO",
        httpStatus,
        envelopeStatus: analysis.envelopeStatus,
        globalMessage: analysis.globalMessage,
        messages: analysis.messagesText,
        detail: analysis.ok ? undefined : analysis.reason,
        env: env.SINQIA_ENV,
      });
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message, stage: "cadastrar" });
    }
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

  /**
   * Propostas de UM cliente (consultarPropostasPorCpfcnpj — somente leitura).
   * 204 na Sinqia = cliente sem propostas → lista vazia.
   */
  app.get("/api/clientes/:cpf/propostas", async (req, reply) => {
    const session = exigirSessao(req, reply);
    if (!session) return;

    const cpf = String((req.params as { cpf: string }).cpf ?? "").replace(/\D/g, "");
    if (cpf.length !== 11 && cpf.length !== 14) {
      return reply.code(400).send({ error: "CPF/CNPJ inválido." });
    }

    try {
      const res = await listarPropostasPorCpf(session.token, cpf);
      if (res.httpStatus === 401) {
        destroySession(session.id);
        reply.clearCookie(COOKIE_SID, { path: "/" });
        return reply.code(401).send({
          error: "O token da Sinqia expirou. Entre novamente.",
          code: CODE_SESSAO_EXPIRADA,
          motivo: "token",
        });
      }
      if (res.httpStatus >= 400) {
        return reply.code(502).send({
          error: `A Sinqia respondeu HTTP ${res.httpStatus} ao consultar as propostas.`,
        });
      }
      return reply.send({ env: env.SINQIA_ENV, propostas: res.propostas });
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message, stage: "propostas-cliente" });
    }
  });

  /** Detalhe completo de uma proposta (principal + parcelas — somente leitura). */
  app.get("/api/propostas-dados/:nrProsp", async (req, reply) => {
    const session = exigirSessao(req, reply);
    if (!session) return;

    const nrProsp = Number((req.params as { nrProsp: string }).nrProsp);
    if (!Number.isSafeInteger(nrProsp) || nrProsp <= 0) {
      return reply.code(400).send({ error: "Número de proposta inválido." });
    }

    try {
      const res = await consultarDadosProposta(session.token, nrProsp);
      if (res.httpStatus === 401) {
        destroySession(session.id);
        reply.clearCookie(COOKIE_SID, { path: "/" });
        return reply.code(401).send({
          error: "O token da Sinqia expirou. Entre novamente.",
          code: CODE_SESSAO_EXPIRADA,
          motivo: "token",
        });
      }
      if (res.httpStatus === 204 || res.dados === null) {
        return reply.code(404).send({ error: `Proposta ${nrProsp} não encontrada.` });
      }
      if (res.httpStatus >= 400) {
        return reply.code(502).send({
          error: `A Sinqia respondeu HTTP ${res.httpStatus} ao consultar a proposta.`,
        });
      }
      return reply.send({ env: env.SINQIA_ENV, nrProsp, dados: res.dados });
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message, stage: "dados-proposta" });
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

const cadastrarUmBodySchema = z.object({
  /** Mapa achatado do formulário: { "dadosPf.dtNasc": "19800120" }. */
  campos: z.record(z.string(), z.string()),
  control: batchControlSchema,
  /** true = só valida e devolve o payload montado, sem enviar à Sinqia. */
  dryRun: z.boolean().default(false),
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

/** Body do PUT /api/onboarding — patch parcial do estado do usuário. */
const onboardingPatchSchema = z.object({
  tourConcluido: z.boolean().optional(),
  checklistItens: z.record(z.boolean()).optional(),
  hintsDispensados: z.array(z.string().max(60)).optional(),
});

/* ------------------------------------------------------------------ */
/* SSE compartilhado pelos jobs de cadastro e de situação              */
/* ------------------------------------------------------------------ */

/** Campos comuns aos JobState que o stream precisa conhecer. */
interface StreamableJob {
  total: number;
  processed: number;
  success: number;
  error: number;
  done: boolean;
  results: unknown[];
  /** Contadores extras de jobs específicos (divergência, não-enviado...). */
  divergencia?: number;
  naoEnviado?: number;
  diverge?: number;
  naoEncontrado?: number;
  jaExiste?: number;
}

export function streamJob(
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
  // Campos undefined somem no JSON.stringify — jobs sem eles não mudam.
  send("snapshot", {
    total: job.total,
    processed: job.processed,
    success: job.success,
    error: job.error,
    divergencia: job.divergencia,
    naoEnviado: job.naoEnviado,
    diverge: job.diverge,
    naoEncontrado: job.naoEncontrado,
    jaExiste: job.jaExiste,
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
