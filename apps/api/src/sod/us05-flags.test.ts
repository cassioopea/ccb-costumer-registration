import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import type { CalcProspResult } from "./../sinqia-client.js";
import type { CriacaoItem, CriacaoRowResult } from "./../criacao-job.js";

/**
 * US-05 — Feature flag definitiva por tipo de ação + corte das ações diretas.
 *
 * Cobre os cenários da história ponta a ponta no BFF, offline, com a flag
 * REAL (tabela sod_flags lida em runtime — `servico.flagAtiva` injetado como
 * `aprovacaoAtivaFn`, o mesmo caminho do runtime):
 *  1. flag ativa (tomador) → requisição em vez de execução, para QUALQUER
 *     usuário; guard centralizado responde o erro estável ACAO_SOB_APROVACAO
 *     sem tocar a Sinqia (rota "esquecida" simulada); UI lê o corte no /api/env;
 *  2. flag inativa (proposta) → fluxo direto byte-a-byte; flags INDEPENDENTES
 *     (tomador ativa + proposta inativa simultâneas);
 *  3. desativar flag com pendentes → pendentes seguem decidíveis (aprovar
 *     executa; reprovar/cancelar ok); nada executa/apaga sozinho; ações novas
 *     voltam ao fluxo direto;
 *  4. mudança EFETIVA → evento de auditoria completo (tipo, anterior, novo,
 *     timestamp, ator); repetição do mesmo valor não grava nada;
 *  + matriz {tomador, proposta} × {ON, OFF} × {UI(/api/env), rota BFF},
 *    persistência da flag a restart (reabertura do banco) e escopo Onda 1
 *    (tipos da Onda 2 nunca sob aprovação, mesmo com linha forjada).
 */
process.env.SINQIA_BASE_URL ??= "https://sinqia.fixture.invalid";
process.env.SINQIA_ENV ??= "hml";

const dir = mkdtempSync(path.join(tmpdir(), "sod-us05-"));
process.env.SQLITE_PATH = path.join(dir, "app.db");

const { EXEMPLO_PF } = await import("@cadastro-lote/shared");
const { abrirBancoSod, criarSodRepositorio, ACAO_FLAG_ALTERADA } = await import(
  "./repositorio.js"
);
const { criarSodServico } = await import("./dominio.js");
const { registerSodRoutes } = await import("./rotas.js");
const { registerRoutes } = await import("./../routes.js");
const { registerPropostasRoutes } = await import("./../routes-propostas.js");
const { aprovacaoAtiva, resolverTipoComFlag, TIPOS_COM_FLAG } = await import("./flags.js");
const { guardarExecucaoDireta, CODIGO_CORTE_SOD } = await import("./corte.js");
const { createSession, limparSessoes } = await import("./../session.js");

let app: FastifyInstance;
let db: ReturnType<typeof abrirBancoSod>;
let servico: ReturnType<typeof criarSodServico>;
let sidMaria: string; // requisitante
let sidJoao: string; // aprovador / "qualquer usuário"
let sidAna: string;

/** A flag REAL do banco — o mesmo caminho do runtime (flags.ts → flagAtiva). */
const aprovacaoAtivaDb = (tipo: Parameters<typeof aprovacaoAtiva>[0]) =>
  servico.flagAtiva(tipo);

/** Atalho de operação: muda a flag como o CLI faz (domínio → repo auditado). */
function flag(tipo: "tomador.cadastrar" | "proposta.criar", ativa: boolean) {
  return servico.definirFlag(tipo, ativa, "seguranca.ops");
}

/* ---- Spies das execuções DIRETAS (com flag ativa, jamais chamados) ---- */
const cadastrosDiretos: Array<{ token: string }> = [];
const criacoesDiretas: Array<{ token: string }> = [];
/** Rota "esquecida" (sem desvio): execuções que passariam do guard. */
const execucoesEsquecidas: string[] = [];

/* ---- Spies do lado do APROVADOR (execução B2' — Cenário 3) ---- */
const execucoesTomador: Array<{ token: string }> = [];

const analysisOk = { ok: true, envelopeStatus: "OK", messagesText: "", messages: [] };

function calculoFixture() {
  const vlPresta = 416.78;
  return {
    vlLiquid: 4600,
    vlPresta,
    vlIof: 38.9,
    vlContra: 5001.36,
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

const calcResultOk = (): CalcProspResult => ({
  httpStatus: 200,
  calculo: calculoFixture(),
  analysis: analysisOk,
});

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

before(async () => {
  db = abrirBancoSod(path.join(dir, "sod.db"));
  servico = criarSodServico(criarSodRepositorio(db, "hml"));

  app = Fastify();
  await app.register(cookie);
  await registerRoutes(app, {
    cadastrarClienteFn: async (token) => {
      cadastrosDiretos.push({ token });
      return { httpStatus: 200, envelope: null, analysis: analysisOk };
    },
    sodServico: () => servico,
    aprovacaoAtivaFn: aprovacaoAtivaDb,
  });
  await registerPropostasRoutes(app, {
    calcProspFn: async () => calcResultOk(),
    buscarClientePorCpfFn: async () => ({
      httpStatus: 200,
      encontrado: true,
      nrClient: 4242,
      dsNome: "Tomador Fixture",
    }),
    criarUmaFn: async (token, item) => {
      criacoesDiretas.push({ token });
      return criacaoOk(item);
    },
    sodServico: () => servico,
    aprovacaoAtivaFn: aprovacaoAtivaDb,
  });
  await registerSodRoutes(app, servico, {
    verificarSessaoSinqiaFn: async () => "valida",
    cadastrarClienteFn: async (token) => {
      execucoesTomador.push({ token });
      return { httpStatus: 200, envelope: null, analysis: analysisOk };
    },
    calcProspFn: async () => calcResultOk(),
    criarUmaFn: async (_token, item) => criacaoOk(item),
  });

  // Rota FUTURA hipotética que "esqueceu" o desvio para requisição: prova que
  // o guard centralizado, sozinho, corta a execução direta (Cenário 1, RN01).
  app.post("/api/_fixture/execucao-direta-sem-desvio", async (_req, reply) => {
    if (guardarExecucaoDireta("tomador.cadastrar", reply, aprovacaoAtivaDb)) return;
    execucoesEsquecidas.push("chamada-sinqia");
    return reply.send({ executouDireto: true });
  });
  await app.ready();

  limparSessoes();
  sidMaria = createSession("Maria.SILVA", "token-maria").id;
  sidJoao = createSession("joao.souza", "token-joao").id;
  sidAna = createSession("ana.lima", "token-ana").id;
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

function bodyCadastro(documento: string) {
  return { campos: { ...EXEMPLO_PF, nrCpfCnpj: documento }, control: {}, dryRun: false };
}

const PARAMS_CALC = { txJuros: 1.9, cdProd: 80, idCarCtr: 31, dtContra: 20260801 };
const PARAMS_CRIACAO = { ...PARAMS_CALC, cdConven: "1", cdLoja: 5 };

/** Fluxo real da proposta individual: calcular-uma → criar-uma. */
async function criarUmaProposta(cpf: string, sid = sidMaria) {
  const calc = await post("/api/propostas/calcular-uma", sid, {
    cpf,
    nome: "Tomador Fixture",
    dados: { vlLiquido: 4600, qtParcelas: 12, dtVct1Ap: 20260901, vlTac: 350 },
    params: PARAMS_CALC,
  });
  assert.equal(calc.statusCode, 200, calc.body);
  return post("/api/propostas/criar-uma", sid, {
    calcId: calc.json().calcId,
    params: PARAMS_CRIACAO,
    forcarDuplicada: false,
  });
}

async function totalRequisicoes(): Promise<number> {
  return (await get("/api/sod/requisicoes?limit=1", sidMaria)).json().total as number;
}

describe("US-05 — estado padrão (RN07): flags INATIVAS, fluxo direto intacto", () => {
  test("banco recém-criado → ambas inativas no banco e no /api/env; execução segue direta", async () => {
    assert.equal(servico.flagAtiva("tomador.cadastrar"), false);
    assert.equal(servico.flagAtiva("proposta.criar"), false);

    const envR = (await get("/api/env", null)).json();
    assert.equal(envR.aprovacao.cadastroTomadorIndividual, false);
    assert.equal(envR.aprovacao.criacaoPropostaIndividual, false);

    const antes = cadastrosDiretos.length;
    const r = await post("/api/cadastrar", sidMaria, bodyCadastro("95000000001"));
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().status, "OK");
    assert.equal(cadastrosDiretos.length, antes + 1, "fluxo direto executou");
    assert.equal(await totalRequisicoes(), 0, "nenhuma requisição criada");
  });
});

describe("US-05 — Cenário 1: flag ativa (tomador) corta o caminho direto para qualquer usuário", () => {
  test("submissão vira requisição (zero Sinqia) para usuários DIFERENTES; UI lê o corte no /api/env", async () => {
    flag("tomador.cadastrar", true);

    const envR = (await get("/api/env", null)).json();
    assert.equal(envR.aprovacao.cadastroTomadorIndividual, true, "UI conduz à requisição + selo");

    const antes = cadastrosDiretos.length;
    for (const [sid, doc] of [
      [sidMaria, "95000000002"],
      [sidJoao, "95000000003"],
      [sidAna, "95000000004"],
    ] as const) {
      const r = await post("/api/cadastrar", sid, bodyCadastro(doc));
      assert.equal(r.statusCode, 201, r.body);
      assert.equal(r.json().aprovacao, true);
      assert.equal(r.json().requisicao.estado, "pendente");
    }
    assert.equal(cadastrosDiretos.length, antes, "ZERO chamadas à Sinqia — para qualquer usuário");
  });

  test("guard centralizado: rota de execução direta responde o erro estável, sem chamada Sinqia", async () => {
    flag("tomador.cadastrar", true);
    const antes = execucoesEsquecidas.length;

    const r = await post("/api/_fixture/execucao-direta-sem-desvio", sidJoao, {});
    assert.equal(r.statusCode, 409);
    assert.equal(r.json().code, CODIGO_CORTE_SOD);
    assert.equal(r.json().tipo, "tomador.cadastrar");
    assert.ok(r.json().error.includes("ação sob aprovação obrigatória"), r.body);
    assert.ok(r.json().error.includes("crie uma requisição"), r.body);
    assert.equal(execucoesEsquecidas.length, antes, "spy Sinqia intocado");

    // Flag inativa → o guard libera (a rota executa normalmente).
    flag("tomador.cadastrar", false);
    const livre = await post("/api/_fixture/execucao-direta-sem-desvio", sidJoao, {});
    assert.equal(livre.statusCode, 200);
    assert.equal(execucoesEsquecidas.length, antes + 1);
  });
});

describe("US-05 — Cenário 2: flag inativa (proposta) mantém o fluxo direto byte-a-byte; flags independentes", () => {
  test("tomador ATIVA + proposta INATIVA simultâneas: proposta executa direto, resposta idêntica à de antes", async () => {
    flag("tomador.cadastrar", true);
    flag("proposta.criar", false);

    const envR = (await get("/api/env", null)).json();
    assert.equal(envR.aprovacao.cadastroTomadorIndividual, true);
    assert.equal(envR.aprovacao.criacaoPropostaIndividual, false, "flags independentes");

    const antesDiretas = criacoesDiretas.length;
    const antesReq = await totalRequisicoes();
    const r = await criarUmaProposta("95000000010");
    assert.equal(r.statusCode, 200, r.body);
    // Byte-a-byte: o corpo é EXATAMENTE o contrato do fluxo direto (env + resultado).
    assert.deepEqual(r.json(), {
      env: "hml",
      linha: 1,
      nome: "Tomador Fixture",
      cpf: "95000000010",
      nrClient: 4242,
      nrProsp: "2585",
      status: "OK",
      httpStatus: 200,
      envelopeStatus: "OK",
      globalMessage: "",
      messages: "Sucesso | 2585",
    });
    assert.equal(criacoesDiretas.length, antesDiretas + 1, "criação direta na sessão do usuário");
    assert.equal(criacoesDiretas[antesDiretas].token, "token-maria");
    assert.equal(await totalRequisicoes(), antesReq, "nenhuma requisição criada");
  });

  test("independência no sentido inverso: proposta ATIVA + tomador INATIVA", async () => {
    flag("tomador.cadastrar", false);
    flag("proposta.criar", true);

    const antesCad = cadastrosDiretos.length;
    const rTomador = await post("/api/cadastrar", sidMaria, bodyCadastro("95000000011"));
    assert.equal(rTomador.statusCode, 200, rTomador.body);
    assert.equal(cadastrosDiretos.length, antesCad + 1, "tomador segue direto");

    const antesProp = criacoesDiretas.length;
    const rProposta = await criarUmaProposta("95000000012");
    assert.equal(rProposta.statusCode, 201, rProposta.body);
    assert.equal(rProposta.json().aprovacao, true, "proposta vira requisição");
    assert.equal(criacoesDiretas.length, antesProp, "zero criações diretas");
  });
});

describe("US-05 — Cenário 3: desativar flag NÃO afeta requisições existentes (RN04)", () => {
  test("pendentes criadas com flag ativa seguem decidíveis após desativar; novas ações vão direto", async () => {
    flag("tomador.cadastrar", true);
    const ids: string[] = [];
    for (const doc of ["95000000020", "95000000021", "95000000022"]) {
      const r = await post("/api/cadastrar", sidMaria, bodyCadastro(doc));
      assert.equal(r.statusCode, 201, r.body);
      ids.push(r.json().requisicao.id);
    }

    // Desativa a flag COM as pendentes vivas.
    flag("tomador.cadastrar", false);

    // Nada foi executado nem apagado automaticamente.
    for (const id of ids) {
      const detalhe = (await get(`/api/sod/requisicoes/${id}`, sidJoao)).json();
      assert.equal(detalhe.requisicao.estado, "pendente", "pendente intacta após desativar");
    }

    // Aprovar EXECUTA (B2', na sessão do aprovador), mesmo com a flag inativa.
    const antesExec = execucoesTomador.length;
    const aprova = await post(`/api/sod/requisicoes/${ids[0]}/decisao`, sidJoao, {
      decisao: "aprovar",
    });
    assert.equal(aprova.statusCode, 200, aprova.body);
    assert.equal(aprova.json().requisicao.estado, "executada");
    assert.equal(execucoesTomador.length, antesExec + 1);
    assert.equal(execucoesTomador[antesExec].token, "token-joao");

    // Reprovar e cancelar também seguem valendo.
    const reprova = await post(`/api/sod/requisicoes/${ids[1]}/decisao`, sidJoao, {
      decisao: "reprovar",
      motivo: "dados a revisar",
    });
    assert.equal(reprova.statusCode, 200, reprova.body);
    assert.equal(reprova.json().requisicao.estado, "reprovada");

    const cancela = await post(`/api/sod/requisicoes/${ids[2]}/decisao`, sidMaria, {
      decisao: "cancelar",
    });
    assert.equal(cancela.statusCode, 200, cancela.body);
    assert.equal(cancela.json().requisicao.estado, "cancelada");

    // Ação NOVA com a flag inativa volta ao fluxo direto, sem requisição nova.
    const antesCad = cadastrosDiretos.length;
    const antesReq = await totalRequisicoes();
    const novo = await post("/api/cadastrar", sidMaria, bodyCadastro("95000000023"));
    assert.equal(novo.statusCode, 200, novo.body);
    assert.equal(cadastrosDiretos.length, antesCad + 1);
    assert.equal(await totalRequisicoes(), antesReq);
  });
});

describe("US-05 — Cenário 4: auditoria da mudança de flag (RN05)", () => {
  async function eventosFlag() {
    const r = (await get("/api/sod/auditoria?ator=seguranca.ops&limit=200", sidMaria)).json();
    return r.itens.filter((e: { acao: string }) => e.acao === ACAO_FLAG_ALTERADA);
  }

  test("mudança efetiva grava evento completo; repetir o mesmo valor não grava nada", async () => {
    flag("proposta.criar", false); // estado conhecido
    const antes = (await eventosFlag()).length;

    // Mudança EFETIVA (ator com caixa/espaço de propósito: normalização RN05).
    const r1 = servico.definirFlag("proposta.criar", true, "  Seguranca.OPS ");
    assert.deepEqual(r1, { mudou: true, anterior: false });

    const eventos = await eventosFlag();
    assert.equal(eventos.length, antes + 1);
    const evento = eventos[eventos.length - 1];
    assert.equal(evento.ator, "seguranca.ops", "login normalizado");
    assert.deepEqual(evento.detalhe, {
      tipo: "proposta.criar",
      anterior: false,
      novo: true,
    });
    assert.ok(!Number.isNaN(Date.parse(evento.ts)), "timestamp ISO válido");
    assert.equal(evento.requisicaoId, null, "evento de flag não referencia requisição");

    // Repetição do MESMO valor: sem mudança efetiva → nada gravado.
    const r2 = servico.definirFlag("proposta.criar", true, "seguranca.ops");
    assert.deepEqual(r2, { mudou: false, anterior: true });
    assert.equal((await eventosFlag()).length, antes + 1, "nenhum evento novo");

    // Desativação: novo evento com anterior/novo invertidos.
    const r3 = servico.definirFlag("proposta.criar", false, "seguranca.ops");
    assert.deepEqual(r3, { mudou: true, anterior: true });
    const finais = await eventosFlag();
    assert.equal(finais.length, antes + 2);
    assert.deepEqual(finais[finais.length - 1].detalhe, {
      tipo: "proposta.criar",
      anterior: true,
      novo: false,
    });
  });

  test("mudança de flag exige ator (auditoria nunca fica sem autor)", () => {
    assert.throws(
      () => servico.definirFlag("tomador.cadastrar", true, "   "),
      /login de quem muda/,
    );
  });
});

describe("US-05 — matriz de regressão {tipo} × {flag} × {UI, rota BFF}", () => {
  test("os quatro quadrantes respondem o comportamento esperado", async () => {
    // Quadrante 1: tomador ON → BFF cria requisição; /api/env expõe o corte.
    flag("tomador.cadastrar", true);
    flag("proposta.criar", false);
    let envR = (await get("/api/env", null)).json();
    assert.equal(envR.aprovacao.cadastroTomadorIndividual, true);
    const q1 = await post("/api/cadastrar", sidMaria, bodyCadastro("95000000030"));
    assert.equal(q1.statusCode, 201);
    assert.equal(q1.json().aprovacao, true);

    // Quadrante 2: proposta OFF (simultâneo) → fluxo direto.
    assert.equal(envR.aprovacao.criacaoPropostaIndividual, false);
    const q2 = await criarUmaProposta("95000000031");
    assert.equal(q2.statusCode, 200);
    assert.equal(q2.json().status, "OK");

    // Quadrante 3: tomador OFF → fluxo direto.
    flag("tomador.cadastrar", false);
    flag("proposta.criar", true);
    envR = (await get("/api/env", null)).json();
    assert.equal(envR.aprovacao.cadastroTomadorIndividual, false);
    const q3 = await post("/api/cadastrar", sidMaria, bodyCadastro("95000000032"));
    assert.equal(q3.statusCode, 200);
    assert.equal(q3.json().status, "OK");

    // Quadrante 4: proposta ON (simultâneo) → requisição.
    assert.equal(envR.aprovacao.criacaoPropostaIndividual, true);
    const q4 = await criarUmaProposta("95000000033");
    assert.equal(q4.statusCode, 201);
    assert.equal(q4.json().aprovacao, true);

    // Estado de deploy (RN07): tudo desligado ao final.
    flag("proposta.criar", false);
  });

  test("escopo: tipos ainda NÃO entregues NUNCA sob aprovação — nem com linha forjada na tabela", async () => {
    // Linha forjada direto no banco que o runtime real usa (env.SQLITE_PATH):
    // mesmo assim, aprovacaoAtiva (flags.ts, com TIPOS_COM_FLAG) devolve false.
    // (Na entrega da US-05 o exemplo era tomador.cadastrar_lote; cada US da
    // Onda 2 traz o seu tipo para o corte — o exemplo acompanha os seguintes.)
    const dbApp = abrirBancoSod(process.env.SQLITE_PATH!);
    try {
      const repoApp = criarSodRepositorio(dbApp, "hml");
      repoApp.definirFlag({
        tipo: "proposta.movimentar",
        ativa: true,
        ator: "seguranca.ops",
        agora: new Date().toISOString(),
      });
      assert.equal(aprovacaoAtiva("proposta.movimentar"), false, "US-08 fora do corte");
      assert.equal(aprovacaoAtiva("proposta.movimentar_massa"), false);

      // E o caminho REAL de ponta a ponta funciona para os tipos da Onda 1:
      // linha na tabela → aprovacaoAtiva default (sodServicoPadrao) → true.
      repoApp.definirFlag({
        tipo: "tomador.cadastrar",
        ativa: true,
        ator: "seguranca.ops",
        agora: new Date().toISOString(),
      });
      assert.equal(aprovacaoAtiva("tomador.cadastrar"), true, "cadeia real DB → flags.ts");
      repoApp.definirFlag({
        tipo: "tomador.cadastrar",
        ativa: false,
        ator: "seguranca.ops",
        agora: new Date().toISOString(),
      });
      assert.equal(aprovacaoAtiva("tomador.cadastrar"), false);
    } finally {
      dbApp.close();
    }
  });

  test("resolverTipoComFlag (CLI): aceita tipo e chave de negócio; rejeita o resto", () => {
    assert.equal(resolverTipoComFlag("tomador.cadastrar"), "tomador.cadastrar");
    assert.equal(
      resolverTipoComFlag("aprovacao.cadastro_tomador_individual"),
      "tomador.cadastrar",
    );
    assert.equal(resolverTipoComFlag(" APROVACAO.CRIACAO_PROPOSTA_INDIVIDUAL "), "proposta.criar");
    assert.equal(
      resolverTipoComFlag("tomador.cadastrar_lote"),
      "tomador.cadastrar_lote",
      "US-06 sob flag",
    );
    assert.equal(
      resolverTipoComFlag("aprovacao.cadastro_tomador_lote"),
      "tomador.cadastrar_lote",
    );
    assert.equal(
      resolverTipoComFlag("proposta.criar_lote"),
      "proposta.criar_lote",
      "US-07 sob flag",
    );
    assert.equal(
      resolverTipoComFlag("aprovacao.criacao_proposta_lote"),
      "proposta.criar_lote",
    );
    assert.equal(resolverTipoComFlag("proposta.movimentar"), null, "US-08 sem flag");
    assert.equal(resolverTipoComFlag("qualquer.coisa"), null);
    assert.deepEqual(
      [...TIPOS_COM_FLAG],
      ["tomador.cadastrar", "proposta.criar", "tomador.cadastrar_lote", "proposta.criar_lote"],
    );
  });
});

describe("US-05 — persistência: flag sobrevive a restart (reabertura do banco)", () => {
  test("definir, fechar e reabrir → estado preservado; auditoria não duplica no boot", async () => {
    const arquivo = path.join(dir, "flags-restart.db");
    let db1 = abrirBancoSod(arquivo);
    const repo1 = criarSodRepositorio(db1, "hml");
    repo1.definirFlag({
      tipo: "tomador.cadastrar",
      ativa: true,
      ator: "seguranca.ops",
      agora: new Date().toISOString(),
    });
    db1.close();

    // "Restart": nova conexão, mesmo arquivo (criarSchemaSod roda de novo).
    db1 = abrirBancoSod(arquivo);
    const repo2 = criarSodRepositorio(db1, "hml");
    assert.equal(repo2.flagAtiva("tomador.cadastrar"), true, "flag preservada");
    const eventos = repo2.listarEventos({ limit: 200, offset: 0 });
    assert.equal(
      eventos.itens.filter((e) => e.acao === ACAO_FLAG_ALTERADA).length,
      1,
      "reabrir o banco NÃO gera evento novo (mudança efetiva só no ponto de mudança)",
    );
    db1.close();
  });
});
