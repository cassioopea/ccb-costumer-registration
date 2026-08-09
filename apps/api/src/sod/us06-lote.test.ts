import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
// Import SOMENTE de tipo: apagado na compilação, não dispara o load do env.ts.
import type { CadastroResult } from "./../sinqia-client.js";

/**
 * US-06 — Requisição-lote de tomadores com decisão bidirecional.
 *
 * Cobre os cenários da história ponta a ponta no BFF, offline (Sinqia
 * simulada por spy nas deps injetáveis):
 *  1. upload válido (flag ON) → requisição-lote `pendente` com N itens,
 *     ZERO Sinqia; duplicidade TRIDIMENSIONAL (RN06) apontada antes;
 *  2. aprovar-exceto-N → exceções reprovadas com motivo por item; demais
 *     executados SEQUENCIALMENTE na sessão do aprovador; falha parcial não
 *     interrompe (RN04); placar e estado derivado (RN01) corretos;
 *  3. reprovar-todos e reprovar-exceto-N → direções corretas, motivos
 *     propagados, zero Sinqia para reprovados;
 *  4. interrupção no item K (sessão expirada) → 1..K-1 preservados, K..N em
 *     `falha` com causa; reexecução FORÇADA não duplica nada (RN05);
 *  + maker-checker no lote, concorrência de decisão, cancelamento em cascata,
 *    lote grande (70) com falhas injetadas e regressão do fluxo direto.
 */
process.env.SINQIA_BASE_URL ??= "https://sinqia.fixture.invalid";
process.env.SINQIA_ENV ??= "hml";

const dir = mkdtempSync(path.join(tmpdir(), "sod-us06-"));
process.env.SQLITE_PATH = path.join(dir, "app.db");

const { EXEMPLO_PF, normalizarDocumento } = await import("@cadastro-lote/shared");
const { abrirBancoSod, criarSodRepositorio } = await import("./repositorio.js");
const { criarSodServico } = await import("./dominio.js");
const { registerSodRoutes } = await import("./rotas.js");
const { registerRoutes } = await import("./../routes.js");
const { iniciarExecucaoLote } = await import("./execucao-lote.js");
const { parseFlatRow } = await import("./../parse-input.js");
const { createSession, limparSessoes } = await import("./../session.js");

let app: FastifyInstance;
let db: ReturnType<typeof abrirBancoSod>;
let servico: ReturnType<typeof criarSodServico>;
let sidMaria: string; // requisitante
let sidJoao: string; // aprovador
let sidAna: string; // segunda aprovadora

/** Flags ativas do teste — o `aprovacaoAtivaFn` injetado lê daqui. */
const flagsAtivas = new Set<string>();

/** Toda execução disparada por aprovação cai aqui: token + request + doc. */
const execucoes: Array<{ token: string; doc: string; body: unknown }> = [];
/** Sonda de sessão (RN03) controlável; conta as consultas. */
let sessaoSinqia: "valida" | "invalida" | "indisponivel" = "valida";
let sondagens = 0;
/** Comportamento da "Sinqia" por documento — cada teste arma o seu. */
let responderPorDoc: (doc: string) => Promise<CadastroResult> = () => respostaSucesso();

async function respostaSucesso(): Promise<CadastroResult> {
  return {
    httpStatus: 200,
    envelope: {
      status: "OK",
      messages: [{ type: "Sucesso", message: "6874" }],
    } as CadastroResult["envelope"],
    analysis: { ok: true, envelopeStatus: "OK", messagesText: "Sucesso | 6874", messages: [] },
  };
}

async function respostaErroNegocio(): Promise<CadastroResult> {
  return {
    httpStatus: 200,
    envelope: {
      status: "ERRO",
      messages: [{ type: "Erro", message: "CEP inválido" }],
    } as CadastroResult["envelope"],
    analysis: {
      ok: false,
      envelopeStatus: "ERRO",
      messagesText: "Erro | CEP inválido",
      messages: [],
      reason: "consistências reprovadas",
    },
  };
}

async function resposta401(): Promise<CadastroResult> {
  return {
    httpStatus: 401,
    envelope: {} as CadastroResult["envelope"],
    analysis: { ok: false, envelopeStatus: "", messagesText: "", messages: [] },
  };
}

before(async () => {
  db = abrirBancoSod(path.join(dir, "sod.db"));
  servico = criarSodServico(criarSodRepositorio(db, "hml"));

  app = Fastify();
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024, files: 1 } });
  await registerRoutes(app, {
    cadastrarClienteFn: async () => {
      throw new Error("o fluxo direto individual não deve ser chamado nestes testes");
    },
    sodServico: () => servico,
    aprovacaoAtivaFn: (tipo) => flagsAtivas.has(tipo),
  });
  await registerSodRoutes(app, servico, {
    verificarSessaoSinqiaFn: async () => {
      sondagens++;
      return sessaoSinqia;
    },
    cadastrarClienteFn: async (token, body) => {
      const doc = normalizarDocumento(
        String((body as { cliente?: { nrCpfCnpj?: string } }).cliente?.nrCpfCnpj ?? ""),
      );
      execucoes.push({ token, doc, body });
      return responderPorDoc(doc);
    },
  });
  await app.ready();
});

beforeEach(() => {
  flagsAtivas.clear();
  flagsAtivas.add("tomador.cadastrar_lote");
  sessaoSinqia = "valida";
  sondagens = 0;
  responderPorDoc = () => respostaSucesso();
  // Sessões novas a CADA teste: o Cenário 4 destrói a sessão do aprovador
  // (comportamento correto no 401) e não pode contaminar os demais.
  // Tokens DISTINTOS por operador: prova de que a execução usa a sessão do
  // APROVADOR (B2'), item a item.
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

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

let seq = 0;
/** Documento único por chamada (11 dígitos, prefixo do teste). */
function doc(prefixo: string): string {
  seq++;
  return `${prefixo}${String(seq).padStart(11 - prefixo.length, "0")}`;
}

/** Arquivo JSON do lote: um cliente válido por documento (formato EXEMPLO_PF). */
function arquivoLote(documentos: string[]): string {
  return JSON.stringify(
    documentos.map((d, i) =>
      parseFlatRow({ ...EXEMPLO_PF, nrCpfCnpj: d, dsNome: `Tomador Lote ${i + 1}` }),
    ),
  );
}

function multipartInject(
  url: string,
  sid: string,
  conteudo: string,
  filename = "lote.json",
  control: Record<string, unknown> = {},
) {
  const b = "----us06boundary";
  const body = [
    `--${b}`,
    `Content-Disposition: form-data; name="control"`,
    ``,
    JSON.stringify(control),
    `--${b}`,
    `Content-Disposition: form-data; name="file"; filename="${filename}"`,
    `Content-Type: application/json`,
    ``,
    conteudo,
    `--${b}--`,
    ``,
  ].join("\r\n");
  return app.inject({
    method: "POST",
    url,
    cookies: { sid },
    headers: { "content-type": `multipart/form-data; boundary=${b}` },
    payload: body,
  });
}

function post(url: string, sid: string, payload: unknown) {
  return app.inject({
    method: "POST",
    url,
    cookies: { sid },
    payload: payload as Record<string, unknown>,
  });
}

function get(url: string, sid: string) {
  return app.inject({ method: "GET", url, cookies: { sid } });
}

/** Cria uma requisição-lote pendente REAL via /api/import (flag ON). */
async function criarLote(documentos: string[], sid = sidMaria): Promise<string> {
  const r = await multipartInject("/api/import", sid, arquivoLote(documentos));
  assert.equal(r.statusCode, 201, r.body);
  const json = r.json();
  assert.equal(json.aprovacao, true);
  assert.equal(json.requisicao.totalItens, documentos.length);
  return json.requisicao.id as string;
}

function decidirLote(
  id: string,
  sid: string,
  decisao: string,
  extra: Record<string, unknown> = {},
) {
  return post(`/api/sod/requisicoes/${id}/decisao`, sid, { decisao, ...extra });
}

async function detalhe(id: string, sid = sidMaria) {
  const r = await get(`/api/sod/requisicoes/${id}`, sid);
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
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

/* ------------------------------------------------------------------ */
/* Cenário 1 — criação                                                 */
/* ------------------------------------------------------------------ */

describe("US-06 — Cenário 1: upload válido vira requisição-lote pendente", () => {
  test("lote pendente com N itens, payload integral por item, ZERO Sinqia, visível nas telas", async () => {
    const docs = [doc("91"), doc("91"), doc("91")];
    const antes = execucoes.length;
    const id = await criarLote(docs);
    assert.equal(execucoes.length, antes, "criação nunca chama a Sinqia");

    const d = await detalhe(id);
    assert.equal(d.requisicao.estado, "pendente");
    assert.equal(d.requisicao.tipo, "tomador.cadastrar_lote");
    assert.equal(d.placar.total, 3);
    assert.equal(d.placar.pendentes, 3);
    assert.equal(d.itens.length, 3);
    assert.deepEqual(
      d.itens.map((i: { ordem: number }) => i.ordem),
      [1, 2, 3],
      "itens na ordem do arquivo",
    );
    for (const item of d.itens) {
      assert.equal(item.estado, "pendente");
      assert.ok(item.resumo.nome.startsWith("Tomador Lote"));
    }

    // Item integral: payload com o request Sinqia montado na criação (RN08).
    const ri = await get(`/api/sod/requisicoes/${id}/itens/${d.itens[0].id}`, sidMaria);
    assert.equal(ri.statusCode, 200, ri.body);
    const item = ri.json().item;
    assert.equal(
      normalizarDocumento(item.payload.request.cliente.nrCpfCnpj),
      docs[0],
      "request persistido por item",
    );

    // Visível em "Minhas requisições" (filtro pela sessão).
    const minhas = await get(`/api/sod/requisicoes?minhas=1&estado=pendente&limit=50&offset=0`, sidMaria);
    const itens = minhas.json().itens as Array<{ id: string; payload: { arquivo?: { totalItens?: number } } }>;
    const linha = itens.find((r) => r.id === id);
    assert.ok(linha, "lote listado nas minhas requisições");
    assert.equal(linha.payload.arquivo?.totalItens, 3, "contagem disponível para as telas");
  });

  test("arquivo com linha inválida NÃO vira requisição (o aprovador confere mérito, não formato)", async () => {
    const invalido = JSON.stringify([
      parseFlatRow({ ...EXEMPLO_PF, nrCpfCnpj: doc("91"), dsNome: "Válido" }),
      parseFlatRow({ ...EXEMPLO_PF, nrCpfCnpj: "123", dsNome: "Doc inválido" }),
    ]);
    const r = await multipartInject("/api/import", sidMaria, invalido);
    assert.equal(r.statusCode, 422, r.body);
    assert.equal(r.json().invalidas, 1);
  });

  test("RN06 dimensão 1 — duplicidade DENTRO do arquivo: apontada no validate e bloqueia o import", async () => {
    const repetido = doc("92");
    const conteudo = arquivoLote([repetido, doc("92"), repetido]);

    const v = await multipartInject("/api/validate", sidMaria, conteudo);
    assert.equal(v.statusCode, 200, v.body);
    const vj = v.json();
    assert.equal(vj.aprovacao, true);
    assert.equal(vj.valido, false, "duplicidade invalida o envio");
    assert.deepEqual(vj.duplicidades.intraArquivo, [{ documento: repetido, ordens: [1, 3] }]);

    const r = await multipartInject("/api/import", sidMaria, conteudo);
    assert.equal(r.statusCode, 409, r.body);
    assert.equal(r.json().code, "DUPLICIDADE_PENDENTE");
    assert.equal(r.json().duplicidades.intraArquivo.length, 1);
  });

  test("RN06 dimensão 2 — documento com requisição INDIVIDUAL pendente bloqueia o lote", async () => {
    // Cria a individual pendente pelo caminho real da US-02 (flag individual ON).
    flagsAtivas.add("tomador.cadastrar");
    const emAprovacao = doc("93");
    const ri = await post("/api/cadastrar", sidMaria, {
      campos: { ...EXEMPLO_PF, nrCpfCnpj: emAprovacao },
      control: {},
      dryRun: false,
    });
    assert.equal(ri.statusCode, 201, ri.body);

    const conteudo = arquivoLote([doc("93"), emAprovacao]);
    const v = await multipartInject("/api/validate", sidMaria, conteudo);
    assert.equal(v.json().duplicidades.pendentesIndividuais.length, 1);

    const r = await multipartInject("/api/import", sidMaria, conteudo);
    assert.equal(r.statusCode, 409, r.body);
    assert.equal(r.json().duplicidades.pendentesIndividuais[0].documento, emAprovacao);
  });

  test("RN06 dimensão 3 — documento pendente em OUTRO lote bloqueia; e a recíproca bloqueia a individual", async () => {
    const compartilhado = doc("94");
    await criarLote([compartilhado, doc("94")]);

    // Outro lote com o mesmo documento → 409 estruturado.
    const r = await multipartInject("/api/import", sidJoao, arquivoLote([doc("94"), compartilhado]));
    assert.equal(r.statusCode, 409, r.body);
    assert.equal(r.json().duplicidades.pendentesLote[0].documento, compartilhado);

    // Recíproca: a INDIVIDUAL do mesmo documento também é bloqueada (RN06).
    flagsAtivas.add("tomador.cadastrar");
    const ri = await post("/api/cadastrar", sidJoao, {
      campos: { ...EXEMPLO_PF, nrCpfCnpj: compartilhado },
      control: {},
      dryRun: false,
    });
    assert.equal(ri.statusCode, 409, ri.body);
    assert.equal(ri.json().code, "DUPLICIDADE_PENDENTE");
  });
});

/* ------------------------------------------------------------------ */
/* Cenário 2 — aprovar com exceções + execução sequencial              */
/* ------------------------------------------------------------------ */

describe("US-06 — Cenário 2: aprovar-exceto-N executa na sessão do aprovador", () => {
  test("exceções reprovadas com motivo; demais executados em ordem com o token do APROVADOR; falha parcial não interrompe", async () => {
    const docs = [doc("95"), doc("95"), doc("95"), doc("95"), doc("95")];
    const id = await criarLote(docs);
    const d0 = await detalhe(id);
    const itens = d0.itens as Array<{ id: string; ordem: number }>;

    // Falha de negócio injetada no 4º documento (RN04: não interrompe).
    responderPorDoc = (dc) => (dc === docs[3] ? respostaErroNegocio() : respostaSucesso());

    const antes = execucoes.length;
    const r = await decidirLote(id, sidJoao, "aprovar", {
      excecoes: [
        { itemId: itens[1].id, motivo: "documentação divergente" },
        { itemId: itens[4].id, motivo: "aguardar atualização cadastral" },
      ],
    });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(sondagens, 1, "pré-verificação de sessão antes da decisão (RN03)");
    assert.equal(r.json().execucao.aprovados, 3);

    await aguardarConclusao(id);
    const d = await detalhe(id);

    // Execução: só os 3 aprovados, na ordem do arquivo, com o token do João.
    const chamadas = execucoes.slice(antes);
    assert.deepEqual(
      chamadas.map((c) => c.doc),
      [docs[0], docs[2], docs[3]],
      "sequencial, na ordem, pulando exceções",
    );
    assert.ok(chamadas.every((c) => c.token === "token-joao"), "sessão do aprovador (B2')");

    // Estados por item + motivos propagados.
    const porOrdem = new Map(
      (d.itens as Array<{ ordem: number; estado: string; motivo: string | null }>).map((i) => [
        i.ordem,
        i,
      ]),
    );
    assert.equal(porOrdem.get(1)!.estado, "executada");
    assert.equal(porOrdem.get(2)!.estado, "reprovada");
    assert.equal(porOrdem.get(2)!.motivo, "documentação divergente");
    assert.equal(porOrdem.get(3)!.estado, "executada");
    assert.equal(porOrdem.get(4)!.estado, "falha", "erro de negócio → falha do ITEM");
    assert.equal(porOrdem.get(5)!.estado, "reprovada");
    assert.equal(porOrdem.get(5)!.motivo, "aguardar atualização cadastral");

    // Placar + estado derivado (RN01): houve falha → lote em `falha` (repouso).
    assert.deepEqual(d.placar, {
      total: 5,
      pendentes: 0,
      executando: 0,
      executadas: 2,
      falhas: 1,
      reprovadas: 2,
      canceladas: 0,
    });
    assert.equal(d.requisicao.estado, "falha");
    assert.equal(d.requisicao.decididoPor, "joao.souza");
    assert.equal(typeof d.requisicao.resultado.duracaoMediaItemMs, "number");
  });

  test("aprovar sem exceções e sem falhas → lote `executada` com placar cheio", async () => {
    const docs = [doc("96"), doc("96")];
    const id = await criarLote(docs);
    const r = await decidirLote(id, sidJoao, "aprovar");
    assert.equal(r.statusCode, 200, r.body);
    await aguardarConclusao(id);
    const d = await detalhe(id);
    assert.equal(d.requisicao.estado, "executada");
    assert.equal(d.placar.executadas, 2);
  });

  test("marcar TODAS as linhas como exceção na aprovação é rejeitado (use a reprovação)", async () => {
    const id = await criarLote([doc("97")]);
    const d = await detalhe(id);
    const r = await decidirLote(id, sidJoao, "aprovar", {
      excecoes: [{ itemId: d.itens[0].id, motivo: "não executar" }],
    });
    assert.equal(r.statusCode, 400, r.body);
    assert.equal(r.json().code, "LOTE_INVALIDO");
    assert.equal((await detalhe(id)).requisicao.estado, "pendente", "nada mudou");
  });
});

/* ------------------------------------------------------------------ */
/* Cenário 3 — reprovações                                             */
/* ------------------------------------------------------------------ */

describe("US-06 — Cenário 3: reprovar-todos e reprovar-exceto-N", () => {
  test("reprovar-todos: motivo obrigatório, propagado aos itens, ZERO Sinqia e ZERO sonda", async () => {
    const id = await criarLote([doc("81"), doc("81")]);

    const semMotivo = await decidirLote(id, sidJoao, "reprovar");
    assert.equal(semMotivo.statusCode, 400, semMotivo.body);
    assert.equal(semMotivo.json().code, "MOTIVO_OBRIGATORIO");

    const antes = execucoes.length;
    const sondas = sondagens;
    const r = await decidirLote(id, sidJoao, "reprovar", { motivo: "lote fora da política" });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(execucoes.length, antes, "reprovação nunca chama a Sinqia");
    assert.equal(sondagens, sondas, "reprovar-todos nem sonda a sessão");

    const d = await detalhe(id);
    assert.equal(d.requisicao.estado, "reprovada");
    assert.equal(d.requisicao.motivo, "lote fora da política");
    for (const item of d.itens) {
      assert.equal(item.estado, "reprovada");
      assert.equal(item.motivo, "lote fora da política", "motivo do lote propagado ao item");
    }
  });

  test("reprovar-exceto-N: exceções são APROVADAS e executadas; demais reprovados com o motivo do lote", async () => {
    const docs = [doc("82"), doc("82"), doc("82")];
    const id = await criarLote(docs);
    const d0 = await detalhe(id);
    const excecao = d0.itens[1];

    const antes = execucoes.length;
    const r = await decidirLote(id, sidJoao, "reprovar", {
      motivo: "fora da política, exceto contrato já assinado",
      excecoes: [{ itemId: excecao.id, motivo: "contrato já assinado — deve seguir" }],
    });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().execucao.aprovados, 1);

    await aguardarConclusao(id);
    const d = await detalhe(id);
    const chamadas = execucoes.slice(antes);
    assert.deepEqual(chamadas.map((c) => c.doc), [docs[1]], "só a exceção executa");

    const porOrdem = new Map(
      (d.itens as Array<{ ordem: number; estado: string; motivo: string | null }>).map((i) => [
        i.ordem,
        i,
      ]),
    );
    assert.equal(porOrdem.get(1)!.estado, "reprovada");
    assert.equal(porOrdem.get(1)!.motivo, "fora da política, exceto contrato já assinado");
    assert.equal(porOrdem.get(2)!.estado, "executada");
    assert.equal(porOrdem.get(3)!.estado, "reprovada");
    assert.equal(d.requisicao.estado, "executada", "sem falhas → lote executada");
  });

  test("exceção sem motivo é rejeitada pelo contrato (RN03)", async () => {
    const id = await criarLote([doc("83"), doc("83")]);
    const d = await detalhe(id);
    const r = await decidirLote(id, sidJoao, "aprovar", {
      excecoes: [{ itemId: d.itens[0].id, motivo: "  " }],
    });
    assert.equal(r.statusCode, 400, r.body);
  });
});

/* ------------------------------------------------------------------ */
/* Cenário 4 — interrupção + idempotência (RN05)                       */
/* ------------------------------------------------------------------ */

describe("US-06 — Cenário 4: interrupção no item K e reexecução forçada", () => {
  test("sessão expira no item 3 de 5 → 1..2 preservados, 3..5 em falha com causa; NENHUMA execução duplicada", async () => {
    const docs = [doc("84"), doc("84"), doc("84"), doc("84"), doc("84")];
    const id = await criarLote(docs);

    // 401 exatamente no 3º documento: interrupção no meio (Cenário 4).
    responderPorDoc = (dc) => (dc === docs[2] ? resposta401() : respostaSucesso());

    const antes = execucoes.length;
    const r = await decidirLote(id, sidJoao, "aprovar");
    assert.equal(r.statusCode, 200, r.body);
    await aguardarConclusao(id);

    const d = await detalhe(id);
    const porOrdem = new Map(
      (d.itens as Array<{
        ordem: number;
        estado: string;
        resultado: { causa?: string } | null;
      }>).map((i) => [i.ordem, i]),
    );
    assert.equal(porOrdem.get(1)!.estado, "executada", "1..K-1 preservados");
    assert.equal(porOrdem.get(2)!.estado, "executada");
    assert.equal(porOrdem.get(3)!.estado, "falha");
    assert.equal(porOrdem.get(3)!.resultado?.causa, "sessao_expirada_durante_execucao");
    assert.equal(porOrdem.get(4)!.estado, "falha", "K.. em falha com causa, sem tocar a Sinqia");
    assert.equal(porOrdem.get(4)!.resultado?.causa, "lote_interrompido");
    assert.equal(porOrdem.get(5)!.resultado?.causa, "lote_interrompido");
    assert.equal(d.requisicao.estado, "falha");
    assert.equal(d.requisicao.resultado.interrompidoNoItem, 3);
    assert.equal(
      execucoes.slice(antes).length,
      3,
      "itens 4 e 5 nunca chegaram à Sinqia",
    );

    // Idempotência (RN05): reexecução FORÇADA do mesmo lote — nenhum item é
    // reivindicável (nenhum está `pendente`), então ZERO novas chamadas.
    responderPorDoc = () => respostaSucesso();
    const chamadasAntesDoRetry = execucoes.length;
    const lote = servico.obterRequisicao(id)!;
    await iniciarExecucaoLote(
      lote,
      { token: "token-ana", ator: "ana.lima" },
      {
        servico,
        deps: {
          cadastrarClienteFn: async (token, body) => {
            const dc = normalizarDocumento(
              String((body as { cliente?: { nrCpfCnpj?: string } }).cliente?.nrCpfCnpj ?? ""),
            );
            execucoes.push({ token, doc: dc, body });
            return respostaSucesso();
          },
          calcProspFn: async () => {
            throw new Error("não deve calcular proposta em lote de tomadores");
          },
          criarUmaFn: async () => {
            throw new Error("não deve criar proposta em lote de tomadores");
          },
          // Movimentação (US-08) não participa de lote de tomadores.
          transferirStatusFn: async () => {
            throw new Error("não deve mover proposta em lote de tomadores");
          },
          consultarStatusTransfFn: async () => {
            throw new Error("não deve consultar transições em lote de tomadores");
          },
          consultarHistoricoPropostaFn: async () => {
            throw new Error("não deve consultar histórico em lote de tomadores");
          },
        },
        destroySessionFn: () => {},
      },
    );
    assert.equal(execucoes.length, chamadasAntesDoRetry, "reexecução forçada não duplica NADA");
    assert.equal((await detalhe(id)).requisicao.estado, "falha", "estado permanece");
  });
});

/* ------------------------------------------------------------------ */
/* Maker-checker, concorrência e cancelamento                          */
/* ------------------------------------------------------------------ */

describe("US-06 — maker-checker, concorrência e cancelamento em cascata", () => {
  test("o criador não decide o próprio lote (403 VIOLACAO_SOD, auditado)", async () => {
    const id = await criarLote([doc("85")]);
    const r = await decidirLote(id, sidMaria, "aprovar");
    assert.equal(r.statusCode, 403, r.body);
    assert.equal(r.json().code, "VIOLACAO_SOD");
    assert.equal((await detalhe(id)).requisicao.estado, "pendente");
  });

  test("concorrência entre aprovadores: a primeira decisão do lote vence; a segunda recebe 409 com o decisor", async () => {
    const id = await criarLote([doc("86"), doc("86")]);

    const r1 = await decidirLote(id, sidJoao, "reprovar", { motivo: "primeira decisão" });
    assert.equal(r1.statusCode, 200, r1.body);

    const r2 = await decidirLote(id, sidAna, "aprovar");
    assert.equal(r2.statusCode, 409, r2.body);
    assert.equal(r2.json().code, "TRANSICAO_INVALIDA");
    assert.equal(r2.json().decididoPor, "joao.souza");

    const d = await detalhe(id);
    assert.equal(d.requisicao.estado, "reprovada");
    assert.equal(d.placar.reprovadas, 2, "itens seguem a primeira decisão");
  });

  test("cancelamento pelo criador: lote e itens pendentes caem juntos", async () => {
    const id = await criarLote([doc("87"), doc("87")]);
    const r = await decidirLote(id, sidMaria, "cancelar");
    assert.equal(r.statusCode, 200, r.body);
    const d = await detalhe(id);
    assert.equal(d.requisicao.estado, "cancelada");
    assert.equal(d.placar.canceladas, 2);

    // Documento liberado: um NOVO lote com o mesmo doc pode ser criado.
    const docLivre = (d.itens as Array<{ documento: string }>)[0].documento;
    const novo = await multipartInject("/api/import", sidMaria, arquivoLote([docLivre]));
    assert.equal(novo.statusCode, 201, novo.body);
  });

  test("exceções em requisição INDIVIDUAL são rejeitadas (contrato de lote)", async () => {
    flagsAtivas.add("tomador.cadastrar");
    const ri = await post("/api/cadastrar", sidMaria, {
      campos: { ...EXEMPLO_PF, nrCpfCnpj: doc("88") },
      control: {},
      dryRun: false,
    });
    assert.equal(ri.statusCode, 201, ri.body);
    const r = await post(`/api/sod/requisicoes/${ri.json().requisicao.id}/decisao`, sidJoao, {
      decisao: "aprovar",
      excecoes: [{ itemId: "11111111-1111-4111-8111-111111111111", motivo: "x" }],
    });
    assert.equal(r.statusCode, 400, r.body);
  });
});

/* ------------------------------------------------------------------ */
/* Lote grande (≥70) com falhas injetadas                              */
/* ------------------------------------------------------------------ */

describe("US-06 — lote grande: 70 itens, falhas injetadas, tempo por item", () => {
  test("70 itens executam sequencialmente; falhas pontuais não interrompem; placar bate", async () => {
    const docs = Array.from({ length: 70 }, () => doc("7"));
    const id = await criarLote(docs);

    // Falha de negócio a cada 10º item (7 falhas no total).
    const comFalha = new Set(docs.filter((_, i) => (i + 1) % 10 === 0));
    responderPorDoc = (dc) => (comFalha.has(dc) ? respostaErroNegocio() : respostaSucesso());

    const antes = execucoes.length;
    const r = await decidirLote(id, sidJoao, "aprovar");
    assert.equal(r.statusCode, 200, r.body);
    await aguardarConclusao(id, 30_000);

    const d = await detalhe(id);
    const chamadas = execucoes.slice(antes);
    assert.equal(chamadas.length, 70, "todos os itens tentados exatamente uma vez");
    assert.deepEqual(chamadas.map((c) => c.doc), docs, "ordem do arquivo preservada");
    assert.deepEqual(d.placar, {
      total: 70,
      pendentes: 0,
      executando: 0,
      executadas: 63,
      falhas: 7,
      reprovadas: 0,
      canceladas: 0,
    });
    assert.equal(d.requisicao.estado, "falha", "RN01: qualquer falha → lote em falha");

    // Insumo de UX do checkpoint: tempo médio por item medido na execução.
    const media = d.requisicao.resultado.duracaoMediaItemMs;
    assert.equal(typeof media, "number");
    console.log(
      `US-06 lote grande: duracaoMediaItemMs=${media}ms (Sinqia mockada), ` +
        `duracaoTotalMs=${d.requisicao.resultado.duracaoTotalMs}ms para 70 itens`,
    );
  });
});

/* ------------------------------------------------------------------ */
/* Regressão — flag OFF e corte                                        */
/* ------------------------------------------------------------------ */

describe("US-06 — regressão: fluxo direto intacto com flag OFF; corte à prova de corrida", () => {
  test("flag OFF: /api/validate sem seção de aprovação; /api/import segue para o job direto", async () => {
    flagsAtivas.clear();

    const conteudo = arquivoLote([doc("89")]);
    const v = await multipartInject("/api/validate", sidMaria, conteudo);
    assert.equal(v.statusCode, 200, v.body);
    assert.equal(v.json().aprovacao, undefined, "sem flag, nada de aprovação na resposta");
    assert.equal(v.json().duplicidades, undefined);

    // Documento já pendente em lote NÃO bloqueia o fluxo direto (guardas SoD
    // só existem sob a flag) — comportamento da Onda 1 preservado.
    const r = await multipartInject("/api/import", sidMaria, conteudo);
    assert.equal(r.statusCode, 200, r.body);
    assert.ok(r.json().jobId, "job direto criado (SSE segue como antes)");
    assert.equal(r.json().aprovacao, undefined);
  });

  test("corte (US-05): flag ativada ENTRE o desvio e a execução direta → 409 ACAO_SOB_APROVACAO, zero job", async () => {
    // Simula a corrida: primeira leitura (desvio) vê OFF, segunda (guard) vê ON.
    flagsAtivas.clear();
    let leituras = 0;
    const appCorrida = Fastify();
    await appCorrida.register(cookie);
    await appCorrida.register(multipart, { limits: { fileSize: 1024 * 1024, files: 1 } });
    await registerRoutes(appCorrida, {
      cadastrarClienteFn: async () => {
        throw new Error("não deve chamar a Sinqia");
      },
      sodServico: () => servico,
      aprovacaoAtivaFn: (tipo) => {
        if (tipo !== "tomador.cadastrar_lote") return false;
        leituras++;
        return leituras >= 2; // OFF no desvio, ON no guard
      },
    });
    await appCorrida.ready();
    try {
      const b = "----us06corrida";
      const body = [
        `--${b}`,
        `Content-Disposition: form-data; name="control"`,
        ``,
        `{}`,
        `--${b}`,
        `Content-Disposition: form-data; name="file"; filename="lote.json"`,
        `Content-Type: application/json`,
        ``,
        arquivoLote([doc("80")]),
        `--${b}--`,
        ``,
      ].join("\r\n");
      const r = await appCorrida.inject({
        method: "POST",
        url: "/api/import",
        cookies: { sid: sidMaria },
        headers: { "content-type": `multipart/form-data; boundary=${b}` },
        payload: body,
      });
      assert.equal(r.statusCode, 409, r.body);
      assert.equal(r.json().code, "ACAO_SOB_APROVACAO");
    } finally {
      await appCorrida.close();
    }
  });
});
