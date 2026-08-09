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
 * US-09 — Movimentação de propostas em MASSA (composição US-06 × US-08).
 *
 * Cobre os cenários da história ponta a ponta no BFF, offline (Sinqia
 * simulada por spies nas deps injetáveis):
 *  1. flag ON + seleção homogênea elegível → UMA requisição-LOTE `pendente`
 *     com K itens (payload por item no padrão da US-08), ZERO transfStatus,
 *     indicadores e bloqueios ativos por proposta (fonte única);
 *  2. seleção com inelegíveis → apontadas por motivo (409), subconjunto só
 *     com confirmação explícita, cancelamento (não reenviar) não cria nada;
 *  3. decisão bidirecional aprovar-exceto-N → exceções reprovadas com bloqueio
 *     liberado; demais executadas SEQUENCIALMENTE na sessão do aprovador com
 *     falha parcial isolada (falha mantém o bloqueio; as demais seguem);
 *  4. bloqueio mútuo individual×lote nas DUAS direções, com corrida simulada
 *     (índice no banco decide o lote×lote; domínio decide o individual×lote);
 *  + regressão (flag OFF → job direto intacto; guard de corte à prova de
 *    corrida de flag).
 */
process.env.SINQIA_BASE_URL ??= "https://sinqia.fixture.invalid";
process.env.SINQIA_ENV ??= "hml";

const dir = mkdtempSync(path.join(tmpdir(), "sod-us09-"));
process.env.SQLITE_PATH = path.join(dir, "app.db");

const { TIPO_ITEM_DO_LOTE, TIPOS_DE_ITEM_DO_LOTE } = await import("@cadastro-lote/shared");
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

/** Toggles mutáveis — os testes de regressão os desligam. */
let toggleMassa = true;
let toggleIndividual = true;
/** Sobrescreve o comportamento por chamada (teste do guard de corte). */
let aprovacaoAtivaOverride: ((tipo: string) => boolean) | null = null;
const aprovacaoAtivaFake = (tipo: string) => {
  if (aprovacaoAtivaOverride) return aprovacaoAtivaOverride(tipo);
  if (tipo === "proposta.movimentar_massa") return toggleMassa;
  if (tipo === "proposta.movimentar") return toggleIndividual;
  return false;
};

/* ------------------- Fixtures Sinqia ------------------- */

const NR_WF = 1;
const ORIGEM = 20020;
const DESTINO = 20030;
const DS_ORIGEM = "Em análise de crédito";

function transicoesDe(nrStatus: number): TransicaoStatus[] {
  if (nrStatus === ORIGEM) {
    return [
      { proxStatus: DESTINO, nrWf: NR_WF, dsStatus: "Aprovado p/ desembolso", exigeObservacao: false },
      { proxStatus: 20050, nrWf: NR_WF, dsStatus: "Cancelado pelo credor", exigeObservacao: true },
    ];
  }
  return [];
}

/** transfStatus do FLUXO DIRETO — com a flag ON, jamais pode ser chamado. */
const transferenciasDiretas: Array<{ token: string; input: TransfStatusInput }> = [];

/** transfStatus da EXECUÇÃO (sessão do aprovador) — resposta configurável por proposta. */
const transferenciasExecucao: Array<{ token: string; input: TransfStatusInput }> = [];
const rejeitarExecucaoDe = new Set<number>();

/** Status ATUAL de cada proposta no fixture (divergência externa = mudar aqui). */
const statusAtualDaProposta = new Map<number, number>();
async function historicoFake(token: string, nrProsp: string | number) {
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

let sessaoSinqia: "valida" | "invalida" | "indisponivel" = "valida";

/** Item de seleção do POST /api/propostas-transferir-lote. */
function itemDe(nrProsp: number) {
  return {
    nrProsp,
    nrCpf: "12345678901",
    nmCliente: `Tomador ${nrProsp}`,
    cdProd: 77,
    nrContra: 0,
  };
}

async function criarLoteMover(
  sid: string,
  nrProsps: number[],
  over: Record<string, unknown> = {},
) {
  for (const nr of nrProsps) statusAtualDaProposta.set(nr, ORIGEM);
  return app.inject({
    method: "POST",
    url: "/api/propostas-transferir-lote",
    cookies: { sid },
    payload: {
      nrWf: NR_WF,
      nrStatusAtual: ORIGEM,
      dsStatusAtual: DS_ORIGEM,
      proxStatus: DESTINO,
      dsObserv: "",
      itens: nrProsps.map(itemDe),
      ...over,
    },
  });
}

/** Requisição INDIVIDUAL de movimentação (US-08) — para o bloqueio mútuo. */
async function criarRequisicaoMoverIndividual(sid: string, nrProsp: number) {
  statusAtualDaProposta.set(nrProsp, ORIGEM);
  return app.inject({
    method: "POST",
    url: "/api/propostas-transferir",
    cookies: { sid },
    payload: {
      nrProsp,
      nrWf: NR_WF,
      nrStatusAtual: ORIGEM,
      dsStatusAtual: DS_ORIGEM,
      proxStatus: DESTINO,
      dsObserv: "",
      nrCpf: "12345678901",
      nmCliente: `Tomador ${nrProsp}`,
      cdProd: 77,
      nrContra: 0,
    },
  });
}

async function decidir(
  sid: string,
  id: string,
  decisao: string,
  extra: Record<string, unknown> = {},
) {
  return app.inject({
    method: "POST",
    url: `/api/sod/requisicoes/${id}/decisao`,
    cookies: { sid },
    payload: { decisao, ...extra },
  });
}

async function detalhe(id: string, sid = sidMaria) {
  const res = await app.inject({
    method: "GET",
    url: `/api/sod/requisicoes/${id}`,
    cookies: { sid },
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json() as Record<string, any>;
}

async function movimentacoesAtivas(sid = sidMaria) {
  const res = await app.inject({
    method: "GET",
    url: "/api/sod/movimentacoes-ativas",
    cookies: { sid },
  });
  assert.equal(res.statusCode, 200);
  return (res.json() as { movimentacoes: Array<Record<string, any>> }).movimentacoes;
}

/** Espera a execução em background terminar (estado do lote sair de executando). */
async function aguardarConclusao(id: string, timeoutMs = 5000): Promise<void> {
  const inicio = Date.now();
  for (;;) {
    const req = servico.obterRequisicao(id);
    if (req && req.estado !== "aprovada/executando" && req.estado !== "pendente") return;
    if (Date.now() - inicio > timeoutMs) {
      throw new Error(`Lote ${id} não concluiu em ${timeoutMs}ms (estado: ${req?.estado}).`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

before(async () => {
  db = abrirBancoSod(path.join(dir, "sod.db"));
  repo = criarSodRepositorio(db, "hml");
  servico = criarSodServico(repo);

  app = Fastify();
  await app.register(cookie);
  await registerPropostasRoutes(app, {
    consultarStatusTransfFn: async (_token, _nrWf, nrStatus) => ({
      httpStatus: 200,
      transicoes: transicoesDe(nrStatus),
    }),
    transferirStatusFn: async (token, input) => {
      transferenciasDiretas.push({ token, input });
      return { httpStatus: 200, ok: true, detalhe: "OK" };
    },
    sodServico: () => servico,
    aprovacaoAtivaFn: aprovacaoAtivaFake,
  });
  await registerSodRoutes(app, servico, {
    verificarSessaoSinqiaFn: async () => sessaoSinqia,
    transferirStatusFn: async (token, input) => {
      transferenciasExecucao.push({ token, input });
      if (rejeitarExecucaoDe.has(input.nrProsp)) {
        return {
          httpStatus: 200,
          ok: false,
          detalhe: '{"erro":"Transição não permitida para o perfil"}',
        };
      }
      return { httpStatus: 200, ok: true, detalhe: "OK" };
    },
    consultarStatusTransfFn: async (_token, _nrWf, nrStatus) => ({
      httpStatus: 200,
      transicoes: transicoesDe(nrStatus),
    }),
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
  toggleMassa = true;
  toggleIndividual = true;
  aprovacaoAtivaOverride = null;
  sessaoSinqia = "valida";
  rejeitarExecucaoDe.clear();
  transferenciasDiretas.length = 0;
  transferenciasExecucao.length = 0;
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

describe("US-09 — contratos compartilhados (composição por parametrização)", () => {
  test("o lote de movimentação executa itens do tipo INDIVIDUAL da US-08", () => {
    assert.equal(TIPO_ITEM_DO_LOTE["proposta.movimentar_massa"], "proposta.movimentar");
    assert.deepEqual(TIPOS_DE_ITEM_DO_LOTE["proposta.movimentar_massa"], [
      "proposta.movimentar",
    ]);
  });
});

describe("US-09 Cenário 1 — seleção homogênea elegível vira requisição-lote pendente", () => {
  test("lote pendente com K itens no padrão US-08, ZERO Sinqia, indicadores e bloqueios ativos", async () => {
    const props = [6001, 6002, 6003];
    const res = await criarLoteMover(sidMaria, props);
    assert.equal(res.statusCode, 201, res.body);
    const body = res.json() as Record<string, any>;
    assert.equal(body.aprovacao, true);
    assert.equal(body.requisicao.estado, "pendente");
    assert.equal(body.totalItens, 3);
    assert.deepEqual(body.inelegiveis, []);

    // ZERO efeito na Sinqia: nem fluxo direto, nem executor.
    assert.equal(transferenciasDiretas.length, 0);
    assert.equal(transferenciasExecucao.length, 0);

    // Itens no padrão da US-08: movimentacao + request EXATO do transfStatus.
    const det = await detalhe(body.requisicao.id);
    assert.equal(det.requisicao.tipo, "proposta.movimentar_massa");
    assert.equal(det.requisicao.payload.totalItens, 3);
    assert.deepEqual(det.requisicao.payload.fila.origem, {
      nrStatus: ORIGEM,
      dsStatus: DS_ORIGEM,
    });
    assert.deepEqual(det.requisicao.payload.destino, {
      proxStatus: DESTINO,
      dsStatus: "Aprovado p/ desembolso",
    });
    assert.equal(det.itens.length, 3);
    assert.equal(det.placar.pendentes, 3);
    for (const [i, item] of (det.itens as Array<Record<string, any>>).entries()) {
      assert.equal(item.tipo, "proposta.movimentar");
      assert.equal(item.estado, "pendente");
      assert.equal(item.documento, String(props[i]));
    }
    // Payload integral de UM item — o request que a execução reenvia intacto.
    const item0 = await app.inject({
      method: "GET",
      url: `/api/sod/requisicoes/${body.requisicao.id}/itens/${det.itens[0].id}`,
      cookies: { sid: sidMaria },
    });
    assert.equal(item0.statusCode, 200);
    assert.deepEqual((item0.json() as any).item.payload.request, {
      nrStatus: DESTINO,
      dsObserv: "",
      nrCpf: "12345678901",
      nrProsp: 6001,
      nmCliente: "Tomador 6001",
      nrWf: NR_WF,
      cdProd: 77,
      nrContra: 0,
    });

    // Indicador agregado (fonte única): as 3 aparecem como itens de LOTE.
    const movs = await movimentacoesAtivas();
    for (const nr of props) {
      const mov = movs.find((m) => m.nrProsp === nr);
      assert.ok(mov, `movimentação ativa da proposta ${nr} no agregado`);
      assert.equal(mov!.estado, "pendente");
      assert.equal(mov!.lote, true);
      assert.equal(mov!.requisicaoId, body.requisicao.id);
      assert.equal(mov!.requisitante, "maria.silva");
    }

    // Bloqueio por proposta registrado para CADA item (Cenário 4 da criação).
    const individual = await criarRequisicaoMoverIndividual(sidAna, 6002);
    assert.equal(individual.statusCode, 409);
    assert.equal((individual.json() as any).code, "MOVIMENTACAO_BLOQUEADA");

    // Limpa: cancelamento em cascata libera os bloqueios do lote inteiro.
    const cancel = await decidir(sidMaria, body.requisicao.id, "cancelar");
    assert.equal(cancel.statusCode, 200);
    assert.equal(
      (await movimentacoesAtivas()).filter((m) => props.includes(m.nrProsp)).length,
      0,
      "cancelamento liberou os bloqueios",
    );
  });

  test("proposta repetida na seleção → 400, nada criado", async () => {
    const res = await criarLoteMover(sidMaria, [6010, 6010]);
    assert.equal(res.statusCode, 400);
    assert.equal((await movimentacoesAtivas()).filter((m) => m.nrProsp === 6010).length, 0);
  });

  test("destino fora do workflow → 422 sem requisição", async () => {
    const res = await criarLoteMover(sidMaria, [6011], { proxStatus: 99999 });
    assert.equal(res.statusCode, 422);
    assert.equal((await movimentacoesAtivas()).filter((m) => m.nrProsp === 6011).length, 0);
  });
});

describe("US-09 Cenário 2 — seleção com inelegíveis exige confirmação de subconjunto (RN04)", () => {
  test("inelegíveis apontadas por motivo; lote-subconjunto só com confirmação; sem reenvio nada é criado", async () => {
    // Seed: 6101 tem movimentação INDIVIDUAL ativa (US-08).
    const seed = await criarRequisicaoMoverIndividual(sidMaria, 6101);
    assert.equal(seed.statusCode, 201, seed.body);

    // 1ª tentativa (sem confirmação): 409 com as inelegíveis por MOTIVO.
    const primeira = await criarLoteMover(sidAna, [6101, 6102, 6103]);
    assert.equal(primeira.statusCode, 409, primeira.body);
    const corpo = primeira.json() as Record<string, any>;
    assert.equal(corpo.code, "SUBCONJUNTO_NAO_CONFIRMADO");
    assert.equal(corpo.elegiveis, 2);
    assert.equal(corpo.inelegiveis.length, 1);
    assert.equal(corpo.inelegiveis[0].nrProsp, 6101);
    assert.equal(corpo.inelegiveis[0].estado, "pendente");
    assert.match(corpo.inelegiveis[0].motivo, /movimentação ativa/i);

    // Cancelamento (não reenviar) não cria NADA: 6102/6103 seguem livres.
    const movs = await movimentacoesAtivas();
    assert.equal(movs.filter((m) => [6102, 6103].includes(m.nrProsp)).length, 0);

    // 2ª tentativa (confirmada): lote nasce SÓ com as elegíveis.
    const segunda = await criarLoteMover(sidAna, [6101, 6102, 6103], {
      confirmarSubconjunto: true,
    });
    assert.equal(segunda.statusCode, 201, segunda.body);
    const criado = segunda.json() as Record<string, any>;
    assert.equal(criado.totalItens, 2);
    assert.equal(criado.inelegiveis.length, 1);
    const det = await detalhe(criado.requisicao.id, sidAna);
    assert.deepEqual(
      (det.itens as Array<Record<string, any>>).map((i) => i.documento),
      ["6102", "6103"],
    );
    assert.equal(det.requisicao.payload.inelegiveisRemovidas, 1);

    // Limpa.
    await decidir(sidAna, criado.requisicao.id, "cancelar");
    const seedId = (seed.json() as any).requisicao.id as string;
    await decidir(sidMaria, seedId, "cancelar");
  });

  test("TODAS bloqueadas → 409 sem criação, mesmo com confirmação", async () => {
    const seed = await criarRequisicaoMoverIndividual(sidMaria, 6110);
    assert.equal(seed.statusCode, 201);

    const res = await criarLoteMover(sidAna, [6110], { confirmarSubconjunto: true });
    assert.equal(res.statusCode, 409);
    assert.equal((res.json() as any).code, "MOVIMENTACAO_BLOQUEADA");

    await decidir(sidMaria, (seed.json() as any).requisicao.id, "cancelar");
  });
});

describe("US-09 Cenário 3 — decisão bidirecional e execução sequencial com falha parcial", () => {
  test("aprovar-exceto-1: exceção reprovada libera o bloqueio; demais executam em sequência; falha isolada mantém o bloqueio", async () => {
    const props = [6201, 6202, 6203, 6204];
    const criada = (await criarLoteMover(sidMaria, props)).json() as Record<string, any>;
    const id = criada.requisicao.id as string;
    const itens = (await detalhe(id)).itens as Array<Record<string, any>>;

    // Maker-checker herdado: a própria criadora não decide o lote.
    const propria = await decidir(sidMaria, id, "aprovar");
    assert.equal(propria.statusCode, 403);

    // A Sinqia rejeitará a movimentação da 6203 (falha parcial isolada).
    rejeitarExecucaoDe.add(6203);

    // Aprovar-exceto-6202 (exceção com motivo obrigatório — RN03 da US-06).
    const excecao = itens.find((i) => i.documento === "6202")!;
    const semMotivo = await decidir(sidJoao, id, "aprovar", {
      excecoes: [{ itemId: excecao.id, motivo: " " }],
    });
    assert.equal(semMotivo.statusCode, 400);

    const res = await decidir(sidJoao, id, "aprovar", {
      excecoes: [{ itemId: excecao.id, motivo: "proposta aguarda documentação" }],
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal((res.json() as any).execucao.aprovados, 3);
    await aguardarConclusao(id);

    // Execução SEQUENCIAL na sessão do APROVADOR, na ordem da seleção.
    assert.deepEqual(
      transferenciasExecucao.map((t) => t.input.nrProsp),
      [6201, 6203, 6204],
      "uma chamada por item aprovado, em ordem — a exceção nunca foi à Sinqia",
    );
    assert.ok(transferenciasExecucao.every((t) => t.token === "token-joao"));

    // Placar: 2 executadas, 1 falha (Sinqia rejeitou), 1 reprovada (exceção).
    const det = await detalhe(id, sidJoao);
    assert.equal(det.requisicao.estado, "falha", "≥1 falha → lote falha (RN01)");
    assert.equal(det.placar.executadas, 2);
    assert.equal(det.placar.falhas, 1);
    assert.equal(det.placar.reprovadas, 1);
    const porDoc = new Map(
      (det.itens as Array<Record<string, any>>).map((i) => [i.documento, i]),
    );
    assert.equal(porDoc.get("6202")!.estado, "reprovada");
    assert.equal(porDoc.get("6202")!.motivo, "proposta aguarda documentação");
    assert.equal(porDoc.get("6203")!.estado, "falha");
    assert.equal(porDoc.get("6203")!.resultado.causa, "movimentacao_rejeitada");
    assert.match(String(porDoc.get("6203")!.resultado.mensagens), /não confirmou/i);

    // Bloqueios pós-execução: executada/reprovada LIBERAM; falha MANTÉM.
    const movs = await movimentacoesAtivas();
    assert.equal(movs.filter((m) => [6201, 6202, 6204].includes(m.nrProsp)).length, 0);
    const falhada = movs.find((m) => m.nrProsp === 6203);
    assert.equal(falhada?.estado, "falha");
    assert.equal(falhada?.causaFalha, "movimentacao_rejeitada");
    const nova = await criarRequisicaoMoverIndividual(sidAna, 6203);
    assert.equal(nova.statusCode, 409, "falha de item de lote mantém o bloqueio (US-10 resolve)");
    const liberada = await criarRequisicaoMoverIndividual(sidAna, 6202);
    assert.equal(liberada.statusCode, 201, "exceção reprovada liberou a proposta");
    await decidir(sidAna, (liberada.json() as any).requisicao.id, "cancelar");
  });

  test("divergência externa em UM item não interrompe os demais (verificação por item da US-08)", async () => {
    const props = [6211, 6212];
    const criada = (await criarLoteMover(sidMaria, props)).json() as Record<string, any>;
    const id = criada.requisicao.id as string;

    // 6211 foi movida por fora (Portal Sinqia) depois da criação do lote.
    statusAtualDaProposta.set(6211, 20040);

    const res = await decidir(sidJoao, id, "aprovar");
    assert.equal(res.statusCode, 200, res.body);
    await aguardarConclusao(id);

    const det = await detalhe(id, sidJoao);
    const porDoc = new Map(
      (det.itens as Array<Record<string, any>>).map((i) => [i.documento, i]),
    );
    assert.equal(porDoc.get("6211")!.estado, "falha");
    assert.equal(porDoc.get("6211")!.resultado.causa, "divergencia_externa");
    assert.equal(porDoc.get("6212")!.estado, "executada");
    // Só a 6212 chegou ao transfStatus — a divergente falhou na verificação.
    assert.deepEqual(
      transferenciasExecucao.map((t) => t.input.nrProsp),
      [6212],
    );
  });
});

describe("US-09 Cenário 4 — bloqueio mútuo individual×lote (fonte única, corrida simulada)", () => {
  test("direção lote→individual: item ativo de lote bloqueia a requisição individual", async () => {
    const criada = (await criarLoteMover(sidMaria, [6301])).json() as Record<string, any>;

    const individual = await criarRequisicaoMoverIndividual(sidAna, 6301);
    assert.equal(individual.statusCode, 409);
    const corpo = individual.json() as Record<string, any>;
    assert.equal(corpo.code, "MOVIMENTACAO_BLOQUEADA");
    assert.equal(corpo.requisicaoExistente.id, criada.requisicao.id);
    assert.equal(corpo.requisicaoExistente.lote, true);

    await decidir(sidMaria, criada.requisicao.id, "cancelar");
  });

  test("direção individual→lote: requisição individual ativa torna a proposta inelegível no lote", async () => {
    const seed = await criarRequisicaoMoverIndividual(sidMaria, 6310);
    assert.equal(seed.statusCode, 201);

    const res = await criarLoteMover(sidAna, [6310]);
    assert.equal(res.statusCode, 409);
    const corpo = res.json() as Record<string, any>;
    assert.equal(corpo.code, "MOVIMENTACAO_BLOQUEADA");
    assert.equal(corpo.inelegiveis[0].nrProsp, 6310);
    assert.equal(corpo.inelegiveis[0].lote, false, "o bloqueio vem de requisição individual");

    await decidir(sidMaria, (seed.json() as any).requisicao.id, "cancelar");
  });

  test("corrida simulada individual×lote: exatamente UMA vence, nas duas ordens", async () => {
    const [a, b] = await Promise.all([
      criarLoteMover(sidMaria, [6320]),
      criarRequisicaoMoverIndividual(sidAna, 6320),
    ]);
    assert.deepEqual([a.statusCode, b.statusCode].sort(), [201, 409]);
    let movs = await movimentacoesAtivas();
    assert.equal(movs.filter((m) => m.nrProsp === 6320).length, 1, "um único bloqueio ativo");
    const vencedora = a.statusCode === 201 ? a : b;
    await decidir(
      a.statusCode === 201 ? sidMaria : sidAna,
      (vencedora.json() as any).requisicao.id,
      "cancelar",
    );

    const [c, d] = await Promise.all([
      criarRequisicaoMoverIndividual(sidAna, 6321),
      criarLoteMover(sidMaria, [6321]),
    ]);
    assert.deepEqual([c.statusCode, d.statusCode].sort(), [201, 409]);
    movs = await movimentacoesAtivas();
    assert.equal(movs.filter((m) => m.nrProsp === 6321).length, 1);
  });

  test("corrida lote×lote além da pré-checagem: o índice do banco decide, inclusive com item em falha", async () => {
    // Item de lote em FALHA segura o bloqueio (mesma régua da US-08)...
    const criada = (await criarLoteMover(sidMaria, [6330])).json() as Record<string, any>;
    const id = criada.requisicao.id as string;
    rejeitarExecucaoDe.add(6330);
    await decidir(sidJoao, id, "aprovar");
    await aguardarConclusao(id);
    assert.equal(servico.movimentacaoAtivaPorProposta(6330)?.estado, "falha");

    // ...e um INSERT que chegue DIRETO ao repositório (corrida além da
    // pré-checagem do domínio) aborta no índice parcial `idx_sod_itens_mov_ativa`.
    assert.throws(
      () =>
        repo.criarRequisicaoLote(
          {
            id: "22222222-2222-4222-8222-222222222222",
            tipo: "proposta.movimentar_massa",
            payload: {},
            requisitante: "ana.lima",
            criadoEm: new Date().toISOString(),
          },
          [
            {
              id: "33333333-3333-4333-8333-333333333333",
              ordem: 1,
              tipo: "proposta.movimentar",
              payload: {},
              documento: "6330",
            },
          ],
          {
            requisicaoId: "22222222-2222-4222-8222-222222222222",
            ator: "ana.lima",
            acao: "requisicao_criada",
            detalhe: {},
            resultado: "ok",
            ts: new Date().toISOString(),
          },
        ),
      /UNIQUE constraint failed/,
      "o índice de bloqueio de itens decide a corrida mesmo com o existente em falha",
    );

    // E o serviço aponta o bloqueio estruturado (fonte única consultável).
    const ativa = servico.movimentacaoAtivaPorProposta(6330);
    assert.equal(ativa?.id, id);
    assert.ok(ativa?.itemId, "o bloqueio vem de um item de lote");
  });
});

describe("US-09 Regressão — fluxo direto intacto e corte à prova de corrida", () => {
  test("flag OFF: a rota dispara o job direto (jobId), zero requisições SoD", async () => {
    toggleMassa = false;
    const antes = (await movimentacoesAtivas()).length;

    const res = await criarLoteMover(sidMaria, [6401]);
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as Record<string, any>;
    assert.ok(body.jobId, "job de transferência direto iniciado");
    assert.equal(body.total, 1);
    assert.equal(body.aprovacao, undefined);

    assert.equal((await movimentacoesAtivas()).length, antes, "nenhuma requisição criada");
  });

  test("guard de corte: flag ativada ENTRE o desvio e a execução → 409, zero job", async () => {
    // 1ª leitura (desvio) devolve false; 2ª (guard) devolve true — simula a
    // flag virando no meio da requisição HTTP.
    let leituras = 0;
    aprovacaoAtivaOverride = (tipo) =>
      tipo === "proposta.movimentar_massa" ? leituras++ > 0 : false;

    const res = await criarLoteMover(sidMaria, [6402]);
    assert.equal(res.statusCode, 409);
    assert.equal((res.json() as any).code, "ACAO_SOB_APROVACAO");
    assert.equal(transferenciasDiretas.length, 0);
  });

  test("regressão US-08: individual segue funcionando com o massa ligado", async () => {
    const res = await criarRequisicaoMoverIndividual(sidMaria, 6410);
    assert.equal(res.statusCode, 201);
    const id = (res.json() as any).requisicao.id as string;
    const aprova = await decidir(sidJoao, id, "aprovar");
    assert.equal(aprova.statusCode, 200);
    assert.equal((aprova.json() as any).requisicao.estado, "executada");
    assert.equal(transferenciasExecucao.at(-1)?.input.nrProsp, 6410);
  });
});
