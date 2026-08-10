/**
 * @homolog — US-11: badge de pendências.
 *
 * Medição por DELTA (a base tem requisições das US anteriores): o que importa é
 * a variação a cada evento. Regras a provar: as PRÓPRIAS não contam; lote conta
 * como 1; falha tratável conta; a contagem cai depois da decisão.
 */
import { EXEMPLO_PF } from "@cadastro-lote/shared";
import {
  cpfSintetico,
  estado,
  evidencia,
  get,
  log,
  login,
  post,
  salvarEstado,
  upload,
  agora,
} from "./lib.mjs";

await login("A");
await login("B");

const st = estado();
const passos = [];
const registra = (id, esperado, obtido, ok, detalhes = {}) => {
  passos.push({ id, esperado, obtido, veredito: ok ? "PASSOU" : "FALHOU", detalhes });
  log(`${ok ? "PASSOU" : "FALHOU"}  ${id} — ${obtido}`);
};

const badge = async (perfil) => (await get(perfil, "/api/sod/pendencias-badge")).json?.count ?? null;
const medir = async () => ({ A: await badge("A"), B: await badge("B") });

const CONTROL = { finalizar: false, idIntegracaoCadastro: "S" };
const COLUNAS = Object.keys(EXEMPLO_PF);
const csvCampo = (v) => (/[",\r\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
const tomador = (id, semente) => ({
  ...EXEMPLO_PF,
  dsNome: `TESTE-SOD-${id} GERALDO L B ARAGAO`,
  nrCpfCnpj: cpfSintetico(semente),
  dsEmail: `teste.sod.${id.toLowerCase()}@opea.com.br`,
});

const base = await medir();
log(`badge inicial — A=${base.A} B=${base.B}`);

/* 11.1 — requisição individual de A: conta para B, não para A --------- */
const ind = await post("A", "/api/cadastrar", { campos: tomador("B01", 900810051), control: CONTROL });
const reqInd = ind.json?.requisicao?.id ?? null;
const m1 = await medir();
registra(
  "11.1 requisição própria não conta para o criador",
  "B +1; A inalterado",
  `A ${base.A}→${m1.A} B ${base.B}→${m1.B}`,
  m1.B === base.B + 1 && m1.A === base.A,
  { requisicaoId: reqInd },
);

/* 11.2 — lote de A conta como UMA unidade ---------------------------- */
const linhas = [tomador("B02", 900810052), tomador("B03", 900810053)];
const csv = [
  COLUNAS.map(csvCampo).join(","),
  ...linhas.map((l) => COLUNAS.map((c) => csvCampo(l[c] ?? "")).join(",")),
].join("\r\n");
const lote = await upload("A", "/api/import", "TESTE-SOD-badge-lote.csv", csv, CONTROL);
const reqLote = lote.json?.requisicao?.id ?? null;
const m2 = await medir();
registra(
  "11.2 lote conta como 1 (não como número de itens)",
  "B +1 (lote de 2 itens); A inalterado",
  `A ${m1.A}→${m2.A} B ${m1.B}→${m2.B} (itens no lote=${lote.json?.requisicao?.totalItens})`,
  m2.B === m1.B + 1 && m2.A === m1.A,
  { requisicaoId: reqLote, totalItens: lote.json?.requisicao?.totalItens },
);

/* 11.3 — requisição de B conta para A -------------------------------- */
const indB = await post("B", "/api/cadastrar", { campos: tomador("B04", 900810054), control: CONTROL });
const reqIndB = indB.json?.requisicao?.id ?? null;
const m3 = await medir();
registra(
  "11.3 requisição de B conta para A (simetria do maker-checker)",
  "A +1; B inalterado",
  `A ${m2.A}→${m3.A} B ${m2.B}→${m3.B}`,
  m3.A === m2.A + 1 && m3.B === m2.B,
  { requisicaoId: reqIndB },
);

/* 11.4 — atualização pós-decisão ------------------------------------- */
const dec = await post("B", `/api/sod/requisicoes/${reqInd}/decisao`, { decisao: "aprovar" });
const m4 = await medir();
registra(
  "11.4 contagem cai após a decisão",
  "B −1 depois de decidir a individual",
  `HTTP ${dec.status} A ${m3.A}→${m4.A} B ${m3.B}→${m4.B}`,
  m4.B === m3.B - 1,
  { decisao: dec.json?.requisicao?.estado ?? null },
);

/* 11.5 — falha tratável entra na conta ------------------------------- */
const falhaId = st.requisicoes?.["US-10"]?.propostaRetry ?? null;
const depFalha = falhaId ? await get("B", `/api/sod/requisicoes/${falhaId}`) : null;
const listaFalhasB = await get("B", "/api/sod/requisicoes?estado=falha&limit=100");
const falhasDeTerceiros = (listaFalhasB.json?.itens ?? listaFalhasB.json?.requisicoes ?? []).length;
registra(
  "11.5 falha tratável de terceiro está na base da contagem",
  "existe falha criada por A, visível e decidível por B",
  `estadoFalha=${depFalha?.json?.requisicao?.estado ?? "-"} falhasListadas=${falhasDeTerceiros} badgeB=${m4.B}`,
  depFalha?.json?.requisicao?.estado === "falha",
  {
    requisicaoEmFalha: falhaId,
    chavesLista: listaFalhasB.json ? Object.keys(listaFalhasB.json) : [],
  },
);

/* Limpeza: as requisições auxiliares do badge são canceladas ---------- */
const limpeza = [];
for (const [perfil, id] of [
  ["A", reqLote],
  ["B", reqIndB],
]) {
  if (!id) continue;
  const c = await post(perfil, `/api/sod/requisicoes/${id}/decisao`, { decisao: "cancelar" });
  limpeza.push({ id, perfil, status: c.status });
}
const fim = await medir();
log(`limpeza: ${JSON.stringify(limpeza)} — badge final A=${fim.A} B=${fim.B}`);

st.requisicoes = {
  ...(st.requisicoes ?? {}),
  "US-11": { individualA: reqInd, loteA: reqLote, individualB: reqIndB },
};
salvarEstado(st);

log(`\nevidência: ${evidencia("90-us11-badge", { quando: agora(), medicoes: { base, m1, m2, m3, m4, fim }, passos })}`);
log(`resultado: ${passos.filter((p) => p.veredito === "PASSOU").length}/${passos.length} cenários PASSOU`);
