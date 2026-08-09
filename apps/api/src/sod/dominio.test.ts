import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, beforeEach, describe, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { abrirBancoSod, criarSodRepositorio, type SodRepositorio } from "./repositorio.js";
import { criarSodServico, SodError, type SodServico } from "./dominio.js";

/**
 * Testes da fundação SoD (US-01) — domínio + repositório sobre banco SQLite
 * REAL em arquivo temporário (o cenário 1 exige fechar e REABRIR o arquivo,
 * coisa que banco em memória não exercita).
 */

const AMBIENTE = "hml";
const dir = mkdtempSync(path.join(tmpdir(), "sod-us01-"));
let seq = 0;
const abertos: DatabaseSync[] = [];

after(() => {
  // No Windows, arquivos WAL só liberam com a conexão fechada; a remoção do
  // temp é melhor-esforço (o SO limpa o que sobrar).
  for (const db of abertos) {
    try {
      db.close();
    } catch {
      /* já fechada pelo teste */
    }
  }
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* melhor-esforço */
  }
});

interface Ctx {
  caminho: string;
  db: DatabaseSync;
  repo: SodRepositorio;
  servico: SodServico;
}

function novoCtx(): Ctx {
  const caminho = path.join(dir, `sod-${seq++}.db`);
  const db = abrirBancoSod(caminho);
  abertos.push(db);
  const repo = criarSodRepositorio(db, AMBIENTE);
  return { caminho, db, repo, servico: criarSodServico(repo) };
}

const PAYLOAD = { cliente: { nrCpfCnpj: "15032465070", dsNome: "Fulana Fixture" } };

function criarPendente(s: SodServico, requisitante = "maria.silva") {
  return s.criarRequisicao({ tipo: "tomador.cadastrar", payload: PAYLOAD, requisitante });
}

/** Leva uma requisição recém-criada até `falha` (aprova + conclui em falha). */
function criarEmFalha(s: SodServico) {
  const req = criarPendente(s);
  s.aprovar(req.id, "joao.souza");
  return s.concluirExecucao(req.id, "joao.souza", "falha", { erro: "timeout Sinqia (fixture)" });
}

let ctx: Ctx;
beforeEach(() => {
  ctx = novoCtx();
});

/* ------------------------------------------------------------------ */
/* Cenário 1 — criação persistida + auditoria + sobrevive a reinício   */
/* ------------------------------------------------------------------ */

describe("cenário 1 — criação de requisição", () => {
  test("persiste tipo, payload integral, requisitante normalizado, timestamp e estado pendente", () => {
    const antes = new Date().toISOString();
    const req = ctx.servico.criarRequisicao({
      tipo: "tomador.cadastrar",
      payload: PAYLOAD,
      requisitante: "  Maria.SILVA ", // RN05: trim + case-insensitive
    });

    assert.equal(req.tipo, "tomador.cadastrar");
    assert.deepEqual(req.payload, PAYLOAD);
    assert.equal(req.requisitante, "maria.silva");
    assert.equal(req.estado, "pendente");
    assert.ok(req.criadoEm >= antes && req.criadoEm <= new Date().toISOString());

    const historico = ctx.repo.eventosDaRequisicao(req.id);
    assert.equal(historico.length, 1);
    assert.equal(historico[0].acao, "requisicao_criada");
    assert.equal(historico[0].ator, "maria.silva");
    assert.equal(historico[0].resultado, "ok");
  });

  test("dados sobrevivem a reinício do processo (fecha e reabre o arquivo do banco)", () => {
    const req = criarPendente(ctx.servico);
    ctx.db.close();

    // "Reinício": nova conexão + novo repositório sobre o MESMO arquivo.
    const db2 = abrirBancoSod(ctx.caminho);
    const repo2 = criarSodRepositorio(db2, AMBIENTE);
    const relida = repo2.obterRequisicao(req.id);
    assert.ok(relida, "requisição deve existir após reabertura");
    assert.equal(relida.estado, "pendente");
    assert.deepEqual(relida.payload, PAYLOAD);
    assert.equal(repo2.eventosDaRequisicao(req.id).length, 1);
    db2.close();
  });
});

/* ------------------------------------------------------------------ */
/* Cenário 2 — transição inválida                                      */
/* ------------------------------------------------------------------ */

describe("cenário 2 — transições inválidas", () => {
  test("pendente → executada direto é rejeitada, estado inalterado, tentativa auditada", () => {
    const req = criarPendente(ctx.servico);
    assert.throws(
      () => ctx.servico.concluirExecucao(req.id, "joao.souza", "executada"),
      (e: unknown) => e instanceof SodError && e.codigo === "TRANSICAO_INVALIDA",
    );
    assert.equal(ctx.repo.obterRequisicao(req.id)?.estado, "pendente");

    const rejeitadas = ctx.repo
      .eventosDaRequisicao(req.id)
      .filter((ev) => ev.acao === "tentativa_rejeitada");
    assert.equal(rejeitadas.length, 1);
    assert.equal(rejeitadas[0].resultado, "rejeitada:transicao_invalida");
    assert.equal(rejeitadas[0].detalhe.de, "pendente");
    assert.equal(rejeitadas[0].detalhe.para, "executada");
  });

  test("estado terminal não transiciona (reprovada → aprovar)", () => {
    const req = criarPendente(ctx.servico);
    ctx.servico.reprovar(req.id, "joao.souza", "documentação divergente");
    assert.throws(
      () => ctx.servico.aprovar(req.id, "joao.souza"),
      (e: unknown) => e instanceof SodError && e.codigo === "TRANSICAO_INVALIDA",
    );
    assert.equal(ctx.repo.obterRequisicao(req.id)?.estado, "reprovada");
  });

  test("corrida: decisão sobre estado defasado perde para a primeira (UPDATE atômico)", () => {
    const req = criarPendente(ctx.servico);
    ctx.servico.aprovar(req.id, "joao.souza");
    // Simula segundo decisor com leitura defasada: UPDATE com guarda de estado antigo.
    const aplicou = ctx.repo.transicionar({
      id: req.id,
      de: "pendente", // já não é mais
      para: "reprovada",
      agora: new Date().toISOString(),
      evento: {
        requisicaoId: req.id,
        ator: "ana.lima",
        acao: "transicao_estado",
        detalhe: {},
        resultado: "ok",
        ts: new Date().toISOString(),
      },
    });
    assert.equal(aplicou, false, "segunda decisão não pode vencer");
    assert.equal(ctx.repo.obterRequisicao(req.id)?.estado, "aprovada/executando");
  });
});

/* ------------------------------------------------------------------ */
/* Cenário 3 — maker-checker (RN03)                                    */
/* ------------------------------------------------------------------ */

describe("cenário 3 — violação de SoD (aprovador == criador)", () => {
  for (const variacao of ["maria.silva", "MARIA.SILVA", "  Maria.Silva  "]) {
    test(`aprovação pelo criador é rejeitada (login "${variacao}")`, () => {
      const req = criarPendente(ctx.servico, "maria.silva");
      assert.throws(
        () => ctx.servico.aprovar(req.id, variacao),
        (e: unknown) => e instanceof SodError && e.codigo === "VIOLACAO_SOD",
      );
      assert.equal(ctx.repo.obterRequisicao(req.id)?.estado, "pendente");

      const rejeitadas = ctx.repo
        .eventosDaRequisicao(req.id)
        .filter((ev) => ev.resultado === "rejeitada:violacao_sod");
      assert.equal(rejeitadas.length, 1);
      assert.equal(rejeitadas[0].ator, "maria.silva");
    });
  }

  test("reprovação pelo criador também viola SoD", () => {
    const req = criarPendente(ctx.servico, "maria.silva");
    assert.throws(
      () => ctx.servico.reprovar(req.id, "Maria.SILVA", "tentando reprovar a mim mesma"),
      (e: unknown) => e instanceof SodError && e.codigo === "VIOLACAO_SOD",
    );
    assert.equal(ctx.repo.obterRequisicao(req.id)?.estado, "pendente");
  });

  test("retry pelo requisitante viola SoD (regra da US-10 já garantida)", () => {
    const emFalha = criarEmFalha(ctx.servico);
    assert.throws(
      () => ctx.servico.retryFalha(emFalha.id, "maria.silva"),
      (e: unknown) => e instanceof SodError && e.codigo === "VIOLACAO_SOD",
    );
    assert.equal(ctx.repo.obterRequisicao(emFalha.id)?.estado, "falha");
  });
});

/* ------------------------------------------------------------------ */
/* Cenário 4 — auditoria append-only (RN06)                            */
/* ------------------------------------------------------------------ */

describe("cenário 4 — trilha de auditoria imutável", () => {
  test("o repositório não expõe update/delete de eventos", () => {
    const metodos = Object.keys(ctx.repo);
    const mutadores = metodos.filter((m) => /update|delete|remover|alterar|apagar/i.test(m));
    assert.deepEqual(mutadores, [], `métodos mutadores de auditoria encontrados: ${mutadores}`);
  });

  test("UPDATE/DELETE direto na tabela são rejeitados pelo banco (trigger)", () => {
    const req = criarPendente(ctx.servico);
    const evento = ctx.repo.eventosDaRequisicao(req.id)[0];
    assert.throws(
      () => ctx.db.prepare("UPDATE sod_auditoria SET ator = 'adulterado' WHERE id = ?").run(evento.id),
      /append-only/,
    );
    assert.throws(
      () => ctx.db.prepare("DELETE FROM sod_auditoria WHERE id = ?").run(evento.id),
      /append-only/,
    );
    // Nada mudou.
    const relido = ctx.repo.eventosDaRequisicao(req.id)[0];
    assert.equal(relido.ator, "maria.silva");
  });
});

/* ------------------------------------------------------------------ */
/* Transições válidas — máquina completa                               */
/* ------------------------------------------------------------------ */

describe("transições válidas", () => {
  test("pendente → aprovada/executando → executada (aprovação por segundo operador + conclusão)", () => {
    const req = criarPendente(ctx.servico);
    const aprovada = ctx.servico.aprovar(req.id, "Joao.SOUZA");
    assert.equal(aprovada.estado, "aprovada/executando");
    assert.equal(aprovada.decididoPor, "joao.souza");

    const executada = ctx.servico.concluirExecucao(req.id, "joao.souza", "executada", {
      nrClient: 6874,
    });
    assert.equal(executada.estado, "executada");
    assert.deepEqual(executada.resultado, { nrClient: 6874 });

    const transicoes = ctx.repo
      .eventosDaRequisicao(req.id)
      .filter((ev) => ev.acao === "transicao_estado");
    assert.deepEqual(
      transicoes.map((ev) => `${ev.detalhe.de}→${ev.detalhe.para}`),
      ["pendente→aprovada/executando", "aprovada/executando→executada"],
    );
  });

  test("pendente → reprovada registra decisor e motivo", () => {
    const req = criarPendente(ctx.servico);
    const reprovada = ctx.servico.reprovar(req.id, "joao.souza", "renda incompatível");
    assert.equal(reprovada.estado, "reprovada");
    assert.equal(reprovada.motivo, "renda incompatível");
    const ev = ctx.repo
      .eventosDaRequisicao(req.id)
      .find((e) => e.acao === "transicao_estado");
    assert.equal(ev?.detalhe.motivo, "renda incompatível");
  });

  test("aprovada/executando → falha anexa o erro integral", () => {
    const emFalha = criarEmFalha(ctx.servico);
    assert.equal(emFalha.estado, "falha");
    assert.deepEqual(emFalha.resultado, { erro: "timeout Sinqia (fixture)" });
  });

  test("falha → aprovada/executando (retry por segundo operador)", () => {
    const emFalha = criarEmFalha(ctx.servico);
    const retry = ctx.servico.retryFalha(emFalha.id, "ana.lima");
    assert.equal(retry.estado, "aprovada/executando");
    assert.equal(retry.decididoPor, "ana.lima");
  });

  test("falha → descartada exige motivo", () => {
    const emFalha = criarEmFalha(ctx.servico);
    assert.throws(
      () => ctx.servico.descartarFalha(emFalha.id, "ana.lima", "   "),
      (e: unknown) => e instanceof SodError && e.codigo === "MOTIVO_OBRIGATORIO",
    );
    assert.equal(ctx.repo.obterRequisicao(emFalha.id)?.estado, "falha");

    const descartada = ctx.servico.descartarFalha(emFalha.id, "ana.lima", "cadastro feito direto na Sinqia");
    assert.equal(descartada.estado, "descartada");
    assert.equal(descartada.motivo, "cadastro feito direto na Sinqia");
  });

  test("reprovar sem motivo é rejeitado e auditado (RN07)", () => {
    const req = criarPendente(ctx.servico);
    assert.throws(
      () => ctx.servico.reprovar(req.id, "joao.souza", undefined),
      (e: unknown) => e instanceof SodError && e.codigo === "MOTIVO_OBRIGATORIO",
    );
    assert.equal(ctx.repo.obterRequisicao(req.id)?.estado, "pendente");
    const ev = ctx.repo
      .eventosDaRequisicao(req.id)
      .find((e) => e.resultado === "rejeitada:motivo_obrigatorio");
    assert.ok(ev, "tentativa sem motivo deve ser auditada");
  });
});

/* ------------------------------------------------------------------ */
/* Cancelamento                                                        */
/* ------------------------------------------------------------------ */

describe("cancelamento", () => {
  test("criador cancela em pendente (variação de caixa no login)", () => {
    const req = criarPendente(ctx.servico, "maria.silva");
    const cancelada = ctx.servico.cancelar(req.id, " MARIA.silva ");
    assert.equal(cancelada.estado, "cancelada");
  });

  test("terceiro não cancela", () => {
    const req = criarPendente(ctx.servico, "maria.silva");
    assert.throws(
      () => ctx.servico.cancelar(req.id, "joao.souza"),
      (e: unknown) => e instanceof SodError && e.codigo === "CANCELAMENTO_NEGADO",
    );
    assert.equal(ctx.repo.obterRequisicao(req.id)?.estado, "pendente");
    const ev = ctx.repo
      .eventosDaRequisicao(req.id)
      .find((e) => e.resultado === "rejeitada:cancelamento_negado");
    assert.ok(ev, "cancelamento por terceiro deve ser auditado");
  });

  test("não cancela fora de pendente", () => {
    const req = criarPendente(ctx.servico, "maria.silva");
    ctx.servico.aprovar(req.id, "joao.souza");
    assert.throws(
      () => ctx.servico.cancelar(req.id, "maria.silva"),
      (e: unknown) => e instanceof SodError && e.codigo === "TRANSICAO_INVALIDA",
    );
    assert.equal(ctx.repo.obterRequisicao(req.id)?.estado, "aprovada/executando");
  });
});

/* ------------------------------------------------------------------ */
/* Listagens e filtros (base dos endpoints)                            */
/* ------------------------------------------------------------------ */

describe("listagens", () => {
  test("filtros por estado/tipo/requisitante e paginação", () => {
    const a = criarPendente(ctx.servico, "maria.silva");
    criarPendente(ctx.servico, "ana.lima");
    ctx.servico.aprovar(a.id, "joao.souza");

    assert.equal(ctx.servico.listarRequisicoes({ limit: 50, offset: 0 }).total, 2);
    const pendentes = ctx.servico.listarRequisicoes({ estado: "pendente", limit: 50, offset: 0 });
    assert.equal(pendentes.total, 1);
    assert.equal(pendentes.itens[0].requisitante, "ana.lima");
    const deMaria = ctx.servico.listarRequisicoes({
      requisitante: "maria.silva",
      limit: 50,
      offset: 0,
    });
    assert.equal(deMaria.total, 1);
    const pagina = ctx.servico.listarRequisicoes({ limit: 1, offset: 1 });
    assert.equal(pagina.itens.length, 1);
    assert.equal(pagina.total, 2);
  });

  test("auditoria filtra por ator, requisição e período", () => {
    const req = criarPendente(ctx.servico, "maria.silva");
    ctx.servico.aprovar(req.id, "joao.souza");

    const doJoao = ctx.servico.listarAuditoria({ ator: "joao.souza", limit: 50, offset: 0 });
    assert.equal(doJoao.total, 1);
    assert.equal(doJoao.itens[0].acao, "transicao_estado");

    const daReq = ctx.servico.listarAuditoria({ requisicaoId: req.id, limit: 50, offset: 0 });
    assert.equal(daReq.total, 2); // criação + transição

    const futuro = ctx.servico.listarAuditoria({
      de: "2999-01-01T00:00:00.000Z",
      limit: 50,
      offset: 0,
    });
    assert.equal(futuro.total, 0);
  });
});
