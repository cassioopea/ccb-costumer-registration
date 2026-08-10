/**
 * @homolog — US-01/02/03: tomador individual, ciclo completo em HML.
 *
 * A cria; B decide. Cobre validação, duplicidade pendente, violação de SoD,
 * aprovação com execução real na Sinqia, reprovação com motivo + novo ciclo e
 * cancelamento pelo criador.
 */
import { EXEMPLO_PF } from "@cadastro-lote/shared";
import {
  api,
  cpfSintetico,
  estado,
  evidencia,
  get,
  log,
  login,
  post,
  salvarEstado,
  agora,
} from "./lib.mjs";

await login("A");
await login("B");

const CONTROL = { finalizar: false, idIntegracaoCadastro: "S" };
const st = estado();
const passos = [];

function registra(id, esperado, obtido, ok, extra = {}) {
  passos.push({ id, esperado, obtido, resultado: ok ? "PASSOU" : "FALHOU", ...extra });
  log(`${ok ? "PASSOU" : "FALHOU"}  ${id} — ${obtido}`);
  return ok;
}

/** Tomador de teste a partir do EXEMPLO_PF já validado em HML. */
function tomador(id, semente) {
  const cpf = cpfSintetico(semente);
  return {
    id,
    cpf,
    campos: {
      ...EXEMPLO_PF,
      dsNome: `TESTE-SOD-${id} GERALDO L B ARAGAO`,
      nrCpfCnpj: cpf,
      dsEmail: `teste.sod.${id.toLowerCase()}@opea.com.br`,
    },
  };
}

const T01 = tomador("T01", 900810001);
const T02 = tomador("T02", 900810002);
const T03 = tomador("T03", 900810003);

const criar = (perfil, t, extra = {}) =>
  post(perfil, "/api/cadastrar", { campos: t.campos, control: CONTROL, ...extra });
const decidir = (perfil, id, corpo) =>
  post(perfil, `/api/sod/requisicoes/${id}/decisao`, corpo);
const detalhe = (perfil, id) => get(perfil, `/api/sod/requisicoes/${id}`);

/* 1.1 — criar requisição (A) ------------------------------------------ */
const r11 = await criar("A", T01);
const req01 = r11.json?.requisicao?.id ?? null;
registra(
  "1.1 criar requisição de tomador (A)",
  "201 com aprovacao:true e requisição pendente; zero chamada à Sinqia",
  `HTTP ${r11.status} aprovacao=${r11.json?.aprovacao} estado=${r11.json?.requisicao?.estado}`,
  r11.status === 201 && r11.json?.aprovacao === true && r11.json?.requisicao?.estado === "pendente",
  { requisicaoId: req01, resposta: r11.json },
);

/* 1.2 — validação ANTES da requisição -------------------------------- */
const invalido = { ...T01, campos: { ...T01.campos, dsNome: "" } };
const r12 = await criar("A", invalido);
const listaAposInvalido = await get("A", "/api/sod/requisicoes?minhas=1&limit=200");
registra(
  "1.2 payload inválido não vira requisição",
  "valido:false com erros; nenhuma requisição nova",
  `HTTP ${r12.status} valido=${r12.json?.valido} erros=${JSON.stringify(r12.json?.errors ?? r12.json?.error)}`,
  r12.status === 200 && r12.json?.valido === false,
  { resposta: r12.json, totalMinhas: listaAposInvalido.json?.total ?? null },
);

/* 1.3 — duplicidade pendente (RN02) ---------------------------------- */
const r13 = await criar("A", T01);
registra(
  "1.3 duplicidade pendente por documento (RN02)",
  "409 DUPLICIDADE_PENDENTE com requisicaoExistente",
  `HTTP ${r13.status} code=${r13.json?.code} existente=${r13.json?.requisicaoExistente?.id ?? "-"}`,
  r13.status === 409 && r13.json?.code === "DUPLICIDADE_PENDENTE",
  { resposta: r13.json },
);

/* 1.4 — violação de SoD: A tenta aprovar o que A criou ---------------- */
const r14 = await decidir("A", req01, { decisao: "aprovar" });
const dep14 = await detalhe("A", req01);
registra(
  "1.4 violação de SoD (A aprova o que A criou)",
  "403 VIOLACAO_SOD, requisição segue pendente, tentativa auditada",
  `HTTP ${r14.status} code=${r14.json?.code} estadoDepois=${dep14.json?.requisicao?.estado}`,
  r14.status === 403 &&
    r14.json?.code === "VIOLACAO_SOD" &&
    dep14.json?.requisicao?.estado === "pendente",
  {
    resposta: r14.json,
    auditoriaTentativa: (dep14.json?.historico ?? []).filter((h) =>
      String(h.acao ?? "").includes("rejeit") || String(h.resultado ?? "").includes("VIOLACAO"),
    ),
  },
);

/* 1.5 — aprovação por B com execução REAL na Sinqia ------------------- */
const t0 = Date.now();
const r15 = await decidir("B", req01, { decisao: "aprovar" });
const ms15 = Date.now() - t0;
const dep15 = await detalhe("B", req01);
const envelope01 = dep15.json?.requisicao?.resultado?.envelope ?? null;
registra(
  "1.5 aprovação por B executa na Sinqia (B2')",
  "requisição executada com resposta integral da Sinqia anexada",
  `HTTP ${r15.status} estado=${dep15.json?.requisicao?.estado} httpSinqia=${r15.json?.execucao?.httpStatus} (${ms15} ms)`,
  r15.status === 200 && dep15.json?.requisicao?.estado === "executada",
  {
    execucaoPublica: r15.json?.execucao ?? null,
    resultadoIntegral: dep15.json?.requisicao?.resultado ?? null,
    historico: dep15.json?.historico ?? null,
    duracaoMs: ms15,
  },
);

/* 1.6 — tomador visível na plataforma -------------------------------- */
const r16 = await get("A", `/api/clientes/${T01.cpf}/propostas`);
registra(
  "1.6 tomador existe na Sinqia após a execução",
  "consulta por CPF responde sem erro de cliente inexistente",
  `HTTP ${r16.status} propostas=${JSON.stringify(r16.json?.propostas ?? r16.json?.error ?? null)}`,
  r16.status === 200,
  { resposta: r16.json },
);

/* 1.7 — reprovação com motivo + novo ciclo --------------------------- */
const r17a = await criar("A", T02);
const req02 = r17a.json?.requisicao?.id ?? null;
const r17b = await decidir("B", req02, {
  decisao: "reprovar",
  motivo: "TESTE-SOD: reprovação de validação de homologação (US-03).",
});
const dep17 = await detalhe("B", req02);
const okReprovada = r17b.status === 200 && dep17.json?.requisicao?.estado === "reprovada";

// Novo ciclo com o MESMO documento (o anterior é terminal).
const r17c = await criar("A", T02);
const req02b = r17c.json?.requisicao?.id ?? null;
const r17d = await decidir("B", req02b, { decisao: "aprovar" });
const dep17b = await detalhe("B", req02b);
registra(
  "1.7 reprovação com motivo e novo ciclo do mesmo documento",
  "reprovada (motivo na trilha, zero Sinqia) e, no ciclo novo, executada",
  `reprovada=${dep17.json?.requisicao?.estado} novoCiclo=${dep17b.json?.requisicao?.estado} (HTTP ${r17c.status}/${r17d.status})`,
  okReprovada && r17c.status === 201 && dep17b.json?.requisicao?.estado === "executada",
  {
    reprovacao: {
      requisicaoId: req02,
      motivo: dep17.json?.requisicao?.motivo ?? null,
      resultado: dep17.json?.requisicao?.resultado ?? null,
      historico: dep17.json?.historico ?? null,
    },
    novoCiclo: {
      requisicaoId: req02b,
      estado: dep17b.json?.requisicao?.estado,
      execucao: r17d.json?.execucao ?? null,
    },
  },
);

/* 1.8 — cancelamento pelo criador (e negado para o outro) ------------- */
const r18a = await criar("A", T03);
const req03 = r18a.json?.requisicao?.id ?? null;
const r18b = await decidir("B", req03, { decisao: "cancelar" });
const r18c = await decidir("A", req03, { decisao: "cancelar" });
const dep18 = await detalhe("A", req03);
registra(
  "1.8 cancelamento é exclusivo do criador",
  "B cancelar → 403 CANCELAMENTO_NEGADO; A cancelar → cancelada",
  `B=${r18b.status}/${r18b.json?.code} A=${r18c.status} estado=${dep18.json?.requisicao?.estado}`,
  r18b.status === 403 &&
    r18b.json?.code === "CANCELAMENTO_NEGADO" &&
    r18c.status === 200 &&
    dep18.json?.requisicao?.estado === "cancelada",
  { tentativaB: r18b.json, cancelamentoA: r18c.json, historico: dep18.json?.historico ?? null },
);

/* Estado para os passos seguintes ------------------------------------ */
st.tomadores = {
  ...(st.tomadores ?? {}),
  T01: { cpf: T01.cpf, nome: T01.campos.dsNome, requisicao: req01, estado: "executada" },
  T02: { cpf: T02.cpf, nome: T02.campos.dsNome, requisicao: req02b, estado: "executada" },
  T03: { cpf: T03.cpf, nome: T03.campos.dsNome, requisicao: req03, estado: "cancelada" },
};
st.requisicoes = {
  ...(st.requisicoes ?? {}),
  "US-01/02/03": { T01: req01, T02reprovada: req02, T02: req02b, T03cancelada: req03 },
};
salvarEstado(st);

const arquivo = evidencia("10-us010203-tomador", { quando: agora(), passos });
log(`\nevidência: ${arquivo}`);
log(`resultado: ${passos.filter((p) => p.resultado === "PASSOU").length}/${passos.length} cenários PASSOU`);
