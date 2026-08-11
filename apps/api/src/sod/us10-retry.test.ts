// @ts-nocheck
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";

/**
 * US-10 — Retry e Descarte manual
 */
process.env.SINQIA_BASE_URL ??= "https://sinqia.fixture.invalid";
process.env.SINQIA_ENV ??= "hml";

const dir = mkdtempSync(path.join(tmpdir(), "sod-us10-"));
process.env.SQLITE_PATH = path.join(dir, "app.db");

const { abrirBancoSod, criarSodRepositorio } = await import("./repositorio.js");
const { criarSodServico } = await import("./dominio.js");
const { registerSodRoutes } = await import("./rotas.js");
const { createSession, limparSessoes } = await import("./../session.js");
const { TIPO_ITEM_DO_LOTE } = await import("@cadastro-lote/shared");

let app: FastifyInstance;
let db: ReturnType<typeof abrirBancoSod>;
let repo: ReturnType<typeof criarSodRepositorio>;
let servico: ReturnType<typeof criarSodServico>;
let sidMaria: string; // requisitante
let sidJoao: string; // aprovador
let sidAna: string; // segunda operadora (concorrência)

before(async () => {
  db = abrirBancoSod();
  repo = criarSodRepositorio(db);
  servico = criarSodServico(repo, {
    // Sondas mockadas: sempre sucesso rápido para teste de retry.
    async transferirProposta() { return { transferencias: [{ nrProsp: 1, dtStatus: "2026-08-01", nmUsr: "portal" }] }; },
    async consultarHistorico() { return { httpStatus: 200, historicos: [] }; },
    async criarProposta() { return { httpStatus: 200, nrProposta: 1 }; },
    async cadastrarTomador() { return { httpStatus: 200, mensagem: "OK", nrClient: 1 }; },
  } as any);

  app = Fastify();
  app.register(cookie);
  app.decorate("sodServico", servico);
  
  app.addHook("onRequest", async (req, reply) => {
    const sid = req.cookies.sid;
    if (sid === "maria") req.session = { username: "maria", expirationDate: Date.now() + 100000 } as any;
    else if (sid === "joao") req.session = { username: "joao", expirationDate: Date.now() + 100000 } as any;
    else if (sid === "ana") req.session = { username: "ana", expirationDate: Date.now() + 100000 } as any;
    else return reply.code(401).send();
  });

  registerSodRoutes(app);

  await app.ready();

  sidMaria = "maria";
  sidJoao = "joao";
  sidAna = "ana";
});

after(() => {
  app.close();
  db.close();
});

beforeEach(() => {
  db.exec("DELETE FROM sod_workflow_historico;");
  db.exec("DELETE FROM sod_itens_lote;");
  db.exec("DELETE FROM sod_requisicoes;");
});

async function criarFalhaIndividual() {
  const req = servico.criarRequisicaoIndividual({
    requisitante: "maria",
    tipo: "tomador.cadastrar",
    documento: "11111111111",
    payload: { campos: { dsNome: "Teste" }, control: {} },
  });
  servico.iniciarExecucao(req.id, "joao");
  servico.concluirExecucaoIndividual(req.id, { desfecho: "falha", detalhe: "Erro", causa: "erro_inesperado" });
  return req.id;
}

async function criarFalhaLote() {
  const req = servico.criarRequisicaoLote({
    requisitante: "maria",
    tipo: "proposta.movimentar_massa",
    payload: { arquivo: { nome: "x", tipo: "csv", totalItens: 2 } },
    itens: [
      { ordem: 1, tipo: "proposta.movimentar", documento: "1", resumo: {} },
      { ordem: 2, tipo: "proposta.movimentar", documento: "2", resumo: {} },
    ],
  });
  servico.decidirLote(req.id, "joao", "aprovar");
  
  // Conclui 1 sucesso, 1 falha
  const itens = servico.obterItensDoLote(req.id);
  servico.concluirItemLote(req.id, itens[0].id, { desfecho: "executada", detalhe: "OK" });
  servico.concluirItemLote(req.id, itens[1].id, { desfecho: "falha", detalhe: "Erro" });
  servico.concluirLoteTodo(req.id, { total: 2, pendentes: 0, executando: 0, executadas: 1, falhas: 1, reprovadas: 0, canceladas: 0 });
  
  return { reqId: req.id, itemFalha: itens[1].id, itemSucesso: itens[0].id };
}

describe("US-10 Retry e Descarte", () => {
  test("Retry manual de uma requisição em falha", async () => {
    const reqId = await criarFalhaIndividual();
    
    // Maker não pode retry
    let res = await app.inject({ method: "POST", url: `/api/sod/requisicoes/${reqId}/retry`, cookies: { sid: sidMaria } });
    assert.equal(res.statusCode, 403);
    
    // Checker pode retry
    res = await app.inject({ method: "POST", url: `/api/sod/requisicoes/${reqId}/retry`, cookies: { sid: sidJoao } });
    assert.equal(res.statusCode, 200);
    
    const req = servico.obterRequisicao(reqId);
    assert.equal(req?.estado, "aprovada/executando"); // Deve estar em executando
  });

  test("Descarte de uma requisição em falha", async () => {
    const reqId = await criarFalhaIndividual();
    
    // Maker não pode descartar
    let res = await app.inject({ method: "POST", url: `/api/sod/requisicoes/${reqId}/descarte`, cookies: { sid: sidMaria }, payload: { motivo: "ok" } });
    assert.equal(res.statusCode, 403);
    
    // Falta motivo
    res = await app.inject({ method: "POST", url: `/api/sod/requisicoes/${reqId}/descarte`, cookies: { sid: sidJoao }, payload: { motivo: "" } });
    assert.equal(res.statusCode, 400);

    // Checker pode descartar
    res = await app.inject({ method: "POST", url: `/api/sod/requisicoes/${reqId}/descarte`, cookies: { sid: sidJoao }, payload: { motivo: "não precisa" } });
    assert.equal(res.statusCode, 200);
    
    const req = servico.obterRequisicao(reqId);
    assert.equal(req?.estado, "descartada");
    assert.equal(req?.motivo, "não precisa");
  });

  test("Retry de um item de lote em falha", async () => {
    const { reqId, itemFalha, itemSucesso } = await criarFalhaLote();
    
    // Não pode retry item sucesso
    let res = await app.inject({ method: "POST", url: `/api/sod/requisicoes/${reqId}/itens/${itemSucesso}/retry`, cookies: { sid: sidJoao } });
    assert.equal(res.statusCode, 409);
    
    // Checker faz retry do item falha
    res = await app.inject({ method: "POST", url: `/api/sod/requisicoes/${reqId}/itens/${itemFalha}/retry`, cookies: { sid: sidJoao } });
    assert.equal(res.statusCode, 200);
    
    const itens = servico.obterItensDoLote(reqId);
    assert.equal(itens.find(i => i.id === itemFalha)?.estado, "aprovada/executando");
    const req = servico.obterRequisicao(reqId);
    assert.equal(req?.estado, "aprovada/executando"); // O lote também reabre
  });

  test("Descarte de um item de lote em falha", async () => {
    const { reqId, itemFalha } = await criarFalhaLote();
    
    const res = await app.inject({ method: "POST", url: `/api/sod/requisicoes/${reqId}/itens/${itemFalha}/descarte`, cookies: { sid: sidJoao }, payload: { motivo: "pula" } });
    assert.equal(res.statusCode, 200);
    
    const itens = servico.obterItensDoLote(reqId);
    assert.equal(itens.find(i => i.id === itemFalha)?.estado, "descartada");
    
    const req = servico.obterRequisicao(reqId);
    assert.equal(req?.estado, "executada"); // Se não há mais falhas, o lote conclui
  });

  test("Conveniência: retry de lote inteiro com falhas elegíveis", async () => {
    const { reqId, itemFalha } = await criarFalhaLote();
    
    const res = await app.inject({ method: "POST", url: `/api/sod/requisicoes/${reqId}/retry-lote`, cookies: { sid: sidJoao } });
    assert.equal(res.statusCode, 200);
    
    const itens = servico.obterItensDoLote(reqId);
    assert.equal(itens.find(i => i.id === itemFalha)?.estado, "aprovada/executando");
    const req = servico.obterRequisicao(reqId);
    assert.equal(req?.estado, "aprovada/executando");
  });

  test("Concorrência (Cenário 4): retry x descarte simultâneos", async () => {
    const reqId = await criarFalhaIndividual();
    
    // Duas requisições simultâneas: uma de retry e uma de descarte
    const res = await Promise.all([
      app.inject({ method: "POST", url: `/api/sod/requisicoes/${reqId}/retry`, cookies: { sid: sidJoao } }),
      app.inject({ method: "POST", url: `/api/sod/requisicoes/${reqId}/descarte`, cookies: { sid: sidAna }, payload: { motivo: "venci a corrida" } })
    ]);
    
    // Uma deve retornar 200, a outra deve falhar com 409 (TRANSICAO_INVALIDA)
    const statusCodes = res.map(r => r.statusCode);
    assert.ok(statusCodes.includes(200), "Uma das requisições deve ter sucesso");
    assert.ok(statusCodes.includes(409), "A outra requisição deve falhar por conflito de estado");
    
    // Verifica a consistência do estado final com o vencedor da corrida
    const vencedorRetry = res[0].statusCode === 200;
    const req = servico.obterRequisicao(reqId);
    
    if (vencedorRetry) {
      assert.equal(req?.estado, "aprovada/executando");
    } else {
      assert.equal(req?.estado, "descartada");
      assert.equal(req?.motivo, "venci a corrida");
    }
  });
});

