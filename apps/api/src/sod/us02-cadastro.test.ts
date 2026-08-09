import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";

/**
 * US-02 — Requisição individual de cadastro de tomador + minhas requisições.
 *
 * Cobre os cenários da história ponta a ponta no BFF, offline:
 *  1. toggle ON + payload válido → requisição pendente, ZERO chamadas à
 *     Sinqia (spy), payload integral, visível em "minhas";
 *  2. duplicidade pendente por documento (RN02) — inclusive a corrida do
 *     índice único; estados terminais NÃO bloqueiam;
 *  3. cancelamento pelo criador; concorrência (já decidida) rejeitada com o
 *     estado atual; terceiro não cancela nem vê;
 *  4. payload inválido → mesmas validações do fluxo direto, nada criado;
 *  5. toggle OFF → fluxo direto intacto (regressão).
 *
 * Import dinâmico + fixtures de env: routes.ts importa env.ts e db.ts, que
 * validam/abrem recursos no load — tudo aponta para diretório temporário.
 */
process.env.SINQIA_BASE_URL ??= "https://sinqia.fixture.invalid";
process.env.SINQIA_ENV ??= "hml";

const dir = mkdtempSync(path.join(tmpdir(), "sod-us02-"));
// db.ts (base local de apoio) abre o arquivo no import — vai para o temp.
process.env.SQLITE_PATH = path.join(dir, "app.db");

const { EXEMPLO_PF } = await import("@cadastro-lote/shared");
const { abrirBancoSod, criarSodRepositorio, ehViolacaoDuplicidadePendente } = await import(
  "./repositorio.js"
);
const { criarSodServico, SodError } = await import("./dominio.js");
const { registerSodRoutes } = await import("./rotas.js");
const { registerRoutes } = await import("./../routes.js");
const { createSession, limparSessoes } = await import("./../session.js");

type Repo = ReturnType<typeof criarSodRepositorio>;

let app: FastifyInstance;
let db: ReturnType<typeof abrirBancoSod>;
let repo: Repo;
let servico: ReturnType<typeof criarSodServico>;
let sidMaria: string;
let sidJoao: string;
let sidAna: string;

/** Spy da Sinqia: cada chamada real de cadastro cai aqui. */
const chamadasSinqia: unknown[] = [];
/** Toggle controlável por teste (RN05). */
let toggleOn = false;

before(async () => {
  db = abrirBancoSod(path.join(dir, "sod.db"));
  repo = criarSodRepositorio(db, "hml");
  servico = criarSodServico(repo);

  app = Fastify();
  await app.register(cookie);
  await registerRoutes(app, {
    cadastrarClienteFn: async (_token, body) => {
      chamadasSinqia.push(body);
      return {
        httpStatus: 200,
        envelope: null,
        analysis: { ok: true, envelopeStatus: "OK", messagesText: "", messages: [] },
      };
    },
    sodServico: () => servico,
    aprovacaoAtivaFn: (tipo) => tipo === "tomador.cadastrar" && toggleOn,
  });
  await registerSodRoutes(app, servico);
  await app.ready();

  limparSessoes();
  // Caixa/espaço de propósito: identidade normalizada é regra da camada SoD.
  sidMaria = createSession("Maria.SILVA", "token-fixture-opaco").id;
  sidJoao = createSession("joao.souza", "token-fixture-opaco").id;
  sidAna = createSession("ana.lima", "token-fixture-opaco").id;
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

/** Body do /api/cadastrar com o documento trocado (um por cenário). */
function bodyCadastro(documento: string) {
  return {
    campos: { ...EXEMPLO_PF, nrCpfCnpj: documento },
    control: {},
    dryRun: false,
  };
}

describe("US-02 — toggle OFF (regressão do fluxo direto)", () => {
  test("payload válido → cadastra direto na Sinqia, nenhuma requisição criada", async () => {
    toggleOn = false;
    const antes = chamadasSinqia.length;
    const r = await post("/api/cadastrar", sidMaria, bodyCadastro("90000000001"));
    assert.equal(r.statusCode, 200);
    const body = r.json();
    assert.equal(body.valido, true);
    assert.equal(body.status, "OK");
    assert.equal(body.aprovacao, undefined);
    assert.equal(chamadasSinqia.length, antes + 1);

    const lista = (await get("/api/sod/requisicoes?limit=200", sidMaria)).json();
    assert.equal(lista.total, 0, "toggle OFF não pode criar requisição");
  });

  test("dry-run permanece intacto (valida e devolve o payload, sem Sinqia)", async () => {
    toggleOn = false;
    const antes = chamadasSinqia.length;
    const r = await post("/api/cadastrar", sidMaria, {
      ...bodyCadastro("90000000001"),
      dryRun: true,
    });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().dryRun, true);
    assert.equal(chamadasSinqia.length, antes);
  });
});

describe("US-02 — Cenário 1: toggle ON cria requisição pendente", () => {
  test("payload válido → pendente com payload integral, ZERO chamadas à Sinqia, visível em minhas", async () => {
    toggleOn = true;
    const antes = chamadasSinqia.length;
    const r = await post("/api/cadastrar", sidMaria, bodyCadastro("90000000002"));
    assert.equal(r.statusCode, 201);
    const body = r.json();

    // Confirmação com identificador e sem efeito na Sinqia (RN04).
    assert.equal(body.valido, true);
    assert.equal(body.aprovacao, true);
    assert.ok(body.requisicao?.id, "resposta traz o identificador da requisição");
    assert.equal(body.requisicao.estado, "pendente");
    assert.equal(chamadasSinqia.length, antes, "NENHUMA chamada à Sinqia com o toggle ativo");

    // Payload integral: campos como digitados + controles + request montado.
    const detalhe = (await get(`/api/sod/requisicoes/${body.requisicao.id}`, sidMaria)).json();
    assert.equal(detalhe.requisicao.tipo, "tomador.cadastrar");
    assert.equal(detalhe.requisicao.requisitante, "maria.silva");
    assert.equal(detalhe.requisicao.documento, "90000000002");
    assert.deepEqual(detalhe.requisicao.payload.campos, {
      ...EXEMPLO_PF,
      nrCpfCnpj: "90000000002",
    });
    assert.ok(detalhe.requisicao.payload.control, "controles preservados");
    assert.ok(
      (detalhe.requisicao.payload.request as { cliente?: unknown }).cliente,
      "request Sinqia montado e anexado",
    );
    // Auditoria da criação presente.
    assert.ok(
      detalhe.historico.some((e: { acao: string }) => e.acao === "requisicao_criada"),
      "trilha de auditoria registra a criação",
    );

    // Visível em "minhas requisições" do criador.
    const minhas = (await get("/api/sod/requisicoes?minhas=1&limit=200", sidMaria)).json();
    assert.ok(
      minhas.itens.some((i: { id: string }) => i.id === body.requisicao.id),
      "item aparece na lista do usuário logado",
    );
  });
});

describe("US-02 — Cenário 4: payload inválido não vira requisição", () => {
  test("mesmas validações do fluxo direto; nada criado; nada enviado", async () => {
    const antesSinqia = chamadasSinqia.length;
    const totalAntes = (await get("/api/sod/requisicoes?limit=200", sidMaria)).json().total;

    // Documento com 12 dígitos: reprova na MESMA validação do fluxo atual.
    toggleOn = true;
    const comToggle = await post("/api/cadastrar", sidMaria, bodyCadastro("123456789012"));
    assert.equal(comToggle.statusCode, 200);
    assert.equal(comToggle.json().valido, false);
    assert.ok(comToggle.json().errors.length > 0);

    toggleOn = false;
    const semToggle = await post("/api/cadastrar", sidMaria, bodyCadastro("123456789012"));
    toggleOn = true;
    assert.deepEqual(
      comToggle.json().errors,
      semToggle.json().errors,
      "erros idênticos com toggle ON e OFF (RN01)",
    );

    assert.equal(chamadasSinqia.length, antesSinqia, "payload inválido nunca vai à Sinqia");
    const totalDepois = (await get("/api/sod/requisicoes?limit=200", sidMaria)).json().total;
    assert.equal(totalDepois, totalAntes, "nenhuma requisição criada");
  });
});

describe("US-02 — Cenário 2: guarda de duplicidade pendente (RN02)", () => {
  const DOC = "90000000003";

  test("segunda tentativa com pendente do mesmo documento → 409 com referência à existente", async () => {
    toggleOn = true;
    const primeira = (await post("/api/cadastrar", sidMaria, bodyCadastro(DOC))).json();
    assert.equal(primeira.aprovacao, true);

    // Bloqueia inclusive para OUTRO requisitante — a guarda é por documento.
    const segunda = await post("/api/cadastrar", sidJoao, bodyCadastro(DOC));
    assert.equal(segunda.statusCode, 409);
    const body = segunda.json();
    assert.equal(body.code, "DUPLICIDADE_PENDENTE");
    assert.ok(body.error.includes(primeira.requisicao.id), "mensagem cita a requisição existente");
    assert.equal(body.requisicaoExistente.id, primeira.requisicao.id);

    // Tentativa rejeitada consta na auditoria (RN06).
    const auditoria = (
      await get(`/api/sod/auditoria?requisicaoId=${primeira.requisicao.id}&limit=200`, sidMaria)
    ).json();
    assert.ok(
      auditoria.itens.some(
        (e: { acao: string; resultado: string }) =>
          e.acao === "tentativa_rejeitada" && e.resultado === "rejeitada:duplicidade_pendente",
      ),
    );
  });

  test("estado terminal NÃO bloqueia: cancelada libera novo pedido do mesmo documento", async () => {
    toggleOn = true;
    const pendente = (await get(`/api/sod/requisicoes?minhas=1&estado=pendente&limit=200`, sidMaria))
      .json()
      .itens.find((i: { documento: string | null }) => i.documento === DOC);
    assert.ok(pendente, "pendente do cenário anterior existe");

    const cancel = await post(`/api/sod/requisicoes/${pendente.id}/decisao`, sidMaria, {
      decisao: "cancelar",
    });
    assert.equal(cancel.statusCode, 200);
    assert.equal(cancel.json().requisicao.estado, "cancelada");

    const nova = await post("/api/cadastrar", sidMaria, bodyCadastro(DOC));
    assert.equal(nova.statusCode, 201, "terminal não bloqueia nova requisição");
  });

  test("corrida do INSERT (índice único parcial) também vira DUPLICIDADE_PENDENTE", async () => {
    const DOC_CORRIDA = "90000000004";
    servico.criarRequisicao({
      tipo: "tomador.cadastrar",
      payload: { campos: { nrCpfCnpj: DOC_CORRIDA } },
      requisitante: "maria.silva",
    });

    // Repositório direto (sem a pré-checagem do domínio) = a segunda submissão
    // da corrida: o banco aborta pelo índice único parcial.
    assert.throws(
      () =>
        repo.criarRequisicao(
          {
            id: "11111111-1111-4111-8111-111111111111",
            tipo: "tomador.cadastrar",
            payload: { campos: { nrCpfCnpj: DOC_CORRIDA } },
            documento: DOC_CORRIDA,
            requisitante: "joao.souza",
            criadoEm: new Date().toISOString(),
          },
          {
            requisicaoId: "11111111-1111-4111-8111-111111111111",
            ator: "joao.souza",
            acao: "requisicao_criada",
            detalhe: {},
            resultado: "ok",
            ts: new Date().toISOString(),
          },
        ),
      (e: unknown) => ehViolacaoDuplicidadePendente(e),
    );

    // Domínio com a pré-checagem "furada" (corrida simulada): ainda assim o
    // erro chega tipado como DUPLICIDADE_PENDENTE, nunca um 500 genérico.
    let cegado = true;
    const servicoCorrida = criarSodServico({
      ...repo,
      pendentePorDocumento: (tipo, doc) => {
        if (cegado) {
          cegado = false; // primeira consulta (pré-checagem) não vê nada
          return null;
        }
        return repo.pendentePorDocumento(tipo, doc); // recuperação pós-corrida
      },
    } as Repo);
    assert.throws(
      () =>
        servicoCorrida.criarRequisicao({
          tipo: "tomador.cadastrar",
          payload: { campos: { nrCpfCnpj: DOC_CORRIDA } },
          requisitante: "joao.souza",
        }),
      (e: unknown) => e instanceof SodError && e.codigo === "DUPLICIDADE_PENDENTE",
    );
  });
});

describe("US-02 — Cenário 3: cancelamento", () => {
  test("criador cancela pendente → cancelada, com transição auditada", async () => {
    toggleOn = true;
    const criada = (await post("/api/cadastrar", sidMaria, bodyCadastro("90000000005"))).json();
    const r = await post(`/api/sod/requisicoes/${criada.requisicao.id}/decisao`, sidMaria, {
      decisao: "cancelar",
    });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().requisicao.estado, "cancelada");

    const detalhe = (await get(`/api/sod/requisicoes/${criada.requisicao.id}`, sidMaria)).json();
    assert.ok(
      detalhe.historico.some(
        (e: { acao: string; detalhe: { para?: string } }) =>
          e.acao === "transicao_estado" && e.detalhe.para === "cancelada",
      ),
      "auditoria registra pendente → cancelada",
    );
  });

  test("requisição já decidida (concorrência) → 409 com o estado atual, sem efeito colateral", async () => {
    toggleOn = true;
    const criada = (await post("/api/cadastrar", sidMaria, bodyCadastro("90000000006"))).json();
    // Outro operador decide primeiro (aprova) — simula a corrida.
    const aprova = await post(`/api/sod/requisicoes/${criada.requisicao.id}/decisao`, sidJoao, {
      decisao: "aprovar",
    });
    assert.equal(aprova.statusCode, 200);

    const cancel = await post(`/api/sod/requisicoes/${criada.requisicao.id}/decisao`, sidMaria, {
      decisao: "cancelar",
    });
    assert.equal(cancel.statusCode, 409);
    assert.equal(cancel.json().code, "TRANSICAO_INVALIDA");
    assert.ok(
      cancel.json().error.includes("aprovada/executando"),
      "resposta informa o estado atual",
    );

    const detalhe = (await get(`/api/sod/requisicoes/${criada.requisicao.id}`, sidMaria)).json();
    assert.equal(detalhe.requisicao.estado, "aprovada/executando", "estado preservado");
  });

  test("terceiro não cancela (403) e não vê a requisição em 'minhas'", async () => {
    toggleOn = true;
    const criada = (await post("/api/cadastrar", sidMaria, bodyCadastro("90000000007"))).json();

    const cancel = await post(`/api/sod/requisicoes/${criada.requisicao.id}/decisao`, sidAna, {
      decisao: "cancelar",
    });
    assert.equal(cancel.statusCode, 403);
    assert.equal(cancel.json().code, "CANCELAMENTO_NEGADO");

    const minhasDaAna = (await get("/api/sod/requisicoes?minhas=1&limit=200", sidAna)).json();
    assert.ok(
      !minhasDaAna.itens.some((i: { id: string }) => i.id === criada.requisicao.id),
      "'minhas' de terceiro não contém a requisição",
    );
  });
});

describe("US-02 — lista 'minhas requisições'", () => {
  test("mostra somente as do usuário logado e filtra por estado/tipo", async () => {
    toggleOn = true;
    await post("/api/cadastrar", sidAna, bodyCadastro("90000000008"));

    const minhas = (await get("/api/sod/requisicoes?minhas=1&limit=200", sidAna)).json();
    assert.ok(minhas.total >= 1);
    assert.ok(
      minhas.itens.every((i: { requisitante: string }) => i.requisitante === "ana.lima"),
      "todos os itens pertencem ao usuário logado",
    );

    // `minhas` prevalece sobre requisitante forjado no query param.
    const forjada = (
      await get("/api/sod/requisicoes?minhas=1&requisitante=maria.silva&limit=200", sidAna)
    ).json();
    assert.ok(
      forjada.itens.every((i: { requisitante: string }) => i.requisitante === "ana.lima"),
      "identidade vem da sessão, não do parâmetro",
    );

    const pendentes = (
      await get("/api/sod/requisicoes?minhas=1&estado=pendente&limit=200", sidAna)
    ).json();
    assert.ok(pendentes.itens.every((i: { estado: string }) => i.estado === "pendente"));

    const porTipo = (
      await get("/api/sod/requisicoes?minhas=1&tipo=tomador.cadastrar&limit=200", sidAna)
    ).json();
    assert.equal(porTipo.total, minhas.total, "filtro por tipo casa com o único tipo entregue");

    // Ordenação: da mais recente para a mais antiga.
    const criadoEm = minhas.itens.map((i: { criadoEm: string }) => i.criadoEm);
    const ordenado = [...criadoEm].sort().reverse();
    assert.deepEqual(criadoEm, ordenado);
  });
});
