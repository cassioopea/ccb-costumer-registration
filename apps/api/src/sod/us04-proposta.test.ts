import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
// Imports SOMENTE de tipo: apagados na compilação, não disparam o load do env.ts.
import type { CalcProspResult } from "./../sinqia-client.js";
import type { CriacaoItem, CriacaoRowResult, ContextoCriacao } from "./../criacao-job.js";
import type { PropostaLoteParamsCriacao } from "./../proposta-builder.js";

/**
 * US-04 — Requisição + aprovação individual de PROPOSTA (reuso da máquina).
 *
 * Cobre os cenários da história ponta a ponta no BFF, offline (Sinqia
 * simulada por spies nas deps injetáveis de registerPropostasRoutes e
 * registerSodRoutes):
 *  1. toggle ON + proposta válida → requisição `pendente` com payload integral
 *     (insumos + referência ROTULADA), ZERO criação na Sinqia, visível em
 *     "Minhas requisições" e no painel de pendências;
 *  2. aprovação por OUTRO operador → cálculo OFICIAL + criação na SESSÃO DO
 *     APROVADOR (token verificado por spy), reusando o MESMO criarUma do fluxo
 *     direto → `executada` com resposta integral; auditoria completa;
 *  3. duplicidade: requisição pendente equivalente (RN04, chave = assinatura da
 *     guarda existente) bloqueia com 409; proposta DIFERENTE do mesmo CPF passa;
 *     terminais não bloqueiam; guarda Sinqia na execução → falha registrada;
 *  4. falhas na execução (cálculo reprovado, erro de negócio, timeout, sessão
 *     expirada) → `falha` com erro integral DISTINGUÍVEL, sem retry automático;
 *  RN05. tomador inexistente e tomador em requisição pendente → bloqueio com
 *     as mensagens corretas;
 *  + maker-checker, concorrência e pré-verificação de sessão (suíte da US-03
 *    espelhada para o novo tipo) e regressão do fluxo direto (toggle OFF).
 */
process.env.SINQIA_BASE_URL ??= "https://sinqia.fixture.invalid";
process.env.SINQIA_ENV ??= "hml";

const dir = mkdtempSync(path.join(tmpdir(), "sod-us04-"));
process.env.SQLITE_PATH = path.join(dir, "app.db");

const { EXEMPLO_PF, ROTULO_REFERENCIA_CALCULO } = await import("@cadastro-lote/shared");
const { abrirBancoSod, criarSodRepositorio } = await import("./repositorio.js");
const { criarSodServico } = await import("./dominio.js");
const { registerSodRoutes } = await import("./rotas.js");
const { registerRoutes } = await import("./../routes.js");
const { registerPropostasRoutes } = await import("./../routes-propostas.js");
const { SessaoExpiradaError } = await import("./../criacao-job.js");
const { createSession, getSession, limparSessoes } = await import("./../session.js");

let app: FastifyInstance;
let db: ReturnType<typeof abrirBancoSod>;
let servico: ReturnType<typeof criarSodServico>;
let sidMaria: string; // requisitante
let sidJoao: string; // aprovador
let sidAna: string; // segundo aprovador (concorrência)

/** Toggle mutável da proposta — o teste de regressão desliga só ele. */
let toggleProposta = true;
const aprovacaoAtivaFake = (tipo: string) =>
  tipo === "tomador.cadastrar" ? true : tipo === "proposta.criar" ? toggleProposta : false;

/* ---- Spies do lado do REQUISITANTE (registerPropostasRoutes) ---- */

/** Chamadas do calcProsp do requisitante (calcular-uma). */
const calculosMaker: Array<{ token: string; body: unknown }> = [];
/** criarUma do FLUXO DIRETO — com o toggle ON, jamais pode ser chamado. */
const criacoesDiretas: Array<{ token: string }> = [];

/** Cálculo-fixture (shape real do calcProsp). Sobrescritas por teste. */
function calculoFixture(over: Record<string, number> = {}) {
  const vlPresta = over.vlPresta ?? 416.78;
  return {
    vlLiquid: 4600,
    vlPresta,
    vlIof: 38.9,
    vlContra: over.vlContra ?? 5001.36,
    dtVct1ap: 20260901,
    dtVctult: 20270801,
    txAm: 1.9,
    txCetAm: 2.05,
    qtPrest: 12,
    vlTotal: 5001.36,
    vlTac: 350,
    prestacoes: [
      {
        tpParc: 0,
        nrPresta: 1,
        vlPrinc: 380.1,
        vlJuros: 36.68,
        vlPresta,
        dtVctPre: 20260901,
        vlTotal: vlPresta,
      },
    ],
  };
}

const analysisOk = { ok: true, envelopeStatus: "OK", messagesText: "", messages: [] };

function calcResultOk(over: Record<string, number> = {}): CalcProspResult {
  return { httpStatus: 200, calculo: calculoFixture(over), analysis: analysisOk };
}

let responderCalculoMaker: () => Promise<CalcProspResult> = async () => calcResultOk();

/** Clientes "existentes" no ambiente do fixture (RN05). */
const clientesExistentes = new Set<string>();
async function buscarClienteFake(_token: string, cpf: string) {
  return clientesExistentes.has(cpf)
    ? { httpStatus: 200, encontrado: true, nrClient: 4242, dsNome: "Tomador Fixture" }
    : { httpStatus: 204, encontrado: false, nrClient: null as number | null, dsNome: "" };
}

/* ---- Spies do lado do APROVADOR (registerSodRoutes / executor) ---- */

/** Cálculo OFICIAL na aprovação: token + request usados. */
const calculosOficiais: Array<{ token: string; body: unknown }> = [];
let responderCalculoOficial: () => Promise<CalcProspResult> = async () => calcResultOk();

/** criarUma da EXECUÇÃO: prova o reuso do caminho do fluxo direto. */
const execucoes: Array<{
  token: string;
  item: CriacaoItem;
  params: PropostaLoteParamsCriacao;
  forcar: boolean;
  contexto?: ContextoCriacao;
}> = [];

function criacaoOk(item: CriacaoItem): CriacaoRowResult {
  return {
    linha: item.linha,
    nome: item.nome,
    cpf: item.cpf,
    nrClient: 4242,
    nrProsp: "2585",
    status: "OK",
    httpStatus: 200,
    envelopeStatus: "OK",
    globalMessage: "",
    messages: "Sucesso | 2585",
  };
}
let responderCriacao: (item: CriacaoItem) => Promise<CriacaoRowResult> = async (item) =>
  criacaoOk(item);

/** Sonda de sessão (RN03) controlável por teste. */
let sessaoSinqia: "valida" | "invalida" | "indisponivel" = "valida";
let sondagens = 0;

before(async () => {
  db = abrirBancoSod(path.join(dir, "sod.db"));
  servico = criarSodServico(criarSodRepositorio(db, "hml"));

  app = Fastify();
  await app.register(cookie);
  // /api/cadastrar com toggle de tomador ON — cria a requisição pendente de
  // tomador usada no cenário RN05 ("aguarde a aprovação do tomador").
  await registerRoutes(app, {
    cadastrarClienteFn: async () => {
      throw new Error("o fluxo direto de tomador não deve ser chamado nestes testes");
    },
    sodServico: () => servico,
    aprovacaoAtivaFn: aprovacaoAtivaFake,
  });
  await registerPropostasRoutes(app, {
    calcProspFn: async (token, body) => {
      calculosMaker.push({ token, body });
      return responderCalculoMaker();
    },
    buscarClientePorCpfFn: buscarClienteFake,
    criarUmaFn: async (token) => {
      criacoesDiretas.push({ token });
      return criacaoOk({ linha: 1, nome: "", cpf: "", calculo: calculoFixture() });
    },
    sodServico: () => servico,
    aprovacaoAtivaFn: aprovacaoAtivaFake,
  });
  await registerSodRoutes(app, servico, {
    verificarSessaoSinqiaFn: async () => {
      sondagens++;
      return sessaoSinqia;
    },
    cadastrarClienteFn: async () => {
      throw new Error("o executor de proposta não usa cadastrarCliente");
    },
    calcProspFn: async (token, body) => {
      calculosOficiais.push({ token, body });
      return responderCalculoOficial();
    },
    criarUmaFn: async (token, item, params, forcar, contexto) => {
      execucoes.push({ token, item, params, forcar, contexto });
      return responderCriacao(item);
    },
  });
  await app.ready();

  limparSessoes();
  // Tokens DISTINTOS por operador: prova de que a execução (cálculo oficial +
  // criação) usou a sessão do APROVADOR (B2'), não a do requisitante.
  sidMaria = createSession("Maria.SILVA", "token-maria").id;
  sidJoao = createSession("joao.souza", "token-joao").id;
  sidAna = createSession("ana.lima", "token-ana").id;
});

beforeEach(() => {
  toggleProposta = true;
  sessaoSinqia = "valida";
  responderCalculoMaker = async () => calcResultOk();
  responderCalculoOficial = async () => calcResultOk();
  responderCriacao = async (item) => criacaoOk(item);
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

const PARAMS_CALC = { txJuros: 1.9, cdProd: 80, idCarCtr: 31, dtContra: 20260801 };
const PARAMS_CRIACAO = { ...PARAMS_CALC, cdConven: "1", cdLoja: 5 };

/** Passo 2 do fluxo real: calcular-uma → calcId retido no servidor. */
async function calcular(cpf: string, sid = sidMaria): Promise<string> {
  const r = await post("/api/propostas/calcular-uma", sid, {
    cpf,
    nome: "Tomador Fixture",
    dados: { vlLiquido: 4600, qtParcelas: 12, dtVct1Ap: 20260901, vlTac: 350 },
    params: PARAMS_CALC,
  });
  assert.equal(r.statusCode, 200, r.body);
  return r.json().calcId as string;
}

/** Passo 3 com toggle ON: criar-uma → requisição pendente. */
function criarUmaHttp(calcId: string, sid = sidMaria, forcarDuplicada = false) {
  return post("/api/propostas/criar-uma", sid, {
    calcId,
    params: PARAMS_CRIACAO,
    forcarDuplicada,
  });
}

async function criarPendenteProposta(cpf: string, sid = sidMaria): Promise<string> {
  clientesExistentes.add(cpf);
  const calcId = await calcular(cpf, sid);
  const r = await criarUmaHttp(calcId, sid);
  assert.equal(r.statusCode, 201, r.body);
  return r.json().requisicao.id as string;
}

function decidir(id: string, sid: string, decisao: string, motivo?: string) {
  return post(`/api/sod/requisicoes/${id}/decisao`, sid, {
    decisao,
    ...(motivo ? { motivo } : {}),
  });
}

describe("US-04 — Cenário 1: toggle ON, proposta válida vira requisição pendente", () => {
  test("payload integral + referência rotulada, zero criação Sinqia, visível nas listas", async () => {
    const cpf = "93000000001";
    const antesDiretas = criacoesDiretas.length;
    const antesExec = execucoes.length;

    const id = await criarPendenteProposta(cpf);

    // ZERO criações na Sinqia: nem fluxo direto, nem executor.
    assert.equal(criacoesDiretas.length, antesDiretas);
    assert.equal(execucoes.length, antesExec);

    const detalhe = (await get(`/api/sod/requisicoes/${id}`, sidMaria)).json();
    const req = detalhe.requisicao;
    assert.equal(req.tipo, "proposta.criar");
    assert.equal(req.estado, "pendente");
    assert.equal(req.requisitante, "maria.silva");

    // Payload integral: insumos + request do cálculo + referência ROTULADA (RN06).
    assert.equal(req.payload.proposta.cpf, cpf);
    assert.equal(req.payload.proposta.dados.vlLiquido, 4600);
    assert.equal(req.payload.proposta.params.cdConven, "1");
    assert.ok(req.payload.calcRequest, "request do calcProsp persistido");
    assert.equal(req.payload.calcRequest.nrCPF, cpf);
    assert.equal(req.payload.referencia.rotulo, ROTULO_REFERENCIA_CALCULO);
    assert.equal(req.payload.referencia.resumo.vlPresta, 416.78);

    // Chave de duplicidade (RN04) = assinatura da guarda existente, por CPF.
    assert.ok(String(req.documento).startsWith(`${cpf}:prod80:12x:`), req.documento);

    // Visível em "Minhas requisições" do criador e no painel de pendências.
    const minhas = (await get("/api/sod/requisicoes?minhas=1&limit=200", sidMaria)).json();
    assert.ok(minhas.itens.some((i: { id: string }) => i.id === id));
    const pendentes = (
      await get("/api/sod/requisicoes?estado=pendente&tipo=proposta.criar&limit=200", sidJoao)
    ).json();
    assert.ok(pendentes.itens.some((i: { id: string }) => i.id === id));
  });

  test("cálculo é pré-requisito: calcId desconhecido não vira requisição", async () => {
    const r = await criarUmaHttp("11111111-1111-4111-8111-111111111111");
    assert.equal(r.statusCode, 410, r.body);
  });
});

describe("US-04 — Cenário 2: aprovação executa cálculo oficial + criação na sessão do aprovador", () => {
  test("calcProsp e criarUma com o token do aprovador; executada com resposta integral", async () => {
    const cpf = "93000000002";
    const id = await criarPendenteProposta(cpf);
    const antesCalc = calculosOficiais.length;
    const antesExec = execucoes.length;

    const r = await decidir(id, sidJoao, "aprovar");
    assert.equal(r.statusCode, 200, r.body);
    const body = r.json();
    assert.equal(body.requisicao.estado, "executada");
    assert.equal(body.requisicao.decididoPor, "joao.souza");
    assert.ok(
      String(body.execucao.mensagens).includes("2585"),
      "resumo público identifica a proposta criada",
    );

    // B2': cálculo oficial + criação, ambos com o token do APROVADOR.
    assert.equal(calculosOficiais.length, antesCalc + 1);
    assert.equal(calculosOficiais[antesCalc].token, "token-joao");
    assert.equal(execucoes.length, antesExec + 1);
    const exec = execucoes[antesExec];
    assert.equal(exec.token, "token-joao", "criação usa a sessão do aprovador");

    const detalhe = (await get(`/api/sod/requisicoes/${id}`, sidJoao)).json();
    // O cálculo oficial usou EXATAMENTE o calcRequest persistido (RN05/RN08).
    assert.deepEqual(calculosOficiais[antesCalc].body, detalhe.requisicao.payload.calcRequest);
    // Reuso do criarUma: o MESMO contrato do fluxo direto, com o cálculo OFICIAL.
    assert.equal(exec.item.cpf, cpf);
    assert.equal(exec.item.calculo.vlPresta, 416.78);
    assert.deepEqual(exec.params, PARAMS_CRIACAO);
    assert.equal(exec.forcar, false);
    assert.deepEqual(exec.contexto, { usuario: "joao.souza", origem: "individual" });

    // Resultado INTEGRAL anexado (RN05): nrProsp + cálculo oficial.
    assert.equal(detalhe.requisicao.resultado.desfecho, "executada");
    assert.equal(detalhe.requisicao.resultado.nrProsp, "2585");
    assert.ok(detalhe.requisicao.resultado.calculoOficial, "cálculo oficial anexado");

    // Auditoria completa: requisitante + aprovador, início e conclusão.
    const acoes = detalhe.historico.map((e: { acao: string; ator: string }) => [e.acao, e.ator]);
    assert.deepEqual(acoes, [
      ["requisicao_criada", "maria.silva"],
      ["transicao_estado", "joao.souza"],
      ["execucao_iniciada", "joao.souza"],
      ["transicao_estado", "joao.souza"],
    ]);
  });

  test("divergência entre referência e cálculo oficial NÃO bloqueia (oficial vence) e fica registrada", async () => {
    const cpf = "93000000003";
    const id = await criarPendenteProposta(cpf);
    // Na aprovação, a Sinqia devolve parcela diferente da referência.
    responderCalculoOficial = async () => calcResultOk({ vlPresta: 420.11 });

    const r = await decidir(id, sidJoao, "aprovar");
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().requisicao.estado, "executada");

    const detalhe = (await get(`/api/sod/requisicoes/${id}`, sidJoao)).json();
    const divs = detalhe.requisicao.resultado.divergenciasReferencia;
    assert.ok(Array.isArray(divs) && divs.length > 0, "divergência registrada no resultado");
    assert.equal(divs[0].campo, "vlPresta");
    // A criação foi com o cálculo OFICIAL, não com a referência.
    assert.equal(execucoes[execucoes.length - 1].item.calculo.vlPresta, 420.11);
  });
});

describe("US-04 — Cenário 3: duplicidade (RN04) e guarda Sinqia na execução", () => {
  test("requisição pendente equivalente bloqueia com 409; proposta diferente do mesmo CPF passa", async () => {
    const cpf = "93000000004";
    const primeira = await criarPendenteProposta(cpf);

    // MESMOS insumos → mesma assinatura → bloqueio com a pendente apontada.
    const calcId = await calcular(cpf);
    const dup = await criarUmaHttp(calcId);
    assert.equal(dup.statusCode, 409, dup.body);
    assert.equal(dup.json().code, "DUPLICIDADE_PENDENTE");
    assert.equal(dup.json().requisicaoExistente.id, primeira);
    assert.ok(
      dup.json().error.includes("mesma assinatura"),
      "mensagem explica a chave no vocabulário do negócio",
    );

    // Proposta DIFERENTE (outros valores → outra assinatura) do MESMO CPF passa.
    responderCalculoMaker = async () => calcResultOk({ vlPresta: 999.99, vlContra: 12000 });
    const calcId2 = await calcular(cpf);
    const outra = await criarUmaHttp(calcId2);
    assert.equal(outra.statusCode, 201, outra.body);
  });

  test("estados terminais não bloqueiam: reprovada libera nova requisição igual", async () => {
    const cpf = "93000000005";
    const primeira = await criarPendenteProposta(cpf);
    const rep = await decidir(primeira, sidJoao, "reprovar", "valores a revisar");
    assert.equal(rep.statusCode, 200, rep.body);

    const calcId = await calcular(cpf);
    const denovo = await criarUmaHttp(calcId);
    assert.equal(denovo.statusCode, 201, denovo.body);
  });

  test("guarda existente na EXECUÇÃO (proposta idêntica na Sinqia) → falha duplicidade, nada criado", async () => {
    const cpf = "93000000006";
    const id = await criarPendenteProposta(cpf);
    responderCriacao = async (item) => ({
      ...criacaoOk(item),
      nrProsp: null,
      status: "JA_EXISTE",
      detail: "Proposta idêntica já existe para este cliente: nº 2500.",
    });

    const r = await decidir(id, sidJoao, "aprovar");
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().requisicao.estado, "falha");

    const detalhe = (await get(`/api/sod/requisicoes/${id}`, sidJoao)).json();
    assert.equal(detalhe.requisicao.resultado.causa, "duplicidade_sinqia");
    assert.ok(String(detalhe.requisicao.resultado.detalhe).includes("2500"));
  });
});

describe("US-04 — Cenário 4: falhas da execução, distinguíveis, sem retry", () => {
  test("cálculo oficial reprovado → falha `calculo_reprovado`, criação NUNCA chamada", async () => {
    const cpf = "93000000007";
    const id = await criarPendenteProposta(cpf);
    const antesCalc = calculosOficiais.length;
    const antesExec = execucoes.length;
    responderCalculoOficial = async () => ({
      httpStatus: 422,
      calculo: null,
      analysis: {
        ok: false,
        envelopeStatus: "ERRO",
        messagesText: "Erro | Prazo indisponível para o produto",
        messages: [],
        reason: "Envelope com status ERRO.",
      },
    });

    const r = await decidir(id, sidJoao, "aprovar");
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().requisicao.estado, "falha");
    assert.equal(calculosOficiais.length, antesCalc + 1, "sem retry automático");
    assert.equal(execucoes.length, antesExec, "nada foi criado");

    const detalhe = (await get(`/api/sod/requisicoes/${id}`, sidJoao)).json();
    assert.equal(detalhe.requisicao.resultado.causa, "calculo_reprovado");
    assert.equal(detalhe.requisicao.resultado.etapa, "calculo");
    assert.ok(String(detalhe.requisicao.resultado.mensagens).includes("Prazo indisponível"));
  });

  test("erro de negócio na criação → falha `erro_negocio` com erro integral", async () => {
    const cpf = "93000000008";
    const id = await criarPendenteProposta(cpf);
    responderCriacao = async (item) => ({
      ...criacaoOk(item),
      nrProsp: null,
      status: "ERRO",
      httpStatus: 200,
      envelopeStatus: "ERRO",
      messages: "Erro | Convênio bloqueado para emissão",
      detail: "Envelope com status ERRO.",
    });

    const r = await decidir(id, sidJoao, "aprovar");
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().requisicao.estado, "falha");

    const detalhe = (await get(`/api/sod/requisicoes/${id}`, sidJoao)).json();
    assert.equal(detalhe.requisicao.resultado.causa, "erro_negocio");
    assert.ok(String(detalhe.requisicao.resultado.mensagens).includes("Convênio bloqueado"));
  });

  test("timeout/indisponibilidade no cálculo → falha `indisponibilidade_ou_timeout` na etapa calculo", async () => {
    const cpf = "93000000009";
    const id = await criarPendenteProposta(cpf);
    const antesExec = execucoes.length;
    responderCalculoOficial = async () => {
      throw new Error("Headers Timeout Error (fixture)");
    };

    const r = await decidir(id, sidJoao, "aprovar");
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().requisicao.estado, "falha");
    assert.equal(execucoes.length, antesExec, "nada foi criado");

    const detalhe = (await get(`/api/sod/requisicoes/${id}`, sidJoao)).json();
    assert.equal(detalhe.requisicao.resultado.causa, "indisponibilidade_ou_timeout");
    assert.equal(detalhe.requisicao.resultado.etapa, "calculo");
  });

  test("sessão expira DURANTE a criação → falha com causa + 401 orientando reautenticação", async () => {
    // Sessão dedicada: este teste DESTRÓI a sessão do aprovador.
    const sidCarlos = createSession("carlos.melo", "token-carlos").id;
    const cpf = "93000000010";
    const id = await criarPendenteProposta(cpf);
    responderCriacao = async () => {
      throw new SessaoExpiradaError();
    };

    const r = await decidir(id, sidCarlos, "aprovar");
    assert.equal(r.statusCode, 401);
    assert.equal(r.json().code, "SESSAO_EXPIRADA");
    assert.equal(r.json().requisicao.estado, "falha");

    const detalhe = (await get(`/api/sod/requisicoes/${id}`, sidJoao)).json();
    assert.equal(detalhe.requisicao.resultado.causa, "sessao_expirada_durante_execucao");
    assert.equal(getSession(sidCarlos).ok, false, "sessão do aprovador destruída");
  });
});

describe("US-04 — RN05: pré-condições do tomador na criação da requisição", () => {
  test("tomador inexistente no ambiente → 422 com orientação de cadastro", async () => {
    const cpf = "93000000011"; // NÃO entra em clientesExistentes
    const calcId = await calcular(cpf);
    const r = await criarUmaHttp(calcId);
    assert.equal(r.statusCode, 422, r.body);
    assert.equal(r.json().code, "TOMADOR_INEXISTENTE");
    assert.ok(r.json().error.includes("cadastre o tomador antes"));
  });

  test("tomador em requisição pendente → 409 'aguarde a aprovação do tomador'", async () => {
    const cpf = "93000000012";
    clientesExistentes.add(cpf); // existe na Sinqia, mas a EDIÇÃO dele está pendente
    // Requisição pendente de tomador criada pelo caminho real da US-02.
    const rTomador = await post("/api/cadastrar", sidMaria, {
      campos: { ...EXEMPLO_PF, nrCpfCnpj: cpf },
      control: {},
      dryRun: false,
    });
    assert.equal(rTomador.statusCode, 201, rTomador.body);

    const calcId = await calcular(cpf);
    const r = await criarUmaHttp(calcId);
    assert.equal(r.statusCode, 409, r.body);
    assert.equal(r.json().code, "TOMADOR_PENDENTE");
    assert.ok(r.json().error.includes("aguarde a aprovação do tomador"));
    assert.equal(r.json().requisicaoTomador.id, rTomador.json().requisicao.id);
  });
});

describe("US-04 — maker-checker, concorrência e pré-verificação (suíte da US-03 espelhada)", () => {
  test("criador não decide a própria requisição de proposta → 403 auditado", async () => {
    const cpf = "93000000013";
    const id = await criarPendenteProposta(cpf);
    const antesExec = execucoes.length;

    for (const decisao of ["aprovar", "reprovar"]) {
      const r = await decidir(id, sidMaria, decisao, "tentando decidir a minha própria");
      assert.equal(r.statusCode, 403);
      assert.equal(r.json().code, "VIOLACAO_SOD");
    }
    assert.equal(execucoes.length, antesExec, "nenhuma execução");

    const detalhe = (await get(`/api/sod/requisicoes/${id}`, sidMaria)).json();
    assert.equal(detalhe.requisicao.estado, "pendente");
  });

  test("reprovação com motivo: transição pura — zero cálculo, zero criação, nem sonda", async () => {
    const cpf = "93000000014";
    const id = await criarPendenteProposta(cpf);
    const antes = [calculosOficiais.length, execucoes.length, sondagens];

    const r = await decidir(id, sidJoao, "reprovar", "condições comerciais divergentes");
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().requisicao.estado, "reprovada");
    assert.deepEqual([calculosOficiais.length, execucoes.length, sondagens], antes);
  });

  test("duas aprovações concorrentes → primeira vence, UMA única execução", async () => {
    const cpf = "93000000015";
    const id = await criarPendenteProposta(cpf);
    const antesExec = execucoes.length;
    const antesCalc = calculosOficiais.length;

    const [a, b] = await Promise.all([
      decidir(id, sidJoao, "aprovar"),
      decidir(id, sidAna, "aprovar"),
    ]);
    const codigos = [a.statusCode, b.statusCode].sort();
    assert.deepEqual(codigos, [200, 409], "uma vence, a outra recebe 409");
    const perdedora = [a, b].find((r) => r.statusCode === 409)!;
    assert.equal(perdedora.json().code, "TRANSICAO_INVALIDA");
    assert.ok(perdedora.json().decididoPor, "perdedora sabe quem decidiu");

    assert.equal(execucoes.length, antesExec + 1, "EXATAMENTE UMA criação");
    assert.equal(calculosOficiais.length, antesCalc + 1, "EXATAMENTE UM cálculo oficial");
  });

  test("RN03: sessão Sinqia inválida na sonda → 401 sem transição; indisponível → 502", async () => {
    const sidRita = createSession("rita.nunes", "token-rita").id;
    const cpf = "93000000016";
    const id = await criarPendenteProposta(cpf);
    const antes = [calculosOficiais.length, execucoes.length];

    sessaoSinqia = "invalida";
    const r1 = await decidir(id, sidRita, "aprovar");
    assert.equal(r1.statusCode, 401);
    assert.equal(getSession(sidRita).ok, false);

    sessaoSinqia = "indisponivel";
    const r2 = await decidir(id, sidJoao, "aprovar");
    assert.equal(r2.statusCode, 502);
    assert.equal(getSession(sidJoao).ok, true, "sessão local preservada");

    assert.deepEqual([calculosOficiais.length, execucoes.length], antes, "zero Sinqia");
    const detalhe = (await get(`/api/sod/requisicoes/${id}`, sidJoao)).json();
    assert.equal(detalhe.requisicao.estado, "pendente", "NENHUMA transição");

    // Sonda válida de novo: a mesma requisição segue aprovável.
    sessaoSinqia = "valida";
    const depois = await decidir(id, sidJoao, "aprovar");
    assert.equal(depois.statusCode, 200);
    assert.equal(depois.json().requisicao.estado, "executada");
  });

  test("cancelamento pelo criador funciona para o novo tipo", async () => {
    const cpf = "93000000017";
    const id = await criarPendenteProposta(cpf);
    const r = await decidir(id, sidMaria, "cancelar");
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().requisicao.estado, "cancelada");
  });
});

describe("US-04 — regressão: fluxo direto de proposta com toggle OFF", () => {
  test("criar-uma volta a criar direto (criarUma do fluxo direto), sem requisição", async () => {
    toggleProposta = false;
    const cpf = "93000000018";
    clientesExistentes.add(cpf);
    const antesDiretas = criacoesDiretas.length;
    const antesTotal = (
      await get("/api/sod/requisicoes?tipo=proposta.criar&limit=1", sidMaria)
    ).json().total;

    const calcId = await calcular(cpf);
    const r = await criarUmaHttp(calcId);
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().status, "OK");
    assert.equal(r.json().nrProsp, "2585");
    assert.equal(criacoesDiretas.length, antesDiretas + 1, "fluxo direto chamado");
    assert.equal(criacoesDiretas[antesDiretas].token, "token-maria");

    const depoisTotal = (
      await get("/api/sod/requisicoes?tipo=proposta.criar&limit=1", sidMaria)
    ).json().total;
    assert.equal(depoisTotal, antesTotal, "nenhuma requisição criada");
  });

  test("/api/env expõe o toggle do novo tipo para a UI", async () => {
    toggleProposta = true;
    const r = await get("/api/env", null);
    assert.equal(r.json().aprovacao.criacaoPropostaIndividual, true);
    assert.equal(r.json().aprovacao.cadastroTomadorIndividual, true);
  });
});
