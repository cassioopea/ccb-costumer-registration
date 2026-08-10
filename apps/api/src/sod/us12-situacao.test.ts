import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";

process.env.SINQIA_BASE_URL ??= "https://sinqia.fixture.invalid";
process.env.SINQIA_ENV ??= "hml";

const dir = mkdtempSync(path.join(tmpdir(), "sod-us12-"));
process.env.SQLITE_PATH = path.join(dir, "app.db");

const { extrairDocumentoSod } = await import("@cadastro-lote/shared");
const { abrirBancoSod, criarSodRepositorio } = await import("./repositorio.js");
const { criarSodServico } = await import("./dominio.js");
const { registerSodRoutes } = await import("./rotas.js");
const { registerRoutes } = await import("./../routes.js");
const { createSession, limparSessoes } = await import("./../session.js");

let app: FastifyInstance;
let db: ReturnType<typeof abrirBancoSod>;
let repo: ReturnType<typeof criarSodRepositorio>;
let servico: ReturnType<typeof criarSodServico>;
let sidRequisitante: string;
let sidAprovador: string;

let toggleSituacao = true;
let aprovacaoAtivaOverride: ((tipo: string) => boolean) | null = null;
const aprovacaoAtivaFake = (tipo: string) => {
  if (aprovacaoAtivaOverride) return aprovacaoAtivaOverride(tipo);
  return tipo === "situacao_tomador" || tipo === "situacao_tomador_lote" ? toggleSituacao : false;
};

const alteracoesExecucao: Array<{ token: string; cdSituacao: number; cpfcnpj: string }> = [];
let responderAlteracaoExecucao = async () => ({ httpStatus: 200, analysis: { ok: true, envelopeStatus: "OK", messagesText: "OK", messages: [], reason: "" } });

const alteracoesDiretas: Array<{ token: string; cdSituacao: number; cpfcnpj: string }> = [];
let responderAlteracaoDireta = async () => ({ httpStatus: 200, analysis: { ok: true, envelopeStatus: "OK", messagesText: "OK", messages: [], reason: "" } });

const propostasPorCpf: Array<{ token: string; cpfcnpj: string }> = [];
let responderPropostasPorCpf = async () => ({ httpStatus: 200, propostas: [] });

before(async () => {
  db = abrirBancoSod(process.env.SQLITE_PATH!);
  repo = criarSodRepositorio(db, "hml");
  servico = criarSodServico(repo);

  app = Fastify();
  app.register(cookie);
  
  await registerSodRoutes(app, servico, {
    verificarSessaoSinqiaFn: async () => "valida",
    alterarSituacaoClienteFn: async (token, body: any) => {
      alteracoesExecucao.push({ token, cdSituacao: body.cdSituacao, cpfcnpj: body.nrCliente });
      return responderAlteracaoExecucao();
    },
    listarPropostasPorCpfFn: async (token, cpfcnpj) => {
      propostasPorCpf.push({ token, cpfcnpj });
      return responderPropostasPorCpf();
    }
  });
  
  await registerRoutes(app, {
    sodServico: () => servico,
    aprovacaoAtivaFn: aprovacaoAtivaFake,
    alterarSituacaoClienteFn: async (token, body: any) => {
      alteracoesDiretas.push({ token, cdSituacao: body.cdSituacao, cpfcnpj: body.nrCliente });
      return responderAlteracaoDireta();
    },
    listarPropostasPorCpfFn: async (token: string, cpfcnpj: string) => {
      propostasPorCpf.push({ token, cpfcnpj });
      return responderPropostasPorCpf();
    }
  });

  await app.ready();

  limparSessoes();
  sidRequisitante = createSession("requisitante", "token-req").id;
  sidAprovador = createSession("aprovador", "token-apr").id;
});

after(async () => {
  await app.close();
  db.close();
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {}
});

beforeEach(() => {
  toggleSituacao = true;
  aprovacaoAtivaOverride = null;
  alteracoesExecucao.length = 0;
  alteracoesDiretas.length = 0;
  propostasPorCpf.length = 0;
  responderAlteracaoExecucao = async () => ({ httpStatus: 200, analysis: { ok: true, envelopeStatus: "OK", messagesText: "OK", messages: [], reason: "" } });
  responderAlteracaoDireta = async () => ({ httpStatus: 200, analysis: { ok: true, envelopeStatus: "OK", messagesText: "OK", messages: [], reason: "" } });
  responderPropostasPorCpf = async () => ({ httpStatus: 200, propostas: [] });
});

async function requisitarSituacao(payload: any) {
  return app.inject({
    method: "POST",
    url: "/api/situacao",
    cookies: { sid: sidRequisitante },
    payload,
  });
}

async function decidir(id: string, sid: string, decisao: "aprovar" | "reprovar", motivo?: string) {
  return app.inject({
    method: "POST",
    url: `/api/sod/requisicoes/${id}/decisao`,
    cookies: { sid },
    payload: { decisao, ...(motivo !== undefined ? { motivo } : {}) },
  });
}

async function aguardarConclusao(id: string) {
  let req;
  for (let i = 0; i < 20; i++) {
    req = servico.obterRequisicao(id);
    if (req?.estado !== "pendente" && req?.estado !== "aprovada/executando") return;
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("US-12 — Situação do Tomador", () => {
  test("extração de documento", () => {
    assert.equal(
      extrairDocumentoSod("situacao_tomador", {
        alvo: { documento: "111.222.333-44" },
      }),
      "11122233344",
    );
  });

  test("flag OFF -> altera direto na Sinqia (fluxo tradicional)", async () => {
    toggleSituacao = false;
    const res = await requisitarSituacao({
      cdSituacao: 2,
      alvos: [{ nrCliente: 123, nome: "João", documento: "11122233344", situacaoAnterior: "Ativo" }]
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.aprovacao, undefined);
    assert.ok(body.jobId, "Deve retornar um jobId para o fluxo direto");
  });

  test("flag ON -> cria requisição pendente, aprovação executa com impacto", async () => {
    const resReq = await requisitarSituacao({
      cdSituacao: 2,
      alvos: [{ nrCliente: 123, nome: "João", documento: "11122233344", situacaoAnterior: "Ativo" }]
    });
    
    assert.equal(resReq.statusCode, 201);
    const id = resReq.json().requisicao.id;
    assert.ok(id);
    assert.equal(alteracoesDiretas.length, 0, "Não deve chamar a Sinqia na criação");

    responderPropostasPorCpf = async () => ({
      httpStatus: 200,
      propostas: [{ cdProposta: 1 }, { cdProposta: 2 }] as any[]
    });

    const resApr = await decidir(id, sidAprovador, "aprovar");
    assert.equal(resApr.statusCode, 200);
    
    await aguardarConclusao(id);
    
    const req = servico.obterRequisicao(id);
    assert.equal(req?.estado, "executada");
    
    assert.equal(alteracoesExecucao.length, 1);
    assert.equal(alteracoesExecucao[0].token, "token-apr", "Deve usar o token do aprovador");
    assert.equal(alteracoesExecucao[0].cdSituacao, 2);
    
    assert.equal(propostasPorCpf.length, 1, "Deve ter consultado impacto");
    
    const det = servico.detalharRequisicao(id);
    const eventos = det.historico;
    const transicao = eventos.find((e) => e.acao === "transicao_estado" && (e.detalhe as any)?.decisao === "concluir_execucao");
    assert.equal(
      (transicao?.detalhe as any)?.resultado?.propostasAfetadas,
      2,
      `Eventos: ${JSON.stringify(eventos, null, 2)}`
    );
  });
  
  test("bloqueio de duplicidade: não permite alterar mesma situação duas vezes", async () => {
    const payload = {
      cdSituacao: 3,
      alvos: [{ nrCliente: 123, nome: "João", documento: "11122233344", situacaoAnterior: "Ativo" }]
    };
    
    const res1 = await requisitarSituacao(payload);
    assert.equal(res1.statusCode, 201);
    
    const res2 = await requisitarSituacao(payload);
    assert.equal(res2.statusCode, 409);
    const body2 = res2.json();
    assert.equal(body2.code, "DUPLICIDADE_PENDENTE");
  });

  test("Cenário 2 - massa: lote padrão US-06 ponta a ponta com falha parcial injetada", async () => {
    // 1. Cria lote
    const payload = {
      cdSituacao: 2, // Ativo
      alvos: [
        { nrCliente: 201, nome: "Cliente 201", documento: "20120120120", situacaoAnterior: "Inativo" },
        { nrCliente: 202, nome: "Cliente 202", documento: "20220220220", situacaoAnterior: "Inativo" },
      ]
    };
    const resReq = await requisitarSituacao(payload);
    assert.equal(resReq.statusCode, 201);
    const bodyReq = resReq.json();
    assert.ok(bodyReq.requisicao.id);
    const id = bodyReq.requisicao.id;

    // 2. Injeta falha parcial no Sinqia
    let chamadasSinqia = 0;
    responderAlteracaoExecucao = async () => {
      chamadasSinqia++;
      if (chamadasSinqia === 2) {
        return { httpStatus: 400, analysis: { ok: false, envelopeStatus: "ERRO", messagesText: "Erro injetado", messages: [], reason: "ERRO_INJETADO" } };
      }
      return { httpStatus: 200, analysis: { ok: true, envelopeStatus: "OK", messagesText: "OK", messages: [], reason: "" } };
    };

    responderPropostasPorCpf = async () => ({
      httpStatus: 200, propostas: []
    });

    // 3. Aprova o lote
    const resApr = await decidir(id, sidAprovador, "aprovar");
    assert.equal(resApr.statusCode, 200);

    // 4. Aguarda conclusão
    await aguardarConclusao(id);
    
    const req = servico.obterRequisicao(id);
    assert.equal(req?.estado, "falha", "Lote falha pois teve 1 falha parcial");

    const detalhe = servico.detalharRequisicao(id);
    assert.equal(detalhe.placar?.executadas, 1);
    assert.equal(detalhe.placar?.falhas, 1);
  });
});
