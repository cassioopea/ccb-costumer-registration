import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";

/**
 * Testes dos endpoints internos SoD (US-01) via fastify.inject — offline,
 * sem Sinqia e sem credencial real (sessões criadas direto no store com
 * token fixture opaco).
 *
 * O import das rotas é DINÂMICO porque rotas.ts importa env.ts, que valida
 * o ambiente no load — os fixtures abaixo garantem que o teste roda em
 * qualquer máquina/CI, com ou sem .env.
 */
process.env.SINQIA_BASE_URL ??= "https://sinqia.fixture.invalid";
process.env.SINQIA_ENV ??= "hml";

const dir = mkdtempSync(path.join(tmpdir(), "sod-us01-rotas-"));

const { abrirBancoSod, criarSodRepositorio } = await import("./repositorio.js");
const { criarSodServico } = await import("./dominio.js");
const { registerSodRoutes } = await import("./rotas.js");
const { createSession, limparSessoes } = await import("./../session.js");

let app: FastifyInstance;
let db: ReturnType<typeof abrirBancoSod>;
let sidMaria: string;
let sidJoao: string;

before(async () => {
  db = abrirBancoSod(path.join(dir, "rotas.db"));
  const servico = criarSodServico(criarSodRepositorio(db, "hml"));

  app = Fastify();
  await app.register(cookie);
  await registerSodRoutes(app, servico);
  await app.ready();

  limparSessoes();
  // Logins com caixa/espaço de propósito: a normalização é da camada SoD.
  sidMaria = createSession("Maria.SILVA", "token-fixture-opaco").id;
  sidJoao = createSession("joao.souza", "token-fixture-opaco").id;
});

after(async () => {
  await app.close();
  // Fechar a conexão antes de remover: no Windows o WAL segura o arquivo.
  db.close();
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* melhor-esforço — o SO limpa o temp que sobrar */
  }
});

function post(url: string, sid: string | null, payload: unknown) {
  return app.inject({
    method: "POST",
    url,
    ...(sid ? { cookies: { sid } } : {}),
    payload: payload as Record<string, unknown>,
  });
}

function get(url: string, sid: string | null) {
  return app.inject({ method: "GET", url, ...(sid ? { cookies: { sid } } : {}) });
}

const BODY_CRIACAO = {
  tipo: "tomador.cadastrar",
  payload: { cliente: { nrCpfCnpj: "15032465070", dsNome: "Fulana Fixture" } },
};

describe("endpoints SoD", () => {
  test("sem sessão → 401 em todas as rotas", async () => {
    for (const r of [
      await post("/api/sod/requisicoes", null, BODY_CRIACAO),
      await get("/api/sod/requisicoes", null),
      await get("/api/sod/auditoria", null),
    ]) {
      assert.equal(r.statusCode, 401);
      assert.equal(r.json().code, "SESSAO_EXPIRADA");
    }
  });

  test("criar → 201 com requisitante normalizado da SESSÃO (não do body)", async () => {
    const r = await post("/api/sod/requisicoes", sidMaria, BODY_CRIACAO);
    assert.equal(r.statusCode, 201);
    const { requisicao } = r.json();
    assert.equal(requisicao.estado, "pendente");
    assert.equal(requisicao.requisitante, "maria.silva");
    assert.deepEqual(requisicao.payload, BODY_CRIACAO.payload);
  });

  test("criar com tipo fora do registro → 400", async () => {
    const r = await post("/api/sod/requisicoes", sidMaria, {
      tipo: "acao.inexistente",
      payload: {},
    });
    assert.equal(r.statusCode, 400);
  });

  test("decisão do próprio criador → 403 VIOLACAO_SOD e permanece pendente", async () => {
    const criada = (await post("/api/sod/requisicoes", sidMaria, BODY_CRIACAO)).json().requisicao;
    const r = await post(`/api/sod/requisicoes/${criada.id}/decisao`, sidMaria, {
      decisao: "aprovar",
    });
    assert.equal(r.statusCode, 403);
    assert.equal(r.json().code, "VIOLACAO_SOD");

    const detalhe = (await get(`/api/sod/requisicoes/${criada.id}`, sidMaria)).json();
    assert.equal(detalhe.requisicao.estado, "pendente");
  });

  test("aprovação por segundo operador → aprovada/executando (execução fica para a US-03)", async () => {
    const criada = (await post("/api/sod/requisicoes", sidMaria, BODY_CRIACAO)).json().requisicao;
    const r = await post(`/api/sod/requisicoes/${criada.id}/decisao`, sidJoao, {
      decisao: "aprovar",
    });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().requisicao.estado, "aprovada/executando");
    assert.equal(r.json().requisicao.decididoPor, "joao.souza");

    // Decisão repetida sobre estado que já mudou → 409.
    const repetida = await post(`/api/sod/requisicoes/${criada.id}/decisao`, sidJoao, {
      decisao: "reprovar",
      motivo: "tarde demais",
    });
    assert.equal(repetida.statusCode, 409);
    assert.equal(repetida.json().code, "TRANSICAO_INVALIDA");
  });

  test("reprovar sem motivo → 400 MOTIVO_OBRIGATORIO", async () => {
    const criada = (await post("/api/sod/requisicoes", sidMaria, BODY_CRIACAO)).json().requisicao;
    const r = await post(`/api/sod/requisicoes/${criada.id}/decisao`, sidJoao, {
      decisao: "reprovar",
      motivo: "  ",
    });
    assert.equal(r.statusCode, 400);
    assert.equal(r.json().code, "MOTIVO_OBRIGATORIO");
  });

  test("cancelamento pelo criador via endpoint; por terceiro → 403", async () => {
    const criada = (await post("/api/sod/requisicoes", sidMaria, BODY_CRIACAO)).json().requisicao;
    const negado = await post(`/api/sod/requisicoes/${criada.id}/decisao`, sidJoao, {
      decisao: "cancelar",
    });
    assert.equal(negado.statusCode, 403);
    assert.equal(negado.json().code, "CANCELAMENTO_NEGADO");

    const ok = await post(`/api/sod/requisicoes/${criada.id}/decisao`, sidMaria, {
      decisao: "cancelar",
    });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.json().requisicao.estado, "cancelada");
  });

  test("detalhe traz histórico; id desconhecido → 404", async () => {
    const criada = (await post("/api/sod/requisicoes", sidMaria, BODY_CRIACAO)).json().requisicao;
    await post(`/api/sod/requisicoes/${criada.id}/decisao`, sidJoao, { decisao: "aprovar" });

    const detalhe = (await get(`/api/sod/requisicoes/${criada.id}`, sidMaria)).json();
    assert.equal(detalhe.historico.length, 2); // criação + transição
    assert.equal(detalhe.historico[1].acao, "transicao_estado");

    const sumida = await get(
      "/api/sod/requisicoes/00000000-0000-4000-8000-000000000000",
      sidMaria,
    );
    assert.equal(sumida.statusCode, 404);
  });

  test("listagem com filtros e paginação", async () => {
    const todas = (await get("/api/sod/requisicoes?limit=200", sidMaria)).json();
    assert.ok(todas.total >= 2);

    const pendentes = (await get("/api/sod/requisicoes?estado=pendente&limit=200", sidMaria)).json();
    assert.ok(
      pendentes.itens.every((r: { estado: string }) => r.estado === "pendente"),
      "filtro de estado deve valer para todos os itens",
    );

    // Filtro por requisitante aceita a forma como digitada e normaliza.
    const deMaria = (
      await get("/api/sod/requisicoes?requisitante=Maria.SILVA&limit=200", sidMaria)
    ).json();
    assert.equal(deMaria.total, todas.total);

    const pagina = (await get("/api/sod/requisicoes?limit=1&offset=0", sidMaria)).json();
    assert.equal(pagina.itens.length, 1);
  });

  test("auditoria com filtros por ator e requisição", async () => {
    const criada = (await post("/api/sod/requisicoes", sidMaria, BODY_CRIACAO)).json().requisicao;

    const daReq = (
      await get(`/api/sod/auditoria?requisicaoId=${criada.id}`, sidMaria)
    ).json();
    assert.equal(daReq.total, 1);
    assert.equal(daReq.itens[0].acao, "requisicao_criada");

    const doJoao = (await get("/api/sod/auditoria?ator=Joao.SOUZA&limit=200", sidMaria)).json();
    assert.ok(doJoao.itens.every((e: { ator: string }) => e.ator === "joao.souza"));

    const periodoVazio = (
      await get("/api/sod/auditoria?de=2999-01-01T00:00:00.000Z", sidMaria)
    ).json();
    assert.equal(periodoVazio.total, 0);
  });
});
