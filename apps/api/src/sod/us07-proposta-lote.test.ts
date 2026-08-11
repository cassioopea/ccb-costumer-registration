import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
// Imports SOMENTE de tipo: apagados na compilação, não disparam o load do env.ts.
import type { CadastroResult, CalcProspResult } from "./../sinqia-client.js";
import type { CriacaoItem, CriacaoRowResult } from "./../criacao-job.js";

/**
 * US-07 — Lote de propostas (Emissões) + encadeamento tomador→proposta.
 *
 * Cobre os cenários da história ponta a ponta no BFF, offline (Sinqia
 * simulada por spies nas deps injetáveis):
 *  1. CSV/xlsx do Emissões → cálculo do requisitante → requisição-lote
 *     `pendente` com referências rotuladas (planilha + cálculo), duplicidade
 *     ANTES, ZERO Sinqia na criação;
 *  2. aprovação executa cálculo OFICIAL + conferência automática (RN02) +
 *     criação pelo MESMO caminho do fluxo direto; divergência forçada →
 *     `falha` com comparativo esperado × calculado;
 *  3. lote COMPOSTO: tomadores executam ANTES; tomador falho → propostas
 *     vinculadas em `falha` ("tomador não criado — item X"), zero Sinqia
 *     para elas; tomadores existentes executam como itens normais (RN04);
 *  4. exceção em tomador com dependentes → propostas vinculadas REPROVADAS
 *     com motivo propagado; exceção contraditória é rejeitada inteira;
 *  + idempotência/falha parcial herdadas da US-06 para os DOIS tipos,
 *    composto 70+70 com falhas injetadas e regressão do fluxo direto/corte.
 */
process.env.SINQIA_BASE_URL ??= "https://sinqia.fixture.invalid";
process.env.SINQIA_ENV ??= "hml";

const dir = mkdtempSync(path.join(tmpdir(), "sod-us07-"));
process.env.SQLITE_PATH = path.join(dir, "app.db");

const { EXEMPLO_PF, normalizarDocumento, ROTULO_CONFERENCIA_PLANILHA, ROTULO_REFERENCIA_CALCULO } =
  await import("@cadastro-lote/shared");
const { abrirBancoSod, criarSodRepositorio } = await import("./repositorio.js");
const { criarSodServico } = await import("./dominio.js");
const { registerSodRoutes } = await import("./rotas.js");
const { registerRoutes } = await import("./../routes.js");
const { registerPropostasRoutes } = await import("./../routes-propostas.js");
const { getCalculoJob } = await import("./../calculo-job.js");
const { iniciarExecucaoLote } = await import("./execucao-lote.js");
const { parseFlatRow } = await import("./../parse-input.js");
const { createSession, limparSessoes } = await import("./../session.js");

let app: FastifyInstance;
let db: ReturnType<typeof abrirBancoSod>;
let servico: ReturnType<typeof criarSodServico>;
let sidMaria: string; // requisitante
let sidJoao: string; // aprovador

/** Flags ativas do teste — o `aprovacaoAtivaFn` injetado lê daqui. */
const flagsAtivas = new Set<string>();

/** Sonda de sessão (RN03) controlável. */
let sessaoSinqia: "valida" | "invalida" | "indisponivel" = "valida";
let sondagens = 0;

/**
 * "Sinqia" dos testes: valores oficiais por CPF (o calc spy devolve daqui —
 * mutá-los entre a requisição e a aprovação força divergência na execução).
 */
const valoresPorCpf = new Map<string, { parcela: number; financiado: number }>();

/** Log ÚNICO de chamadas Sinqia, na ordem — prova o encadeamento (RN03). */
const eventos: Array<{ tipo: "cadastro" | "calc" | "criar"; token: string; doc: string }> = [];
const chamadasDesde = (n: number) => eventos.slice(n);

/** Comportamento do cadastro de tomador por documento — cada teste arma o seu. */
let responderCadastroPorDoc: (doc: string) => Promise<CadastroResult> = () =>
  respostaCadastroSucesso();

async function respostaCadastroSucesso(): Promise<CadastroResult> {
  return {
    httpStatus: 200,
    envelope: { status: "OK", messages: [{ type: "Sucesso", message: "6874" }] } as CadastroResult["envelope"],
    analysis: { ok: true, envelopeStatus: "OK", messagesText: "Sucesso | 6874", messages: [] },
  };
}

async function respostaCadastroErroNegocio(): Promise<CadastroResult> {
  return {
    httpStatus: 200,
    envelope: { status: "ERRO", messages: [{ type: "Erro", message: "CEP inválido" }] } as CadastroResult["envelope"],
    analysis: {
      ok: false,
      envelopeStatus: "ERRO",
      messagesText: "Erro | CEP inválido",
      messages: [],
      reason: "consistências reprovadas",
    },
  };
}

async function respostaCadastro401(): Promise<CadastroResult> {
  return {
    httpStatus: 401,
    envelope: {} as CadastroResult["envelope"],
    analysis: { ok: false, envelopeStatus: "", messagesText: "", messages: [] },
  };
}

/** calcProsp simulado: devolve os "oficiais" de valoresPorCpf. */
async function calcSpy(token: string, request: unknown): Promise<CalcProspResult> {
  const r = request as { nrCPF: string; vlContra: number; qtPrest: number; dtVct1Ap: number };
  const cpf = normalizarDocumento(String(r.nrCPF));
  eventos.push({ tipo: "calc", token, doc: cpf });
  const v = valoresPorCpf.get(cpf) ?? { parcela: 100, financiado: r.vlContra };
  return {
    httpStatus: 200,
    calculo: {
      vlLiquid: r.vlContra,
      vlPresta: v.parcela,
      vlIof: 12.34,
      vlContra: v.financiado,
      dtVct1ap: r.dtVct1Ap,
      dtVctult: r.dtVct1Ap + 3_00_00,
      txAm: 1.99,
      txCetAm: 2.15,
      qtPrest: r.qtPrest,
      vlTotal: Math.round(v.parcela * r.qtPrest * 100) / 100,
      prestacoes: [],
    },
    analysis: { ok: true, envelopeStatus: "OK", messagesText: "", messages: [] },
  };
}

/** criarUma simulado — o "mesmo caminho do fluxo direto" dos executores. */
let proximoNrProsp = 70_000;
async function criarUmaSpy(
  token: string,
  item: CriacaoItem,
): Promise<CriacaoRowResult> {
  const cpf = normalizarDocumento(item.cpf);
  eventos.push({ tipo: "criar", token, doc: cpf });
  proximoNrProsp++;
  return {
    linha: item.linha,
    nome: item.nome,
    cpf: item.cpf,
    nrClient: 4242,
    nrProsp: String(proximoNrProsp),
    status: "OK",
    httpStatus: 200,
    messages: "Sucesso | proposta criada",
  };
}

before(async () => {
  db = abrirBancoSod(path.join(dir, "sod.db"));
  servico = criarSodServico(criarSodRepositorio(db, "hml"));

  app = Fastify();
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024, files: 1 } });
  // /api/cadastrar (individual) entra só para provocar TOMADOR_PENDENTE.
  await registerRoutes(app, {
    cadastrarClienteFn: async () => {
      throw new Error("o fluxo direto de tomador não deve ser chamado nestes testes");
    },
    sodServico: () => servico,
    aprovacaoAtivaFn: (tipo) => flagsAtivas.has(tipo),
  });
  await registerPropostasRoutes(app, {
    // Fase 2 (cálculo do REQUISITANTE) usa o mesmo spy — token da Maria.
    calcProspFn: calcSpy,
    buscarClientePorCpfFn: async () => ({
      httpStatus: 200,
      encontrado: true,
      nrClient: 4242,
      dsNome: "Cliente Fixture",
    }),
    criarUmaFn: async () => {
      throw new Error("a criação direta não deve rodar nestes testes");
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
      eventos.push({ tipo: "cadastro", token, doc });
      return responderCadastroPorDoc(doc);
    },
    calcProspFn: calcSpy,
    criarUmaFn: criarUmaSpy,
  });
  await app.ready();
});

beforeEach(() => {
  flagsAtivas.clear();
  flagsAtivas.add("proposta.criar_lote");
  sessaoSinqia = "valida";
  sondagens = 0;
  responderCadastroPorDoc = () => respostaCadastroSucesso();
  limparSessoes();
  sidMaria = createSession("Maria.SILVA", "token-maria").id;
  sidJoao = createSession("joao.souza", "token-joao").id;
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
/** CPF único por chamada (11 dígitos, prefixo do teste). */
function cpf(prefixo: string): string {
  seq++;
  return `${prefixo}${String(seq).padStart(11 - prefixo.length, "0")}`;
}

interface LinhaEmissao {
  nome: string;
  cpf: string;
  parcela: number;
  liquido: number;
  financiado: number;
  parcelas: number;
}

/** Linha do Emissões com os valores "oficiais" registrados no calc spy. */
function linhaEmissao(prefixo: string): LinhaEmissao {
  const documento = cpf(prefixo);
  const l: LinhaEmissao = {
    nome: `Tomador Proposta ${documento.slice(-4)}`,
    cpf: documento,
    parcela: 416.78,
    liquido: 10_000,
    financiado: 10_470,
    parcelas: 36,
  };
  valoresPorCpf.set(documento, { parcela: l.parcela, financiado: l.financiado });
  return l;
}

/** CSV no layout do Emissões (US-07: mesmo parser do .xlsx). */
function csvEmissoes(linhas: LinhaEmissao[]): string {
  const header =
    "Nome,CPF,ID_Sinqia,N_CCB,Valor da parcela inicial,N_Contrato,Liquido,Financiado," +
    "Quantidade Parcelas,TAC,Seguro,Out. vlr,1º vcto. De juros,Situação";
  const rows = linhas.map((l) =>
    [
      `"${l.nome}"`,
      l.cpf,
      "333-6",
      "CCB-1",
      l.parcela.toFixed(2),
      "",
      l.liquido.toFixed(2),
      l.financiado.toFixed(2),
      String(l.parcelas),
      "0",
      "0",
      "0",
      "05/09/2026",
      "Compliance",
    ].join(","),
  );
  return [header, ...rows].join("\r\n");
}

/** Arquivo JSON de TOMADORES (formato do módulo Tomadores). */
function arquivoTomadores(documentos: string[]): string {
  return JSON.stringify(
    documentos.map((d, i) =>
      parseFlatRow({ ...EXEMPLO_PF, nrCpfCnpj: d, dsNome: `Tomador Novo ${i + 1}` }),
    ),
  );
}

function multipartInject(
  url: string,
  sid: string,
  conteudo: string,
  filename: string,
  contentType = "application/json",
) {
  const b = "----us07boundary";
  const body = [
    `--${b}`,
    `Content-Disposition: form-data; name="control"`,
    ``,
    `{}`,
    `--${b}`,
    `Content-Disposition: form-data; name="file"; filename="${filename}"`,
    `Content-Type: ${contentType}`,
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
  return app.inject({ method: "POST", url, cookies: { sid }, payload: payload as Record<string, unknown> });
}

function get(url: string, sid: string) {
  return app.inject({ method: "GET", url, cookies: { sid } });
}

/** Upload CSV + cálculo do requisitante (fase 2) até o job concluir. */
async function carregarECalcular(linhas: LinhaEmissao[], sid = sidMaria) {
  const parse = await multipartInject(
    "/api/propostas/parse",
    sid,
    csvEmissoes(linhas),
    "Emissoes.csv",
    "text/csv",
  );
  assert.equal(parse.statusCode, 200, parse.body);
  const rows = parse.json().rows as Array<{ linha: number; erros: string[] }>;
  assert.ok(rows.every((r) => r.erros.length === 0), JSON.stringify(rows[0]));

  const calc = await post("/api/propostas/calcular", sid, {
    rows,
    params: { txJuros: 12, cdProd: 1015, idCarCtr: 31, dtContra: 20_260_805 },
  });
  assert.equal(calc.statusCode, 200, calc.body);
  const calcJobId = calc.json().jobId as string;

  const inicio = Date.now();
  while (!getCalculoJob(calcJobId)?.done) {
    if (Date.now() - inicio > 5000) throw new Error("cálculo da fase 2 não concluiu");
    await new Promise((r) => setTimeout(r, 10));
  }
  const job = getCalculoJob(calcJobId)!;
  const linhasOK = job.results.filter((r) => r.status === "OK").map((r) => r.linha);
  assert.equal(linhasOK.length, linhas.length, "todas as linhas devem calcular OK na fase 2");
  return { calcJobId, linhasOK };
}

/** POST /api/propostas/criar (sob a flag: vira requisição-lote). */
function requisitar(
  c: { calcJobId: string; linhasOK: number[] },
  extra: Record<string, unknown> = {},
  sid = sidMaria,
) {
  return post("/api/propostas/criar", sid, {
    calcJobId: c.calcJobId,
    linhas: c.linhasOK,
    params: { txJuros: 12, cdProd: 1015, idCarCtr: 31, cdConven: "111", dtContra: 20_260_805 },
    piloto: false,
    forcarDuplicadas: false,
    arquivo: "Emissoes.csv",
    ...extra,
  });
}

/** Envia o arquivo de tomadores e devolve o uploadId retido. */
async function uploadTomadores(documentos: string[], sid = sidMaria): Promise<string> {
  const r = await multipartInject(
    "/api/propostas/tomadores/parse",
    sid,
    arquivoTomadores(documentos),
    "tomadores.json",
  );
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().total, documentos.length);
  return r.json().uploadId as string;
}

function decidir(id: string, sid: string, decisao: string, extra: Record<string, unknown> = {}) {
  return post(`/api/sod/requisicoes/${id}/decisao`, sid, { decisao, ...extra });
}

async function detalhe(id: string, sid = sidMaria) {
  const r = await get(`/api/sod/requisicoes/${id}`, sid);
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
}

/** Espera a execução em background terminar. */
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

interface ItemVisto {
  id: string;
  ordem: number;
  tipo: string;
  estado: string;
  motivo: string | null;
  documento: string | null;
  dependeDeItemId: string | null;
  resumo: Record<string, unknown>;
  resultado: { causa?: string; mensagens?: string } | null;
}

/* ------------------------------------------------------------------ */
/* Cenário 1 — criação (CSV, referências rotuladas, duplicidade)        */
/* ------------------------------------------------------------------ */

describe("US-07 — Cenário 1: lote de propostas vira requisição pendente", () => {
  test("CSV parseado (datas dd/mm, decimais com ponto); requisição pendente com referências rotuladas; ZERO Sinqia na criação", async () => {
    const linhas = [linhaEmissao("91"), linhaEmissao("91"), linhaEmissao("91")];
    const c = await carregarECalcular(linhas);

    const antes = eventos.length;
    const r = await requisitar(c);
    assert.equal(r.statusCode, 201, r.body);
    assert.equal(r.json().aprovacao, true);
    assert.equal(r.json().requisicao.totalItens, 3);
    assert.equal(r.json().requisicao.composto, false);
    assert.equal(eventos.length, antes, "criação da requisição nunca chama a Sinqia");

    const d = await detalhe(r.json().requisicao.id);
    assert.equal(d.requisicao.estado, "pendente");
    assert.equal(d.requisicao.tipo, "proposta.criar_lote");
    assert.equal(d.placar.pendentes, 3);
    assert.equal(d.placarPorTipo["proposta.criar"].total, 3);
    for (const item of d.itens as ItemVisto[]) {
      assert.equal(item.tipo, "proposta.criar");
      assert.equal(item.estado, "pendente");
      assert.equal(item.dependeDeItemId, null, "sem arquivo de tomadores não há vínculo");
    }

    // Item integral: referência do requisitante + conferência da planilha, ROTULADAS.
    const ri = await get(
      `/api/sod/requisicoes/${d.requisicao.id}/itens/${(d.itens as ItemVisto[])[0].id}`,
      sidMaria,
    );
    assert.equal(ri.statusCode, 200, ri.body);
    const payload = ri.json().item.payload;
    assert.equal(payload.referencia.rotulo, ROTULO_REFERENCIA_CALCULO);
    assert.equal(payload.conferencia.rotulo, ROTULO_CONFERENCIA_PLANILHA);
    assert.equal(payload.conferencia.vlParcelaInicial, linhas[0].parcela);
    assert.equal(payload.conferencia.vlLiquido, linhas[0].liquido);
    assert.equal(payload.conferencia.vlFinanciado, linhas[0].financiado);
    assert.ok(payload.calcRequest, "request do calcProsp persistido por item");
    // Chave de duplicidade = assinatura da proposta (mesma da US-04).
    const item0 = (d.itens as ItemVisto[])[0];
    assert.ok(
      item0.documento!.startsWith(`${linhas[0].cpf}:prod1015:36x`),
      `chave inesperada: ${item0.documento}`,
    );

    // Duplicidade ANTES (RN06): as mesmas assinaturas de novo → 409 estruturado.
    const dup = await requisitar(c);
    assert.equal(dup.statusCode, 409, dup.body);
    assert.equal(dup.json().code, "DUPLICIDADE_PENDENTE");
    assert.equal(dup.json().duplicidades.pendentesLote.length, 3);
  });

  test("RN05 herdada: proposta cujo tomador está pendente em OUTRA requisição → 409 TOMADOR_PENDENTE", async () => {
    // Individual de tomador pendente pelo caminho real da US-02.
    flagsAtivas.add("tomador.cadastrar");
    const linha = linhaEmissao("92");
    const ri = await post("/api/cadastrar", sidMaria, {
      campos: { ...EXEMPLO_PF, nrCpfCnpj: linha.cpf },
      control: {},
      dryRun: false,
    });
    assert.equal(ri.statusCode, 201, ri.body);

    const c = await carregarECalcular([linha]);
    const r = await requisitar(c);
    assert.equal(r.statusCode, 409, r.body);
    assert.equal(r.json().code, "TOMADOR_PENDENTE");
    assert.equal(r.json().linhas.length, 1);
  });

  test("tomador no arquivo SEM proposta correspondente → 422 (arquivo volta inteiro)", async () => {
    const linha = linhaEmissao("93");
    const c = await carregarECalcular([linha]);
    const uploadId = await uploadTomadores([linha.cpf, cpf("93")]); // 2º sem proposta
    const r = await requisitar(c, { tomadoresUploadId: uploadId });
    assert.equal(r.statusCode, 422, r.body);
    assert.equal(r.json().tomadoresSemVinculo.length, 1);
  });

  test("modelo CSV para download é aceito pelo próprio parser", async () => {
    const modelo = await app.inject({ method: "GET", url: "/api/propostas/template.csv" });
    assert.equal(modelo.statusCode, 200);
    const parse = await multipartInject(
      "/api/propostas/parse",
      sidMaria,
      modelo.body.replace(/^﻿/, ""),
      "template-propostas.csv",
      "text/csv",
    );
    assert.equal(parse.statusCode, 200, parse.body);
    const rows = parse.json().rows as Array<{ erros: string[]; cpf: string; dtVct1Ap: number }>;
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0].erros, []);
    assert.equal(rows[0].cpf, "06550599620", "zeros à esquerda restaurados");
    assert.equal(rows[0].dtVct1Ap, 20_260_905, "dd/mm/aaaa lido como data brasileira");
  });
});

/* ------------------------------------------------------------------ */
/* Cenário 2 — execução: cálculo oficial + conferência (RN02)           */
/* ------------------------------------------------------------------ */

describe("US-07 — Cenário 2: execução com cálculo oficial e conferência automática", () => {
  test("aprovação executa calcProsp + criarUma na sessão do APROVADOR; itens executados", async () => {
    const linhas = [linhaEmissao("94"), linhaEmissao("94")];
    const c = await carregarECalcular(linhas);
    const r = await requisitar(c);
    const id = r.json().requisicao.id as string;

    const antes = eventos.length;
    const dec = await decidir(id, sidJoao, "aprovar");
    assert.equal(dec.statusCode, 200, dec.body);
    assert.equal(sondagens, 1, "pré-verificação de sessão antes da decisão (RN03)");
    await aguardarConclusao(id);

    const execucao = chamadasDesde(antes);
    assert.deepEqual(
      execucao.map((e) => e.tipo),
      ["calc", "criar", "calc", "criar"],
      "cálculo oficial + criação, item a item",
    );
    assert.ok(execucao.every((e) => e.token === "token-joao"), "sessão do aprovador (B2')");

    const d = await detalhe(id);
    assert.equal(d.requisicao.estado, "executada");
    assert.equal(d.placarPorTipo["proposta.criar"].executadas, 2);
    const item = (d.itens as ItemVisto[])[0];
    assert.equal(item.estado, "executada");
    assert.match(item.resultado?.mensagens ?? "", /Proposta nº 7\d+ criada com o cálculo oficial/);
  });

  test("divergência forçada entre planilha e cálculo oficial → item `falha` com comparativo; nada é criado", async () => {
    const linhas = [linhaEmissao("95"), linhaEmissao("95")];
    const c = await carregarECalcular(linhas);
    const r = await requisitar(c);
    const id = r.json().requisicao.id as string;

    // Entre a requisição e a aprovação, o "oficial" da 2ª linha muda (mundo externo).
    valoresPorCpf.set(linhas[1].cpf, { parcela: linhas[1].parcela + 7, financiado: linhas[1].financiado });

    const antes = eventos.length;
    await decidir(id, sidJoao, "aprovar");
    await aguardarConclusao(id);

    const d = await detalhe(id);
    const porOrdem = new Map((d.itens as ItemVisto[]).map((i) => [i.ordem, i]));
    assert.equal(porOrdem.get(1)!.estado, "executada");
    assert.equal(porOrdem.get(2)!.estado, "falha");
    assert.equal(porOrdem.get(2)!.resultado?.causa, "conferencia_reprovada");
    assert.equal(d.requisicao.estado, "falha", "RN01: falha de item → lote em falha");

    // Comparativo esperado × calculado no resultado INTEGRAL do item.
    const ri = await get(`/api/sod/requisicoes/${id}/itens/${porOrdem.get(2)!.id}`, sidMaria);
    const comparativo = ri.json().item.resultado.comparativo as Array<{
      campo: string;
      esperado: number;
      calculado: number;
    }>;
    assert.deepEqual(comparativo, [
      { campo: "Parcela", esperado: linhas[1].parcela, calculado: linhas[1].parcela + 7 },
    ]);

    // A linha divergente calculou, mas NUNCA criou.
    const criacoesDaLinha = chamadasDesde(antes).filter(
      (e) => e.tipo === "criar" && e.doc === linhas[1].cpf,
    );
    assert.equal(criacoesDaLinha.length, 0, "divergência bloqueia a criação (RN02)");
  });
});

/* ------------------------------------------------------------------ */
/* Cenário 3 — lote COMPOSTO: encadeamento tomador→proposta             */
/* ------------------------------------------------------------------ */

describe("US-07 — Cenário 3: composto executa tomadores antes; falha propaga sem Sinqia", () => {
  test("ordem tomadores→propostas; tomador falho → proposta vinculada em falha 'tomador não criado — item X'; RN04 para tomadores existentes", async () => {
    // A e B são tomadores NOVOS (no arquivo); C e D já existem na Sinqia.
    const [a, b, cLinha, dLinha] = [
      linhaEmissao("96"),
      linhaEmissao("96"),
      linhaEmissao("96"),
      linhaEmissao("96"),
    ];
    const calc = await carregarECalcular([a, b, cLinha, dLinha]);
    const uploadId = await uploadTomadores([a.cpf, b.cpf]);

    const r = await requisitar(calc, { tomadoresUploadId: uploadId });
    assert.equal(r.statusCode, 201, r.body);
    assert.equal(r.json().requisicao.composto, true);
    assert.equal(r.json().requisicao.totalItens, 6);
    assert.equal(r.json().requisicao.vinculos, 2);
    const id = r.json().requisicao.id as string;

    // Estrutura persistida: tomadores nas ordens 1..2, propostas 3..6 com vínculo.
    const d0 = await detalhe(id);
    const itens0 = d0.itens as ItemVisto[];
    assert.deepEqual(
      itens0.map((i) => i.tipo),
      ["tomador.cadastrar", "tomador.cadastrar", "proposta.criar", "proposta.criar", "proposta.criar", "proposta.criar"],
    );
    const tomadorPorDoc = new Map(itens0.slice(0, 2).map((i) => [i.documento, i]));
    const propostaDe = (doc: string) =>
      itens0.find((i) => i.tipo === "proposta.criar" && i.documento!.startsWith(doc))!;
    assert.equal(propostaDe(a.cpf).dependeDeItemId, tomadorPorDoc.get(a.cpf)!.id);
    assert.equal(propostaDe(b.cpf).dependeDeItemId, tomadorPorDoc.get(b.cpf)!.id);
    assert.equal(propostaDe(cLinha.cpf).dependeDeItemId, null, "tomador existente = item normal");

    // Tomador B falha na Sinqia (erro de negócio).
    responderCadastroPorDoc = (doc) =>
      doc === b.cpf ? respostaCadastroErroNegocio() : respostaCadastroSucesso();

    const antes = eventos.length;
    await decidir(id, sidJoao, "aprovar");
    await aguardarConclusao(id);

    const execucao = chamadasDesde(antes);
    // Encadeamento: os DOIS cadastros vêm antes de qualquer cálculo/criação.
    assert.deepEqual(
      execucao.slice(0, 2).map((e) => e.tipo),
      ["cadastro", "cadastro"],
      "tomadores executam primeiro",
    );
    assert.equal(
      execucao.filter((e) => e.doc === b.cpf && e.tipo !== "cadastro").length,
      0,
      "proposta do tomador falho: ZERO chamadas Sinqia",
    );

    const d = await detalhe(id);
    const itens = d.itens as ItemVisto[];
    const item = (doc: string, tipo: string) =>
      itens.find((i) => i.tipo === tipo && i.documento!.startsWith(doc))!;
    assert.equal(item(a.cpf, "tomador.cadastrar").estado, "executada");
    assert.equal(item(b.cpf, "tomador.cadastrar").estado, "falha");
    assert.equal(item(a.cpf, "proposta.criar").estado, "executada");
    const propostaB = item(b.cpf, "proposta.criar");
    assert.equal(propostaB.estado, "falha");
    assert.equal(propostaB.resultado?.causa, "tomador_nao_criado");
    assert.match(propostaB.resultado?.mensagens ?? "", /Tomador não criado — item 2/);
    assert.equal(item(cLinha.cpf, "proposta.criar").estado, "executada", "RN04");
    assert.equal(item(dLinha.cpf, "proposta.criar").estado, "executada", "RN04");

    // Placar de DOIS NÍVEIS.
    assert.equal(d.placarPorTipo["tomador.cadastrar"].executadas, 1);
    assert.equal(d.placarPorTipo["tomador.cadastrar"].falhas, 1);
    assert.equal(d.placarPorTipo["proposta.criar"].executadas, 3);
    assert.equal(d.placarPorTipo["proposta.criar"].falhas, 1);
    assert.equal(d.requisicao.estado, "falha");
  });
});

/* ------------------------------------------------------------------ */
/* Cenário 4 — exceção em tomador com dependentes (propagação)          */
/* ------------------------------------------------------------------ */

describe("US-07 — Cenário 4: exceção sobre tomador propaga a reprovação às propostas vinculadas", () => {
  test("aprovar com exceção no tomador → propostas vinculadas REPROVADAS com motivo propagado; demais executam", async () => {
    const [a, b] = [linhaEmissao("87"), linhaEmissao("87")];
    const calc = await carregarECalcular([a, b]);
    const uploadId = await uploadTomadores([a.cpf, b.cpf]);
    const r = await requisitar(calc, { tomadoresUploadId: uploadId });
    const id = r.json().requisicao.id as string;

    const d0 = await detalhe(id);
    const tomadorA = (d0.itens as ItemVisto[]).find(
      (i) => i.tipo === "tomador.cadastrar" && i.documento === a.cpf,
    )!;

    const antes = eventos.length;
    const dec = await decidir(id, sidJoao, "aprovar", {
      excecoes: [{ itemId: tomadorA.id, motivo: "documentação do tomador divergente" }],
    });
    assert.equal(dec.statusCode, 200, dec.body);
    await aguardarConclusao(id);

    const d = await detalhe(id);
    const itens = d.itens as ItemVisto[];
    const item = (doc: string, tipo: string) =>
      itens.find((i) => i.tipo === tipo && i.documento!.startsWith(doc))!;
    assert.equal(item(a.cpf, "tomador.cadastrar").estado, "reprovada");
    const propostaA = item(a.cpf, "proposta.criar");
    assert.equal(propostaA.estado, "reprovada", "propagação da exceção (Cenário 4)");
    assert.match(propostaA.motivo ?? "", /propagação/);
    assert.match(propostaA.motivo ?? "", /documentação do tomador divergente/);
    assert.equal(item(b.cpf, "tomador.cadastrar").estado, "executada");
    assert.equal(item(b.cpf, "proposta.criar").estado, "executada");
    assert.equal(
      chamadasDesde(antes).filter((e) => e.doc === a.cpf).length,
      0,
      "nada do par excecionado foi à Sinqia",
    );
    // Trilha: a transição da proposta A registra origem `propagacao`.
    const evPropagacao = (d.historico as Array<{ detalhe: Record<string, unknown> }>).find(
      (ev) => ev.detalhe.origem === "propagacao",
    );
    assert.ok(evPropagacao, "auditoria registra a propagação");
    assert.equal(d.requisicao.estado, "executada", "sem falhas → lote executada");
  });

  test("exceção contraditória — aprovar proposta cujo tomador está sendo reprovado → 400, nada muda", async () => {
    const a = linhaEmissao("86");
    const calc = await carregarECalcular([a]);
    const uploadId = await uploadTomadores([a.cpf]);
    const r = await requisitar(calc, { tomadoresUploadId: uploadId });
    const id = r.json().requisicao.id as string;

    const d0 = await detalhe(id);
    const proposta = (d0.itens as ItemVisto[]).find((i) => i.tipo === "proposta.criar")!;
    const dec = await decidir(id, sidJoao, "reprovar", {
      motivo: "lote fora da política",
      excecoes: [{ itemId: proposta.id, motivo: "quero só a proposta" }],
    });
    assert.equal(dec.statusCode, 400, dec.body);
    assert.equal(dec.json().code, "LOTE_INVALIDO");
    assert.equal((await detalhe(id)).requisicao.estado, "pendente", "nada mudou");
  });
});

/* ------------------------------------------------------------------ */
/* Herança US-06 — idempotência e falha parcial nos DOIS tipos          */
/* ------------------------------------------------------------------ */

describe("US-07 — idempotência e falha parcial herdadas (dois tipos)", () => {
  test("sessão expira no tomador 2 → restantes em falha com causa; reexecução FORÇADA não chama nada (RN05)", async () => {
    const [a, b] = [linhaEmissao("85"), linhaEmissao("85")];
    const calc = await carregarECalcular([a, b]);
    const uploadId = await uploadTomadores([a.cpf, b.cpf]);
    const r = await requisitar(calc, { tomadoresUploadId: uploadId });
    const id = r.json().requisicao.id as string;

    responderCadastroPorDoc = (doc) =>
      doc === b.cpf ? respostaCadastro401() : respostaCadastroSucesso();
    await decidir(id, sidJoao, "aprovar");
    await aguardarConclusao(id);

    const d = await detalhe(id);
    const porOrdem = new Map((d.itens as ItemVisto[]).map((i) => [i.ordem, i]));
    assert.equal(porOrdem.get(1)!.estado, "executada", "tomador 1 preservado");
    assert.equal(porOrdem.get(2)!.resultado?.causa, "sessao_expirada_durante_execucao");
    assert.equal(porOrdem.get(3)!.resultado?.causa, "lote_interrompido");
    assert.equal(porOrdem.get(4)!.resultado?.causa, "lote_interrompido");
    assert.equal(d.requisicao.estado, "falha");

    // Reexecução forçada: nenhum item reivindicável → ZERO chamadas novas.
    responderCadastroPorDoc = () => respostaCadastroSucesso();
    const antes = eventos.length;
    await iniciarExecucaoLote(
      servico.obterRequisicao(id)!,
      { token: "token-ana", ator: "ana.lima" },
      {
        servico,
        deps: {
          cadastrarClienteFn: async (token, body) => {
            const doc = normalizarDocumento(
              String((body as { cliente?: { nrCpfCnpj?: string } }).cliente?.nrCpfCnpj ?? ""),
            );
            eventos.push({ tipo: "cadastro", token, doc });
            return respostaCadastroSucesso();
          },
          calcProspFn: calcSpy,
          criarUmaFn: criarUmaSpy,
          // Movimentação (US-08) não participa de lote de propostas.
          transferirStatusFn: async () => {
            throw new Error("não deve mover proposta em lote de propostas");
          },
          consultarStatusTransfFn: async () => {
            throw new Error("não deve consultar transições em lote de propostas");
          },
          consultarHistoricoPropostaFn: async () => {
            throw new Error("não deve consultar histórico em lote de propostas");
          },
          alterarSituacaoClienteFn: async () => {
            throw new Error("não deve alterar situação em lote de propostas");
          },
          listarPropostasPorCpfFn: async () => {
            throw new Error("não deve listar propostas em lote de propostas");
          },
        },
        destroySessionFn: () => {},
      },
    );
    assert.equal(eventos.length, antes, "reexecução forçada não duplica NADA");
  });
});

/* ------------------------------------------------------------------ */
/* Lote composto GRANDE: 70 tomadores + 70 propostas                    */
/* ------------------------------------------------------------------ */

describe("US-07 — composto 70+70 com falhas injetadas em tomadores", () => {
  test("cada 10º tomador falha → propostas vinculadas caem sem Sinqia; placar de dois níveis bate", async () => {
    const linhas = Array.from({ length: 70 }, () => linhaEmissao("7"));
    const calc = await carregarECalcular(linhas);
    const uploadId = await uploadTomadores(linhas.map((l) => l.cpf));
    const r = await requisitar(calc, { tomadoresUploadId: uploadId });
    assert.equal(r.statusCode, 201, r.body);
    assert.equal(r.json().requisicao.totalItens, 140);
    assert.equal(r.json().requisicao.vinculos, 70);
    const id = r.json().requisicao.id as string;

    const comFalha = new Set(linhas.filter((_, i) => (i + 1) % 10 === 0).map((l) => l.cpf));
    responderCadastroPorDoc = (doc) =>
      comFalha.has(doc) ? respostaCadastroErroNegocio() : respostaCadastroSucesso();

    const antes = eventos.length;
    await decidir(id, sidJoao, "aprovar");
    await aguardarConclusao(id, 30_000);

    const execucao = chamadasDesde(antes);
    assert.equal(execucao.filter((e) => e.tipo === "cadastro").length, 70);
    assert.equal(execucao.filter((e) => e.tipo === "calc").length, 63);
    assert.equal(execucao.filter((e) => e.tipo === "criar").length, 63);
    for (const doc of comFalha) {
      assert.equal(
        execucao.filter((e) => e.doc === doc && e.tipo !== "cadastro").length,
        0,
        "proposta de tomador falho nunca chega à Sinqia",
      );
    }

    const d = await detalhe(id);
    assert.deepEqual(d.placarPorTipo["tomador.cadastrar"], {
      total: 70, pendentes: 0, executando: 0, executadas: 63, falhas: 7, reprovadas: 0, canceladas: 0,
    });
    assert.deepEqual(d.placarPorTipo["proposta.criar"], {
      total: 70, pendentes: 0, executando: 0, executadas: 63, falhas: 7, reprovadas: 0, canceladas: 0,
    });
    const falhasPropostas = (d.itens as ItemVisto[]).filter(
      (i) => i.tipo === "proposta.criar" && i.estado === "falha",
    );
    assert.ok(
      falhasPropostas.every((i) => i.resultado?.causa === "tomador_nao_criado"),
      "falha de proposta por vínculo tem a causa certa",
    );
    assert.equal(d.requisicao.estado, "falha");
    console.log(
      `US-07 composto 70+70: duracaoMediaItemMs=${d.requisicao.resultado.duracaoMediaItemMs}ms, ` +
        `duracaoTotalMs=${d.requisicao.resultado.duracaoTotalMs}ms`,
    );
  });
});

/* ------------------------------------------------------------------ */
/* Regressão — flag OFF e corte                                         */
/* ------------------------------------------------------------------ */

describe("US-07 — regressão: fluxo direto intacto com flag OFF; corte à prova de corrida", () => {
  test("flag OFF: /api/propostas/criar segue para o job direto (SSE), sem seção de aprovação", async () => {
    const linha = linhaEmissao("81");
    const c = await carregarECalcular([linha]);
    flagsAtivas.clear();

    const r = await requisitar(c);
    assert.equal(r.statusCode, 200, r.body);
    assert.ok(r.json().jobId, "job direto criado (SSE segue como antes)");
    assert.equal(r.json().aprovacao, undefined);
  });

  test("corte (US-05): flag ativada ENTRE o desvio e a execução direta → 409 ACAO_SOB_APROVACAO", async () => {
    const linha = linhaEmissao("80");
    const c = await carregarECalcular([linha]);
    flagsAtivas.clear();

    let leituras = 0;
    const appCorrida = Fastify();
    await appCorrida.register(cookie);
    await appCorrida.register(multipart, { limits: { fileSize: 1024 * 1024, files: 1 } });
    await registerPropostasRoutes(appCorrida, {
      calcProspFn: calcSpy,
      criarUmaFn: async () => {
        throw new Error("não deve criar na Sinqia");
      },
      sodServico: () => servico,
      aprovacaoAtivaFn: (tipo) => {
        if (tipo !== "proposta.criar_lote") return false;
        leituras++;
        return leituras >= 2; // OFF no desvio, ON no guard
      },
    });
    await appCorrida.ready();
    try {
      // O retentor de cálculos é módulo-global: o job da fase 2 vale aqui também.
      const r = await appCorrida.inject({
        method: "POST",
        url: "/api/propostas/criar",
        cookies: { sid: sidMaria },
        payload: {
          calcJobId: c.calcJobId,
          linhas: c.linhasOK,
          params: { txJuros: 12, cdProd: 1015, idCarCtr: 31, cdConven: "111", dtContra: 20_260_805 },
          piloto: false,
          forcarDuplicadas: false,
        },
      });
      assert.equal(r.statusCode, 409, r.body);
      assert.equal(r.json().code, "ACAO_SOB_APROVACAO");
    } finally {
      await appCorrida.close();
    }
  });
});
