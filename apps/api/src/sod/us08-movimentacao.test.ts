import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
// Imports SOMENTE de tipo: apagados na compilação, não disparam o load do env.ts.
import type { TransfStatusInput, TransicaoStatus } from "./../sinqia-client.js";

/**
 * US-08 — Movimentação individual de proposta entre etapas (SoD).
 *
 * Cobre os cenários da história ponta a ponta no BFF, offline (Sinqia
 * simulada por spies nas deps injetáveis de registerPropostasRoutes e
 * registerSodRoutes):
 *  1. flag ON + mover → requisição `pendente` com o payload da RN02 (dados da
 *     movimentação + request EXATO do transfStatus), ZERO transfStatus na
 *     Sinqia, indicador agregado com "pendente (→ destino)";
 *  2. aprovação por OUTRO operador → verificação do status atual + transfStatus
 *     na SESSÃO DO APROVADOR (token verificado por spy) com o request
 *     persistido → `executada`, indicador some, bloqueio liberado;
 *  3. bloqueio por proposta: segunda requisição → 409 MOVIMENTACAO_BLOQUEADA;
 *     corrida de criação simultânea → exatamente uma vence (índice no banco,
 *     inclusive contra requisição em `falha`); terminal/cancelada libera;
 *     `falha` MANTÉM o bloqueio;
 *  4. divergência externa (proposta movida por fora) → `falha` com resposta
 *     integral + etapas válidas capturadas, transfStatus NUNCA chamado,
 *     auditoria completa; rejeição da própria Sinqia → `falha` integral;
 *  + regressão (flag OFF → fluxo direto intacto; guard de corte) e medição do
 *    endpoint agregado do indicador (requisito de performance do painel).
 */
process.env.SINQIA_BASE_URL ??= "https://sinqia.fixture.invalid";
process.env.SINQIA_ENV ??= "hml";

const dir = mkdtempSync(path.join(tmpdir(), "sod-us08-"));
process.env.SQLITE_PATH = path.join(dir, "app.db");

const { ESTADOS_BLOQUEIO_MOVIMENTACAO, extrairDocumentoSod } = await import(
  "@cadastro-lote/shared"
);
const { abrirBancoSod, criarSodRepositorio } = await import("./repositorio.js");
const { criarSodServico } = await import("./dominio.js");
const { registerSodRoutes } = await import("./rotas.js");
const { registerPropostasRoutes } = await import("./../routes-propostas.js");
const { createSession, limparSessoes } = await import("./../session.js");

let app: FastifyInstance;
let db: ReturnType<typeof abrirBancoSod>;
let repo: ReturnType<typeof criarSodRepositorio>;
let servico: ReturnType<typeof criarSodServico>;
let sidMaria: string; // requisitante
let sidJoao: string; // aprovador
let sidAna: string; // segunda operadora (concorrência)

/** Toggle mutável da movimentação — os testes de regressão o desligam. */
let toggleMovimentacao = true;
/** Sobrescreve o comportamento por chamada (teste do guard de corte). */
let aprovacaoAtivaOverride: ((tipo: string) => boolean) | null = null;
const aprovacaoAtivaFake = (tipo: string) => {
  if (aprovacaoAtivaOverride) return aprovacaoAtivaOverride(tipo);
  return tipo === "proposta.movimentar" ? toggleMovimentacao : false;
};

/* ------------------- Fixtures Sinqia ------------------- */

const NR_WF = 1;
const ORIGEM = 20020;
const DESTINO = 20030;

function transicoesDe(nrStatus: number): TransicaoStatus[] {
  // Workflow-fixture: de 20020 pode ir a 20030 (livre) e 20050 (exige obs.);
  // de 20040 (etapa "externa") pode ir a 20056.
  if (nrStatus === ORIGEM) {
    return [
      { proxStatus: DESTINO, nrWf: NR_WF, dsStatus: "Aprovado p/ desembolso", exigeObservacao: false },
      { proxStatus: 20050, nrWf: NR_WF, dsStatus: "Cancelado pelo credor", exigeObservacao: true },
    ];
  }
  if (nrStatus === 20040) {
    return [
      { proxStatus: 20056, nrWf: NR_WF, dsStatus: "Finalizado no Portal", exigeObservacao: false },
    ];
  }
  return [];
}

/** consultarStatusTransf — lado do REQUISITANTE (revalidação na criação). */
const transicoesMaker: Array<{ token: string; nrWf: number; nrStatus: number }> = [];
/** consultarStatusTransf — lado do APROVADOR (captura de etapas válidas). */
const transicoesAprovador: Array<{ token: string; nrWf: number; nrStatus: number }> = [];

/** transfStatus do FLUXO DIRETO — com a flag ON, jamais pode ser chamado. */
const transferenciasDiretas: Array<{ token: string; input: TransfStatusInput }> = [];
let responderTransferenciaDireta = async () => ({ httpStatus: 200, ok: true, detalhe: "OK" });

/** transfStatus da EXECUÇÃO (sessão do aprovador). */
const transferenciasExecucao: Array<{ token: string; input: TransfStatusInput }> = [];
let responderTransferenciaExecucao: () => Promise<{
  httpStatus: number;
  ok: boolean;
  detalhe: string;
}> = async () => ({ httpStatus: 200, ok: true, detalhe: "OK" });

/** Status ATUAL de cada proposta no fixture (divergência externa = mudar aqui). */
const statusAtualDaProposta = new Map<number, number>();
const consultasHistorico: Array<{ token: string; nrProsp: string }> = [];
async function historicoFake(token: string, nrProsp: string | number) {
  consultasHistorico.push({ token, nrProsp: String(nrProsp) });
  const atual = statusAtualDaProposta.get(Number(nrProsp));
  if (atual === undefined) return { httpStatus: 204, historicos: [] };
  return {
    httpStatus: 200,
    historicos: [
      { nrSeq: 1, dtIn: "01/08/2026", nmUsr: "portal", nrStatus: 20010, dsStatus: "Digitada", dsObserv: "" },
      { nrSeq: 2, dtIn: "05/08/2026", nmUsr: "portal", nrStatus: atual, dsStatus: `Etapa ${atual}`, dsObserv: "" },
    ],
  };
}

/** Sonda de sessão (RN03) controlável por teste. */
let sessaoSinqia: "valida" | "invalida" | "indisponivel" = "valida";
let sondagens = 0;

/** Body-base do POST /api/propostas-transferir. */
function bodyMover(nrProsp: number, over: Record<string, unknown> = {}) {
  return {
    nrProsp,
    nrWf: NR_WF,
    nrStatusAtual: ORIGEM,
    dsStatusAtual: "Em análise de crédito",
    proxStatus: DESTINO,
    dsObserv: "",
    nrCpf: "12345678901",
    nmCliente: "Tomador Fixture",
    cdProd: 77,
    nrContra: 0,
    ...over,
  };
}

async function criarRequisicaoMover(sid: string, nrProsp: number, over: Record<string, unknown> = {}) {
  return app.inject({
    method: "POST",
    url: "/api/propostas-transferir",
    cookies: { sid },
    payload: bodyMover(nrProsp, over),
  });
}

async function decidir(sid: string, id: string, decisao: string, motivo?: string) {
  return app.inject({
    method: "POST",
    url: `/api/sod/requisicoes/${id}/decisao`,
    cookies: { sid },
    payload: { decisao, ...(motivo !== undefined ? { motivo } : {}) },
  });
}

async function movimentacoesAtivas(sid: string) {
  const res = await app.inject({ method: "GET", url: "/api/sod/movimentacoes-ativas", cookies: { sid } });
  assert.equal(res.statusCode, 200);
  return (res.json() as { movimentacoes: Array<Record<string, any>> }).movimentacoes;
}

before(async () => {
  db = abrirBancoSod(path.join(dir, "sod.db"));
  repo = criarSodRepositorio(db, "hml");
  servico = criarSodServico(repo);

  app = Fastify();
  await app.register(cookie);
  await registerPropostasRoutes(app, {
    consultarStatusTransfFn: async (token, nrWf, nrStatus) => {
      transicoesMaker.push({ token, nrWf, nrStatus });
      return { httpStatus: 200, transicoes: transicoesDe(nrStatus) };
    },
    transferirStatusFn: async (token, input) => {
      transferenciasDiretas.push({ token, input });
      return responderTransferenciaDireta();
    },
    sodServico: () => servico,
    aprovacaoAtivaFn: aprovacaoAtivaFake,
  });
  await registerSodRoutes(app, servico, {
    verificarSessaoSinqiaFn: async () => {
      sondagens++;
      return sessaoSinqia;
    },
    transferirStatusFn: async (token, input) => {
      transferenciasExecucao.push({ token, input });
      return responderTransferenciaExecucao();
    },
    consultarStatusTransfFn: async (token, nrWf, nrStatus) => {
      transicoesAprovador.push({ token, nrWf, nrStatus });
      return { httpStatus: 200, transicoes: transicoesDe(nrStatus) };
    },
    consultarHistoricoPropostaFn: historicoFake,
  });
  await app.ready();

  limparSessoes();
  // Tokens DISTINTOS por operador: prova de que a execução usou a sessão do
  // APROVADOR (B2'), não a do requisitante.
  sidMaria = createSession("Maria.SILVA", "token-maria").id;
  sidJoao = createSession("joao.souza", "token-joao").id;
  sidAna = createSession("ana.lima", "token-ana").id;
});

beforeEach(() => {
  toggleMovimentacao = true;
  aprovacaoAtivaOverride = null;
  sessaoSinqia = "valida";
  responderTransferenciaDireta = async () => ({ httpStatus: 200, ok: true, detalhe: "OK" });
  responderTransferenciaExecucao = async () => ({ httpStatus: 200, ok: true, detalhe: "OK" });
  transferenciasDiretas.length = 0;
  transferenciasExecucao.length = 0;
  consultasHistorico.length = 0;
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

describe("US-08 — contratos compartilhados", () => {
  test("a chave de bloqueio é o nº da proposta; 'ativa' inclui falha", () => {
    assert.equal(
      extrairDocumentoSod("proposta.movimentar", {
        movimentacao: { nrProsp: 5001 },
      } as Record<string, unknown>),
      "5001",
    );
    assert.equal(extrairDocumentoSod("proposta.movimentar", {}), null);
    assert.deepEqual(
      [...ESTADOS_BLOQUEIO_MOVIMENTACAO],
      ["pendente", "aprovada/executando", "falha"],
    );
  });
});

describe("US-08 Cenário 1 — mover com a flag ativa vira requisição pendente", () => {
  test("payload da RN02 completo, zero Sinqia, indicador 'pendente (→ destino)'", async () => {
    statusAtualDaProposta.set(5001, ORIGEM);
    const res = await criarRequisicaoMover(sidMaria, 5001);
    assert.equal(res.statusCode, 201);
    const body = res.json() as Record<string, any>;
    assert.equal(body.aprovacao, true);
    assert.equal(body.requisicao.estado, "pendente");
    assert.equal(body.destino.proxStatus, DESTINO);

    // ZERO efeito na Sinqia: nem fluxo direto, nem executor.
    assert.equal(transferenciasDiretas.length, 0);
    assert.equal(transferenciasExecucao.length, 0);

    // Payload da RN02: dados da movimentação + request EXATO do transfStatus.
    const det = await app.inject({
      method: "GET",
      url: `/api/sod/requisicoes/${body.requisicao.id}`,
      cookies: { sid: sidMaria },
    });
    assert.equal(det.statusCode, 200);
    const { requisicao } = det.json() as { requisicao: Record<string, any> };
    assert.equal(requisicao.documento, "5001");
    assert.deepEqual(requisicao.payload.movimentacao.origem, {
      nrStatus: ORIGEM,
      dsStatus: "Em análise de crédito",
    });
    assert.deepEqual(requisicao.payload.movimentacao.destino, {
      proxStatus: DESTINO,
      dsStatus: "Aprovado p/ desembolso",
    });
    assert.deepEqual(requisicao.payload.request, {
      nrStatus: DESTINO,
      dsObserv: "",
      nrCpf: "12345678901",
      nrProsp: 5001,
      nmCliente: "Tomador Fixture",
      nrWf: NR_WF,
      cdProd: 77,
      nrContra: 0,
    });

    // Indicador agregado (RN05): uma chamada devolve o estado por proposta.
    const movs = await movimentacoesAtivas(sidMaria);
    const mov = movs.find((m) => m.nrProsp === 5001);
    assert.ok(mov, "movimentação ativa da proposta 5001 no agregado");
    assert.equal(mov!.estado, "pendente");
    assert.equal(mov!.destino.dsStatus, "Aprovado p/ desembolso");
    assert.equal(mov!.requisitante, "maria.silva");
  });

  test("destino fora do workflow → 422 sem requisição; observação obrigatória respeitada", async () => {
    const invalido = await criarRequisicaoMover(sidMaria, 5002, { proxStatus: 99999 });
    assert.equal(invalido.statusCode, 422);

    const semObs = await criarRequisicaoMover(sidMaria, 5002, { proxStatus: 20050 });
    assert.equal(semObs.statusCode, 422);
    assert.match((semObs.json() as { error: string }).error, /exige observação/i);

    const movs = await movimentacoesAtivas(sidMaria);
    assert.equal(movs.filter((m) => m.nrProsp === 5002).length, 0);
  });
});

describe("US-08 Cenário 2 — aprovação executa na sessão do aprovador", () => {
  test("verifica o status atual, move com o request persistido e libera o bloqueio", async () => {
    statusAtualDaProposta.set(5010, ORIGEM);
    const criada = (await criarRequisicaoMover(sidMaria, 5010)).json() as Record<string, any>;
    const id = criada.requisicao.id as string;

    // Maker-checker: a própria criadora não decide (RN da fundação).
    const propria = await decidir(sidMaria, id, "aprovar");
    assert.equal(propria.statusCode, 403);

    const sondagensAntes = sondagens;
    const res = await decidir(sidJoao, id, "aprovar");
    assert.equal(res.statusCode, 200);
    const body = res.json() as Record<string, any>;
    assert.equal(body.requisicao.estado, "executada");
    assert.equal(body.execucao.desfecho, "executada");
    assert.ok(sondagens > sondagensAntes, "pré-verificação de sessão (RN03) aconteceu");

    // Execução na SESSÃO DO APROVADOR, com o request persistido intacto.
    assert.equal(consultasHistorico.at(-1)?.token, "token-joao");
    assert.equal(transferenciasExecucao.length, 1);
    assert.equal(transferenciasExecucao[0].token, "token-joao");
    assert.deepEqual(transferenciasExecucao[0].input, {
      nrStatus: DESTINO,
      dsObserv: "",
      nrCpf: "12345678901",
      nrProsp: 5010,
      nmCliente: "Tomador Fixture",
      nrWf: NR_WF,
      cdProd: 77,
      nrContra: 0,
    });
    assert.equal(transferenciasDiretas.length, 0, "fluxo direto nunca participou");

    // Indicador some (executada é terminal) e o bloqueio libera.
    const movs = await movimentacoesAtivas(sidJoao);
    assert.equal(movs.filter((m) => m.nrProsp === 5010).length, 0);
    const nova = await criarRequisicaoMover(sidMaria, 5010);
    assert.equal(nova.statusCode, 201, "proposta executada pode ser movida de novo");
    // Limpa para não interferir nos demais testes.
    const cancel = await decidir(sidMaria, (nova.json() as any).requisicao.id, "cancelar");
    assert.equal(cancel.statusCode, 200);
  });
});

describe("US-08 Cenário 3 — bloqueio de requisição ativa por proposta", () => {
  test("segunda requisição da mesma proposta → 409 MOVIMENTACAO_BLOQUEADA", async () => {
    statusAtualDaProposta.set(5020, ORIGEM);
    const primeira = await criarRequisicaoMover(sidMaria, 5020);
    assert.equal(primeira.statusCode, 201);
    const idPrimeira = (primeira.json() as any).requisicao.id as string;

    const segunda = await criarRequisicaoMover(sidAna, 5020);
    assert.equal(segunda.statusCode, 409);
    const corpo = segunda.json() as Record<string, any>;
    assert.equal(corpo.code, "MOVIMENTACAO_BLOQUEADA");
    assert.equal(corpo.requisicaoExistente.id, idPrimeira);
    assert.equal(corpo.requisicaoExistente.estado, "pendente");

    // Cancelada (terminal) LIBERA o bloqueio.
    const cancel = await decidir(sidMaria, idPrimeira, "cancelar");
    assert.equal(cancel.statusCode, 200);
    const depois = await criarRequisicaoMover(sidAna, 5020);
    assert.equal(depois.statusCode, 201);

    // Reprovada (terminal) também libera.
    const idAna = (depois.json() as any).requisicao.id as string;
    const reprova = await decidir(sidMaria, idAna, "reprovar", "destino incorreto");
    assert.equal(reprova.statusCode, 200);
    const aposReprova = await criarRequisicaoMover(sidMaria, 5020);
    assert.equal(aposReprova.statusCode, 201);
    await decidir(sidMaria, (aposReprova.json() as any).requisicao.id, "cancelar");
  });

  test("corrida de criação simultânea: exatamente UMA vence", async () => {
    statusAtualDaProposta.set(5021, ORIGEM);
    const [a, b] = await Promise.all([
      criarRequisicaoMover(sidMaria, 5021),
      criarRequisicaoMover(sidAna, 5021),
    ]);
    const statuses = [a.statusCode, b.statusCode].sort();
    assert.deepEqual(statuses, [201, 409]);
    const perdedora = a.statusCode === 409 ? a : b;
    assert.equal((perdedora.json() as any).code, "MOVIMENTACAO_BLOQUEADA");
    // Só UMA ativa no agregado.
    const movs = await movimentacoesAtivas(sidMaria);
    assert.equal(movs.filter((m) => m.nrProsp === 5021).length, 1);
  });

  test("a guarda ATÔMICA no banco cobre inclusive requisição em `falha`", () => {
    // Simula a corrida além da pré-checagem do domínio: requisição em falha
    // já existe e um INSERT chega direto — o índice parcial aborta.
    const req = servico.criarRequisicao({
      tipo: "proposta.movimentar",
      payload: {
        movimentacao: { nrProsp: 5022, origem: {}, destino: {} },
        request: {},
      },
      requisitante: "maria.silva",
    });
    servico.aprovar(req.id, "joao.souza");
    servico.concluirExecucao(req.id, "joao.souza", "falha", { causa: "divergencia_externa" });

    assert.throws(
      () =>
        repo.criarRequisicao(
          {
            id: "11111111-1111-4111-8111-111111111111",
            tipo: "proposta.movimentar",
            payload: {},
            documento: "5022",
            requisitante: "ana.lima",
            criadoEm: new Date().toISOString(),
          },
          {
            requisicaoId: "11111111-1111-4111-8111-111111111111",
            ator: "ana.lima",
            acao: "requisicao_criada",
            detalhe: {},
            resultado: "ok",
            ts: new Date().toISOString(),
          },
        ),
      /UNIQUE constraint failed/,
      "o índice de bloqueio decide a corrida mesmo com a existente em falha",
    );

    // E o serviço traduz para o erro de negócio, com a existente estruturada.
    assert.equal(servico.movimentacaoAtivaPorProposta(5022)?.id, req.id);
  });
});

describe("US-08 Cenário 4 — divergência externa e rejeição Sinqia", () => {
  test("proposta movida por fora → falha com etapas válidas, ZERO transfStatus, bloqueio mantido", async () => {
    statusAtualDaProposta.set(5030, ORIGEM);
    const criada = (await criarRequisicaoMover(sidMaria, 5030)).json() as Record<string, any>;
    const id = criada.requisicao.id as string;

    // Divergência EXTERNA: alguém moveu a proposta pelo Portal Sinqia.
    statusAtualDaProposta.set(5030, 20040);

    const res = await decidir(sidJoao, id, "aprovar");
    assert.equal(res.statusCode, 200);
    const body = res.json() as Record<string, any>;
    assert.equal(body.requisicao.estado, "falha");
    assert.equal(body.execucao.desfecho, "falha");
    assert.equal(transferenciasExecucao.length, 0, "nada foi movido na Sinqia");

    // Resposta INTEGRAL: causa, comparativo esperado × atual e etapas válidas
    // devolvidas a partir do status ATUAL (insumo do retry/descarte, US-10).
    const resultado = body.requisicao.resultado as Record<string, any>;
    assert.equal(resultado.causa, "divergencia_externa");
    assert.equal(resultado.esperado.nrStatus, ORIGEM);
    assert.equal(resultado.atual.nrStatus, 20040);
    assert.equal(resultado.etapasValidas[0].proxStatus, 20056);
    assert.equal(transicoesAprovador.at(-1)?.nrStatus, 20040);

    // Indicador "falhou" + bloqueio MANTIDO (RN03 — resolução na US-10).
    const movs = await movimentacoesAtivas(sidJoao);
    const mov = movs.find((m) => m.nrProsp === 5030);
    assert.equal(mov?.estado, "falha");
    assert.equal(mov?.causaFalha, "divergencia_externa");
    const nova = await criarRequisicaoMover(sidAna, 5030);
    assert.equal(nova.statusCode, 409);
    assert.equal((nova.json() as any).code, "MOVIMENTACAO_BLOQUEADA");

    // Auditoria completa: criação, decisão, início e conclusão da execução.
    const det = await app.inject({
      method: "GET",
      url: `/api/sod/requisicoes/${id}`,
      cookies: { sid: sidJoao },
    });
    const historico = (det.json() as { historico: Array<Record<string, any>> }).historico;
    const acoes = historico.map((h) => `${h.acao}:${h.detalhe.para ?? ""}`);
    assert.ok(acoes.includes("requisicao_criada:"));
    assert.ok(acoes.includes("transicao_estado:aprovada/executando"));
    assert.ok(acoes.includes("execucao_iniciada:"));
    assert.ok(acoes.includes("transicao_estado:falha"));
    // A tentativa BLOQUEADA da Ana também foi auditada, vinculada à requisição.
    assert.ok(
      historico.some(
        (h) => h.acao === "tentativa_rejeitada" && h.ator === "ana.lima",
      ),
    );
  });

  test("rejeição da Sinqia no transfStatus → falha com resposta integral", async () => {
    statusAtualDaProposta.set(5031, ORIGEM);
    const criada = (await criarRequisicaoMover(sidMaria, 5031)).json() as Record<string, any>;
    responderTransferenciaExecucao = async () => ({
      httpStatus: 200,
      ok: false,
      detalhe: '{"erro":"Transição não permitida para o perfil"}',
    });

    const res = await decidir(sidJoao, criada.requisicao.id, "aprovar");
    assert.equal(res.statusCode, 200);
    const body = res.json() as Record<string, any>;
    assert.equal(body.requisicao.estado, "falha");
    const resultado = body.requisicao.resultado as Record<string, any>;
    assert.equal(resultado.causa, "movimentacao_rejeitada");
    assert.match(String(resultado.respostaSinqia), /Transição não permitida/);
    assert.ok(Array.isArray(resultado.etapasValidas), "etapas válidas capturadas quando presentes");
    assert.equal(transferenciasExecucao.length, 1, "a Sinqia foi chamada uma única vez");
  });
});

describe("US-08 Regressão — fluxo direto intacto e corte à prova de corrida", () => {
  test("flag OFF: movimentação direta funciona como antes, zero requisições", async () => {
    toggleMovimentacao = false;
    const antes = (await movimentacoesAtivas(sidMaria)).length;

    const res = await criarRequisicaoMover(sidMaria, 5040);
    assert.equal(res.statusCode, 200);
    const body = res.json() as Record<string, any>;
    assert.equal(body.ok, true);
    assert.equal(body.destino.proxStatus, DESTINO);
    assert.equal(transferenciasDiretas.length, 1);
    assert.equal(transferenciasDiretas[0].token, "token-maria");

    assert.equal((await movimentacoesAtivas(sidMaria)).length, antes);
  });

  test("guard de corte: flag ativada ENTRE o desvio e a execução → 409, zero Sinqia", async () => {
    // 1ª leitura (desvio) devolve false; 2ª (guard) devolve true — simula a
    // flag virando no meio da requisição HTTP.
    let leituras = 0;
    aprovacaoAtivaOverride = (tipo) =>
      tipo === "proposta.movimentar" ? leituras++ > 0 : false;

    const res = await criarRequisicaoMover(sidMaria, 5041);
    assert.equal(res.statusCode, 409);
    assert.equal((res.json() as any).code, "ACAO_SOB_APROVACAO");
    assert.equal(transferenciasDiretas.length, 0);
  });
});

describe("US-08 Performance — indicador agregado do painel", () => {
  test("uma chamada única cobre N propostas em tempo de painel", async () => {
    // Seed: 150 movimentações ativas (propostas distintas).
    for (let i = 0; i < 150; i++) {
      servico.criarRequisicao({
        tipo: "proposta.movimentar",
        payload: {
          movimentacao: {
            nrProsp: 700000 + i,
            nmCliente: `Tomador ${i}`,
            nrCpf: "12345678901",
            nrWf: NR_WF,
            origem: { nrStatus: ORIGEM, dsStatus: "Em análise de crédito" },
            destino: { proxStatus: DESTINO, dsStatus: "Aprovado p/ desembolso" },
            dsObserv: "",
            cdProd: 77,
            nrContra: null,
          },
          request: { nrProsp: 700000 + i },
        },
        requisitante: "maria.silva",
      });
    }

    const inicio = performance.now();
    const movs = await movimentacoesAtivas(sidJoao);
    const duracaoMs = performance.now() - inicio;

    assert.ok(movs.length >= 150, `agregado devolve todas (${movs.length})`);
    // Régua folgada para CI: a consulta é um índice + map em memória.
    assert.ok(duracaoMs < 500, `agregado em ${duracaoMs.toFixed(1)} ms (< 500 ms)`);
    // eslint-disable-next-line no-console
    console.log(
      `US-08 perf: GET /api/sod/movimentacoes-ativas com ${movs.length} ativas em ${duracaoMs.toFixed(1)} ms`,
    );
  });
});
