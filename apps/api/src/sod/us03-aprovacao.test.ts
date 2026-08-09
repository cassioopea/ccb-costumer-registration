import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
// Import SOMENTE de tipo: apagado na compilação, não dispara o load do env.ts.
import type { CadastroResult } from "./../sinqia-client.js";

/**
 * US-03 — Painel de pendências + aprovação com execução B2' (tomador).
 *
 * Cobre os cenários da história ponta a ponta no BFF, offline (Sinqia
 * simulada por spy nas deps injetáveis de registerSodRoutes):
 *  1. aprovar requisição de OUTRO operador → pendente → aprovada/executando →
 *     executada, com a chamada Sinqia NA SESSÃO DO APROVADOR (token verificado
 *     por spy) e o MESMO payload persistido (RN05/RN08); resposta integral
 *     anexada; auditoria com requisitante + aprovador;
 *  2. decisão sobre a PRÓPRIA requisição → 403 VIOLACAO_SOD auditada;
 *  3. reprovar sem motivo bloqueado; com motivo → reprovada, ZERO Sinqia,
 *     motivo visível ao requisitante;
 *  4. falha Sinqia (erro de negócio; timeout; sessão expirada DURANTE a
 *     execução) → falha com erro integral, SEM retry automático;
 *  5. duas aprovações concorrentes → primeira vence, segunda recebe estado
 *     atual + decisor, exatamente UMA chamada Sinqia;
 *  RN03. sessão Sinqia inválida na pré-verificação → bloqueio SEM transição
 *     (pendente intacta); Sinqia indisponível na sonda → 502, pendente intacta.
 */
process.env.SINQIA_BASE_URL ??= "https://sinqia.fixture.invalid";
process.env.SINQIA_ENV ??= "hml";

const dir = mkdtempSync(path.join(tmpdir(), "sod-us03-"));
process.env.SQLITE_PATH = path.join(dir, "app.db");

const { EXEMPLO_PF } = await import("@cadastro-lote/shared");
const { abrirBancoSod, criarSodRepositorio } = await import("./repositorio.js");
const { criarSodServico } = await import("./dominio.js");
const { registerSodRoutes } = await import("./rotas.js");
const { registerRoutes } = await import("./../routes.js");
const { createSession, getSession, limparSessoes } = await import("./../session.js");

let app: FastifyInstance;
let db: ReturnType<typeof abrirBancoSod>;
let servico: ReturnType<typeof criarSodServico>;
let sidMaria: string; // requisitante
let sidJoao: string; // aprovador
let sidAna: string; // segundo aprovador (concorrência)

/** Toda execução disparada pela aprovação cai aqui: token usado + payload. */
const execucoes: Array<{ token: string; body: unknown }> = [];
/** Sonda de sessão (RN03) controlável por teste. */
let sessaoSinqia: "valida" | "invalida" | "indisponivel" = "valida";
/** Quantas vezes a sonda foi consultada (reprovar NUNCA deve sondar). */
let sondagens = 0;
/** Resposta da "Sinqia" na execução — cada teste arma o seu desfecho. */
let responderCadastro: () => Promise<CadastroResult> = respostaSucesso;

async function respostaSucesso(): Promise<CadastroResult> {
  return {
    httpStatus: 200,
    envelope: {
      status: "OK",
      messages: [{ type: "Sucesso", message: "6874" }],
    } as CadastroResult["envelope"],
    analysis: {
      ok: true,
      envelopeStatus: "OK",
      messagesText: "Sucesso | 6874",
      messages: [],
    },
  };
}

before(async () => {
  db = abrirBancoSod(path.join(dir, "sod.db"));
  servico = criarSodServico(criarSodRepositorio(db, "hml"));

  app = Fastify();
  await app.register(cookie);
  // /api/cadastrar com toggle ON: cria a requisição com o payload canônico
  // { campos, control, request } — o mesmo caminho real da US-02.
  await registerRoutes(app, {
    cadastrarClienteFn: async () => {
      throw new Error("o fluxo direto não deve ser chamado nestes testes");
    },
    sodServico: () => servico,
    aprovacaoAtivaFn: (tipo) => tipo === "tomador.cadastrar",
  });
  await registerSodRoutes(app, servico, {
    verificarSessaoSinqiaFn: async () => {
      sondagens++;
      return sessaoSinqia;
    },
    cadastrarClienteFn: async (token, body) => {
      execucoes.push({ token, body });
      return responderCadastro();
    },
  });
  await app.ready();

  limparSessoes();
  // Tokens DISTINTOS por operador: é assim que o teste prova que a execução
  // usou a sessão do APROVADOR (B2'), não a do requisitante.
  sidMaria = createSession("Maria.SILVA", "token-maria").id;
  sidJoao = createSession("joao.souza", "token-joao").id;
  sidAna = createSession("ana.lima", "token-ana").id;
});

beforeEach(() => {
  sessaoSinqia = "valida";
  responderCadastro = respostaSucesso;
});

after(async () => {
  await app.close();
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

/** Cria uma requisição pendente REAL via /api/cadastrar (toggle ON), como a US-02. */
async function criarPendente(documento: string, sid = sidMaria): Promise<string> {
  const r = await post("/api/cadastrar", sid, {
    campos: { ...EXEMPLO_PF, nrCpfCnpj: documento },
    control: {},
    dryRun: false,
  });
  assert.equal(r.statusCode, 201, r.body);
  return r.json().requisicao.id as string;
}

function decidir(id: string, sid: string, decisao: string, motivo?: string) {
  return post(`/api/sod/requisicoes/${id}/decisao`, sid, { decisao, ...(motivo ? { motivo } : {}) });
}

describe("US-03 — Cenário 1: aprovação executa na sessão do aprovador (B2')", () => {
  test("pendente → aprovada/executando → executada, com token do aprovador e payload persistido", async () => {
    const id = await criarPendente("91000000001");
    const antes = execucoes.length;

    const r = await decidir(id, sidJoao, "aprovar");
    assert.equal(r.statusCode, 200, r.body);
    const body = r.json();
    assert.equal(body.requisicao.estado, "executada");
    assert.equal(body.requisicao.decididoPor, "joao.souza");
    assert.equal(body.execucao.desfecho, "executada");
    assert.ok(
      String(body.execucao.mensagens).includes("6874"),
      "resumo público identifica o tomador criado",
    );

    // B2': exatamente UMA chamada, com o token da SESSÃO DO APROVADOR.
    assert.equal(execucoes.length, antes + 1);
    assert.equal(execucoes[antes].token, "token-joao", "execução usa a sessão do aprovador");

    // RN05/RN08: o body enviado é EXATAMENTE o payload.request persistido.
    const detalhe = (await get(`/api/sod/requisicoes/${id}`, sidJoao)).json();
    assert.deepEqual(execucoes[antes].body, detalhe.requisicao.payload.request);

    // Resposta INTEGRAL anexada à requisição (RN05).
    assert.equal(detalhe.requisicao.resultado.desfecho, "executada");
    assert.equal(detalhe.requisicao.resultado.httpStatus, 200);
    assert.ok(detalhe.requisicao.resultado.envelope, "envelope Sinqia integral anexado");

    // Auditoria: requisitante E aprovador, com início e conclusão da execução.
    const acoes = detalhe.historico.map((e: { acao: string; ator: string }) => [e.acao, e.ator]);
    assert.deepEqual(acoes, [
      ["requisicao_criada", "maria.silva"],
      ["transicao_estado", "joao.souza"],
      ["execucao_iniciada", "joao.souza"],
      ["transicao_estado", "joao.souza"],
    ]);
    const conclusao = detalhe.historico[3];
    assert.equal(conclusao.detalhe.para, "executada");
    assert.ok(conclusao.detalhe.resultado, "auditoria carrega o resultado da execução");
  });
});

describe("US-03 — Cenário 2: decisão sobre a própria requisição", () => {
  test("chamada direta à API → 403 VIOLACAO_SOD, auditada, sem execução", async () => {
    const id = await criarPendente("91000000002");
    const antes = execucoes.length;

    for (const decisao of ["aprovar", "reprovar"]) {
      const r = await decidir(id, sidMaria, decisao, "tentando decidir a minha própria");
      assert.equal(r.statusCode, 403);
      assert.equal(r.json().code, "VIOLACAO_SOD");
    }
    assert.equal(execucoes.length, antes, "nenhuma chamada Sinqia");

    const detalhe = (await get(`/api/sod/requisicoes/${id}`, sidMaria)).json();
    assert.equal(detalhe.requisicao.estado, "pendente");
    const rejeitadas = detalhe.historico.filter(
      (e: { resultado: string }) => e.resultado === "rejeitada:violacao_sod",
    );
    assert.equal(rejeitadas.length, 2, "cada tentativa bloqueada consta na auditoria");
  });
});

describe("US-03 — Cenário 3: reprovação", () => {
  test("sem motivo → 400 no domínio; com motivo → reprovada, zero Sinqia, motivo visível", async () => {
    const id = await criarPendente("91000000003");
    const antesExec = execucoes.length;
    const antesSonda = sondagens;

    const semMotivo = await decidir(id, sidJoao, "reprovar", "   ");
    assert.equal(semMotivo.statusCode, 400);
    assert.equal(semMotivo.json().code, "MOTIVO_OBRIGATORIO");

    const r = await decidir(id, sidJoao, "reprovar", "documentação divergente");
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().requisicao.estado, "reprovada");
    assert.equal(r.json().requisicao.motivo, "documentação divergente");

    assert.equal(execucoes.length, antesExec, "reprovação NUNCA chama a Sinqia");
    assert.equal(sondagens, antesSonda, "reprovação nem sonda a sessão Sinqia");

    // Motivo visível ao REQUISITANTE (minhas requisições + detalhe).
    const minhas = (await get("/api/sod/requisicoes?minhas=1&limit=200", sidMaria)).json();
    const item = minhas.itens.find((i: { id: string }) => i.id === id);
    assert.equal(item.motivo, "documentação divergente");
    assert.equal(item.decididoPor, "joao.souza");
  });
});

describe("US-03 — Cenário 4: falhas da execução (sem retry automático)", () => {
  test("erro de negócio Sinqia → falha com erro integral anexado, UMA única chamada", async () => {
    const id = await criarPendente("91000000004");
    const antes = execucoes.length;
    responderCadastro = async () => ({
      httpStatus: 200,
      envelope: {
        status: "ERRO",
        messages: [{ type: "Erro", message: "CPF já cadastrado com divergência" }],
      } as CadastroResult["envelope"],
      analysis: {
        ok: false,
        envelopeStatus: "ERRO",
        messagesText: "Erro | CPF já cadastrado com divergência",
        messages: [],
        reason: "Envelope com status ERRO.",
      },
    });

    const r = await decidir(id, sidJoao, "aprovar");
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().requisicao.estado, "falha");
    assert.equal(r.json().execucao.desfecho, "falha");
    assert.ok(String(r.json().execucao.mensagens).includes("CPF já cadastrado"));
    assert.equal(execucoes.length, antes + 1, "sem retry automático (RN07)");

    const detalhe = (await get(`/api/sod/requisicoes/${id}`, sidJoao)).json();
    assert.equal(detalhe.requisicao.resultado.causa, "erro_negocio");
    assert.ok(detalhe.requisicao.resultado.envelope, "erro integral anexado (RN05)");
  });

  test("timeout/indisponibilidade → falha com a causa registrada, UMA única chamada", async () => {
    const id = await criarPendente("91000000005");
    const antes = execucoes.length;
    responderCadastro = async () => {
      throw new Error("Headers Timeout Error (fixture)");
    };

    const r = await decidir(id, sidJoao, "aprovar");
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().requisicao.estado, "falha");
    assert.equal(execucoes.length, antes + 1, "sem retry automático (RN07)");

    const detalhe = (await get(`/api/sod/requisicoes/${id}`, sidJoao)).json();
    assert.equal(detalhe.requisicao.resultado.causa, "indisponibilidade_ou_timeout");
    assert.ok(
      String(detalhe.requisicao.resultado.mensagem).includes("Timeout"),
      "erro integral anexado",
    );
  });

  test("sessão expira DURANTE a execução → falha com causa + 401 orientando reautenticação", async () => {
    // Sessão dedicada: este teste DESTRÓI a sessão do aprovador.
    const sidCarlos = createSession("carlos.melo", "token-carlos").id;
    const id = await criarPendente("91000000006");
    responderCadastro = async () => ({
      httpStatus: 401,
      envelope: null,
      analysis: { ok: false, messagesText: "", messages: [], reason: "HTTP 401" },
    });

    const r = await decidir(id, sidCarlos, "aprovar");
    assert.equal(r.statusCode, 401);
    assert.equal(r.json().code, "SESSAO_EXPIRADA");
    assert.equal(r.json().requisicao.estado, "falha");

    const detalhe = (await get(`/api/sod/requisicoes/${id}`, sidJoao)).json();
    assert.equal(detalhe.requisicao.estado, "falha");
    assert.equal(detalhe.requisicao.resultado.causa, "sessao_expirada_durante_execucao");

    // A sessão do aprovador foi destruída — precisa reautenticar.
    assert.equal(getSession(sidCarlos).ok, false);
  });
});

describe("US-03 — Cenário 5: decisões concorrentes", () => {
  test("duas aprovações em paralelo → primeira vence, segunda recebe estado + decisor, UMA execução", async () => {
    const id = await criarPendente("91000000007");
    const antes = execucoes.length;

    const [a, b] = await Promise.all([
      decidir(id, sidJoao, "aprovar"),
      decidir(id, sidAna, "aprovar"),
    ]);
    const respostas = [a, b];
    const vencedora = respostas.find((r) => r.statusCode === 200);
    const perdedora = respostas.find((r) => r.statusCode === 409);
    assert.ok(vencedora, "uma decisão vence");
    assert.ok(perdedora, "a outra perde com 409");

    assert.equal(vencedora.json().requisicao.estado, "executada");
    const corpoPerdedora = perdedora.json();
    assert.equal(corpoPerdedora.code, "TRANSICAO_INVALIDA");
    assert.ok(corpoPerdedora.estadoAtual, "perdedora recebe o estado atual");
    assert.ok(
      ["joao.souza", "ana.lima"].includes(corpoPerdedora.decididoPor),
      "perdedora sabe QUEM decidiu",
    );

    assert.equal(execucoes.length, antes + 1, "EXATAMENTE UMA chamada Sinqia");

    // A tentativa perdedora consta na auditoria (RN06).
    const detalhe = (await get(`/api/sod/requisicoes/${id}`, sidMaria)).json();
    assert.ok(
      detalhe.historico.some(
        (e: { resultado: string }) => e.resultado === "rejeitada:transicao_invalida",
      ),
      "decisão concorrente bloqueada é auditada",
    );
  });

  test("aprovar × reprovar em paralelo → jamais segunda execução", async () => {
    const id = await criarPendente("91000000008");
    const antes = execucoes.length;

    const [a, b] = await Promise.all([
      decidir(id, sidJoao, "aprovar"),
      decidir(id, sidAna, "reprovar", "reprovando em corrida"),
    ]);
    const codigos = [a.statusCode, b.statusCode].sort();
    assert.deepEqual(codigos, [200, 409], "uma vence, a outra recebe 409");
    assert.ok(execucoes.length - antes <= 1, "no máximo UMA execução Sinqia");

    const detalhe = (await get(`/api/sod/requisicoes/${id}`, sidMaria)).json();
    assert.ok(
      ["executada", "reprovada"].includes(detalhe.requisicao.estado),
      "estado final é o da decisão vencedora",
    );
  });
});

describe("US-03 — RN03: pré-verificação da sessão Sinqia do aprovador", () => {
  test("sessão inválida na sonda → 401 SEM transição; requisição permanece pendente", async () => {
    // Sessão dedicada: a pré-verificação destrói a sessão local do aprovador.
    const sidRita = createSession("rita.nunes", "token-rita").id;
    const id = await criarPendente("91000000009");
    const antes = execucoes.length;
    sessaoSinqia = "invalida";

    const r = await decidir(id, sidRita, "aprovar");
    assert.equal(r.statusCode, 401);
    assert.equal(r.json().code, "SESSAO_EXPIRADA");
    assert.equal(execucoes.length, antes, "nenhuma chamada de cadastro");

    const detalhe = (await get(`/api/sod/requisicoes/${id}`, sidJoao)).json();
    assert.equal(detalhe.requisicao.estado, "pendente", "NENHUMA transição aconteceu");
    assert.equal(detalhe.requisicao.decididoPor, null);
    assert.equal(detalhe.historico.length, 1, "só o evento de criação");

    // Orienta reautenticação: a sessão local foi encerrada.
    assert.equal(getSession(sidRita).ok, false);

    // Depois de "reautenticar", a mesma requisição segue aprovável.
    sessaoSinqia = "valida";
    const depois = await decidir(id, sidJoao, "aprovar");
    assert.equal(depois.statusCode, 200);
    assert.equal(depois.json().requisicao.estado, "executada");
  });

  test("Sinqia indisponível na sonda → 502; pendente intacta e sessão preservada", async () => {
    const id = await criarPendente("91000000010");
    const antes = execucoes.length;
    sessaoSinqia = "indisponivel";

    const r = await decidir(id, sidJoao, "aprovar");
    assert.equal(r.statusCode, 502);
    assert.equal(execucoes.length, antes);

    const detalhe = (await get(`/api/sod/requisicoes/${id}`, sidJoao)).json();
    assert.equal(detalhe.requisicao.estado, "pendente");
    assert.equal(getSession(sidJoao).ok, true, "sessão local do aprovador preservada");
  });
});

describe("US-03 — painel de pendências (listagem)", () => {
  test("ordem=asc lista da mais antiga para a mais nova (RN01); requisitantes distintos", async () => {
    await criarPendente("91000000011", sidMaria);
    await criarPendente("91000000012", sidAna);

    const asc = (
      await get("/api/sod/requisicoes?estado=pendente&ordem=asc&limit=200", sidJoao)
    ).json();
    assert.ok(asc.total >= 2);
    const datas = asc.itens.map((i: { criadoEm: string }) => i.criadoEm);
    assert.deepEqual(datas, [...datas].sort(), "mais antiga primeiro");

    const reqs = (await get("/api/sod/requisitantes", sidJoao)).json().requisitantes;
    assert.ok(reqs.includes("maria.silva") && reqs.includes("ana.lima"));
    assert.equal(new Set(reqs).size, reqs.length, "sem duplicatas");
  });
});
