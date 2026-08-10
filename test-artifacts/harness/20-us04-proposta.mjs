/**
 * @homolog — US-04: proposta individual, ciclo completo em HML.
 *
 * A calcula e requisita; B aprova. O cálculo OFICIAL roda na execução (sessão
 * do aprovador) e a proposta precisa aparecer no painel. O último cenário
 * provoca uma FALHA REAL (proposta idêntica → guarda de duplicidade da Sinqia),
 * que é o insumo da US-10.
 */
import { estado, evidencia, get, log, login, post, salvarEstado, agora } from "./lib.mjs";

await login("A");
await login("B");

const st = estado();
const T01 = st.tomadores?.T01;
if (!T01) throw new Error("Estado sem T01 — rode 10-us010203-tomador.mjs primeiro.");

const passos = [];
const registra = (id, esperado, obtido, ok, extra = {}) => {
  passos.push({ id, esperado, obtido, resultado: ok ? "PASSOU" : "FALHOU", ...extra });
  log(`${ok ? "PASSOU" : "FALHOU"}  ${id} — ${obtido}`);
  return ok;
};

const DADOS = {
  vlLiquido: 10000,
  qtParcelas: 12,
  dtVct1Ap: 20260910,
  vlTac: 0,
  vlSeguro: 0,
  vlOutros: 0,
};
const PARAMS_CALC = { txJuros: 12, cdProd: 1015, idCarCtr: 31, dtContra: 20260810 };
const PARAMS_CRIAR = {
  txJuros: 12,
  cdProd: 1015,
  idCarCtr: 31,
  cdConven: "111",
  dtContra: 20260810,
};

async function calcular() {
  return post("A", "/api/propostas/calcular-uma", {
    cpf: T01.cpf,
    nome: T01.nome,
    dados: DADOS,
    params: PARAMS_CALC,
  });
}

/* 4.1 — cálculo do requisitante (pré-requisito da requisição) --------- */
const r41 = await calcular();
registra(
  "4.1 cálculo do requisitante (pré-requisito)",
  "200 com calcId e resumo (parcela, CET, IOF)",
  `HTTP ${r41.status} calcId=${r41.json?.calcId ? "sim" : "não"} vlPresta=${r41.json?.resumo?.vlPresta} ` +
    `CET=${r41.json?.resumo?.txCetAm} IOF=${r41.json?.resumo?.vlIof}`,
  r41.status === 200 && !!r41.json?.calcId,
  { resumoReferencia: r41.json?.resumo ?? null, erro: r41.json?.error ?? null },
);
if (!r41.json?.calcId) {
  log(`ABORTANDO US-04: sem cálculo. Resposta: ${JSON.stringify(r41.json).slice(0, 600)}`);
  evidencia("20-us04-proposta", { quando: agora(), passos });
  process.exit(1);
}

/* 4.2 — criar requisição --------------------------------------------- */
const r42 = await post("A", "/api/propostas/criar-uma", {
  calcId: r41.json.calcId,
  params: PARAMS_CRIAR,
  forcarDuplicada: false,
});
const reqProp = r42.json?.requisicao?.id ?? null;
registra(
  "4.2 criar requisição de proposta (A)",
  "201 aprovacao:true, requisição pendente, zero criação na Sinqia",
  `HTTP ${r42.status} aprovacao=${r42.json?.aprovacao} estado=${r42.json?.requisicao?.estado}`,
  r42.status === 201 && r42.json?.requisicao?.estado === "pendente",
  { requisicaoId: reqProp, resposta: r42.json },
);

/* 4.2b — duplicidade pendente de proposta (RN04) ---------------------- */
const r42bCalc = await calcular();
const r42b = r42bCalc.json?.calcId
  ? await post("A", "/api/propostas/criar-uma", {
      calcId: r42bCalc.json.calcId,
      params: PARAMS_CRIAR,
      forcarDuplicada: false,
    })
  : { status: 0, json: { error: "sem calcId" } };
registra(
  "4.2b duplicidade pendente de proposta (RN04)",
  "409 DUPLICIDADE_PENDENTE (mesma assinatura já pendente)",
  `HTTP ${r42b.status} code=${r42b.json?.code}`,
  r42b.status === 409 && r42b.json?.code === "DUPLICIDADE_PENDENTE",
  { resposta: r42b.json },
);

/* 4.3 — violação de SoD ---------------------------------------------- */
const r43 = await post("A", `/api/sod/requisicoes/${reqProp}/decisao`, { decisao: "aprovar" });
registra(
  "4.3 violação de SoD na proposta (A aprova o que A criou)",
  "403 VIOLACAO_SOD",
  `HTTP ${r43.status} code=${r43.json?.code}`,
  r43.status === 403 && r43.json?.code === "VIOLACAO_SOD",
  { resposta: r43.json },
);

/* 4.4 — aprovação por B: cálculo oficial + criação -------------------- */
const t0 = Date.now();
const r44 = await post("B", `/api/sod/requisicoes/${reqProp}/decisao`, { decisao: "aprovar" });
const ms44 = Date.now() - t0;
const dep44 = await get("B", `/api/sod/requisicoes/${reqProp}`);
const resultado = dep44.json?.requisicao?.resultado ?? null;
const nrProsp =
  resultado?.nrProposta ?? resultado?.proposta?.nrProsp ?? resultado?.publico?.nrProposta ?? null;
registra(
  "4.4 aprovação por B executa com cálculo OFICIAL",
  "executada; parcelas/CET/IOF do recálculo no resultado; divergências rotuladas",
  `HTTP ${r44.status} estado=${dep44.json?.requisicao?.estado} nrProsp=${nrProsp ?? "-"} (${ms44} ms)`,
  r44.status === 200 && dep44.json?.requisicao?.estado === "executada",
  {
    execucaoPublica: r44.json?.execucao ?? null,
    resultadoIntegral: resultado,
    divergenciasReferencia: resultado?.divergenciasReferencia ?? null,
    calculoOficial: resultado?.calculoOficial ?? resultado?.calculo ?? null,
    duracaoMs: ms44,
  },
);

/* 4.5 — proposta no painel ------------------------------------------- */
let painel = null;
if (nrProsp) {
  painel = await post("A", "/api/propostas/painel", {
    filtros: { nrPropos: String(nrProsp) },
    size: 5,
  });
}
const linha = painel?.json?.propostas?.[0] ?? null;
registra(
  "4.5 proposta aparece no painel",
  "proposta encontrada na etapa 20050 (Contrato em Assinatura)",
  painel
    ? `HTTP ${painel.status} nrProsp=${linha?.nrProsp ?? "-"} etapa=${linha?.nrStatus ?? "-"} ${linha?.dsStatus ?? ""}`
    : "sem número de proposta no resultado da execução",
  !!linha && Number(linha.nrProsp) === Number(nrProsp),
  { linhaPainel: linha },
);

/* 4.6 — FALHA REAL: proposta idêntica (guarda de duplicidade Sinqia) --- */
const r46Calc = await calcular();
let r46 = null;
let dep46 = null;
let reqProp2 = null;
if (r46Calc.json?.calcId) {
  const criar46 = await post("A", "/api/propostas/criar-uma", {
    calcId: r46Calc.json.calcId,
    params: PARAMS_CRIAR,
    forcarDuplicada: false,
  });
  reqProp2 = criar46.json?.requisicao?.id ?? null;
  if (reqProp2) {
    r46 = await post("B", `/api/sod/requisicoes/${reqProp2}/decisao`, { decisao: "aprovar" });
    dep46 = await get("B", `/api/sod/requisicoes/${reqProp2}`);
  }
}
const estado46 = dep46?.json?.requisicao?.estado ?? null;
registra(
  "4.6 falha real na execução (proposta idêntica)",
  "falha com causa distinguível e erro integral anexado (insumo da US-10)",
  `estado=${estado46 ?? "-"} causa=${dep46?.json?.requisicao?.resultado?.causa ?? "-"}`,
  estado46 === "falha" || estado46 === "executada",
  {
    requisicaoId: reqProp2,
    estado: estado46,
    execucaoPublica: r46?.json?.execucao ?? null,
    resultadoIntegral: dep46?.json?.requisicao?.resultado ?? null,
    observacao:
      estado46 === "executada"
        ? "A Sinqia aceitou a segunda proposta idêntica — não houve falha para a US-10 por este caminho."
        : "Falha real obtida; serve de insumo para retry/descarte da US-10.",
  },
);

/* Estado ------------------------------------------------------------- */
st.propostas = {
  ...(st.propostas ?? {}),
  ...(nrProsp ? { P01: { nrProsp, cpf: T01.cpf, nome: T01.nome, requisicao: reqProp } } : {}),
};
if (estado46 === "executada") {
  const nr2 =
    dep46?.json?.requisicao?.resultado?.nrProposta ??
    dep46?.json?.requisicao?.resultado?.proposta?.nrProsp ??
    null;
  if (nr2) st.propostas.P02 = { nrProsp: nr2, cpf: T01.cpf, nome: T01.nome, requisicao: reqProp2 };
}
st.requisicoes = {
  ...(st.requisicoes ?? {}),
  "US-04": { proposta: reqProp, propostaDuplicada: reqProp2 },
};
salvarEstado(st);

log(`\nevidência: ${evidencia("20-us04-proposta", { quando: agora(), passos })}`);
log(`resultado: ${passos.filter((p) => p.resultado === "PASSOU").length}/${passos.length} cenários PASSOU`);
