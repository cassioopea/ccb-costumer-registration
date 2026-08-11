/**
 * @homolog — US-07: lote de propostas COMPOSTO (3 tomadores + 3 propostas).
 *
 * A envia a planilha de Emissões (CSV) + o arquivo de tomadores; o vínculo
 * tomador→proposta é por CPF. B aprova com UMA exceção reprovando um tomador —
 * a proposta vinculada tem de cair por PROPAGAÇÃO. Na execução, cada proposta
 * passa pelo cálculo oficial + conferência contra a planilha (RN02).
 */
import { EXEMPLO_PF } from "@cadastro-lote/shared";
import {
  aguardar,
  cpfSintetico,
  estado,
  evidencia,
  get,
  log,
  login,
  post,
  salvarEstado,
  snapshotJob,
  upload,
  agora,
} from "./lib.mjs";

await login("A");
await login("B");

const st = estado();
const passos = [];
const registra = (id, esperado, obtido, ok, extra = {}) => {
  passos.push({ id, esperado, obtido, resultado: ok ? "PASSOU" : "FALHOU", ...extra });
  log(`${ok ? "PASSOU" : "FALHOU"}  ${id} — ${obtido}`);
  return ok;
};

/* Dados: os MESMOS termos da US-04 (líquido 10.000, 12x, 1º vcto 10/09/2026),
   cujo cálculo oficial em HML deu parcela 929,90 e financiado 10.500 (TAC 500
   via vlConces). A planilha traz esses valores para a conferência passar. */
const COMP = ["C1", "C2", "C3"].map((id, i) => ({
  id,
  cpf: cpfSintetico(900810030 + i),
  nome: `TESTE-SOD-${id} GERALDO L B ARAGAO`,
}));

const COLUNAS_EMISSOES = [
  "Nome",
  "CPF",
  "ID_Sinqia",
  "N_CCB",
  "Valor da parcela inicial",
  "N_Contrato",
  "Liquido",
  "Financiado",
  "Quantidade Parcelas",
  "TAC",
  "Seguro",
  "Out. vlr",
  "1º vcto. De juros",
  "Situação",
];
const csvCampo = (v) => (/[",\r\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
/*
 * ACHADO US-07 (registrado no relatório): o parser do Emissões exige ID_Sinqia
 * em TODA linha (emissoes.ts:201) — e um tomador que só vai existir depois da
 * execução do próprio lote não tem ID. Para validar o RESTO da história em HML,
 * a planilha vai com um ID_Sinqia sintético de formato válido; o cenário real do
 * composto (tomador novo, sem ID) fica BLOQUEADO por essa validação.
 */
const ID_SINQIA_CONTORNO = "999-9";
const emissoes = [
  COLUNAS_EMISSOES.join(","),
  ...COMP.map((c, i) =>
    [
      c.nome,
      c.cpf,
      ID_SINQIA_CONTORNO,
      `TESTE-SOD-CCB-${i + 1}`,
      "929.90",
      "",
      "10000.00",
      "10500.00",
      "12",
      "0",
      "0",
      "0",
      "10/09/2026",
      "Compliance",
    ]
      .map(csvCampo)
      .join(","),
  ),
].join("\r\n");

const COLUNAS_TOM = Object.keys(EXEMPLO_PF);
const csvTomadores = [
  COLUNAS_TOM.map(csvCampo).join(","),
  ...COMP.map((c) => {
    const linha = {
      ...EXEMPLO_PF,
      dsNome: c.nome,
      nrCpfCnpj: c.cpf,
      dsEmail: `teste.sod.${c.id.toLowerCase()}@opea.com.br`,
    };
    return COLUNAS_TOM.map((k) => csvCampo(linha[k] ?? "")).join(",");
  }),
].join("\r\n");

const PARAMS_CALC = { txJuros: 12, cdProd: 1015, idCarCtr: 31, dtContra: 20260810 };
const PARAMS_CRIAR = { ...PARAMS_CALC, cdConven: "111" };
const CONTROL = { finalizar: false, idIntegracaoCadastro: "S" };

/* 7.1a — parse da planilha ------------------------------------------- */
const rParse = await upload("A", "/api/propostas/parse", "TESTE-SOD-emissoes.csv", emissoes);
registra(
  "7.1a parse da planilha de Emissões em CSV",
  "3 linhas reconhecidas sem erro",
  `HTTP ${rParse.status} total=${rParse.json?.total} avisos=${JSON.stringify(rParse.json?.avisos ?? [])}`,
  rParse.status === 200 && rParse.json?.total === 3,
  { resposta: { total: rParse.json?.total, porSituacao: rParse.json?.porSituacao, avisos: rParse.json?.avisos } },
);
const rows = rParse.json?.rows ?? [];

/* 7.1b — arquivo de tomadores retido no servidor ---------------------- */
const rTom = await upload(
  "A",
  "/api/propostas/tomadores/parse",
  "TESTE-SOD-tomadores-composto.csv",
  csvTomadores,
  CONTROL,
);
registra(
  "7.1b arquivo de tomadores do composto é aceito e retido",
  "200 com uploadId e 3 tomadores",
  `HTTP ${rTom.status} uploadId=${rTom.json?.uploadId ? "sim" : "não"} total=${rTom.json?.total}`,
  rTom.status === 200 && rTom.json?.total === 3,
  { resposta: { total: rTom.json?.total, tomadores: rTom.json?.tomadores } },
);

/* 7.1c — cálculo do requisitante (fase 2) ---------------------------- */
const rCalc = await post("A", "/api/propostas/calcular", { rows, params: PARAMS_CALC });
const calcJobId = rCalc.json?.jobId ?? null;
const fim = await aguardar(
  async () => {
    const s = await snapshotJob("A", `/api/propostas/calcular/stream/${calcJobId}`);
    return s.snapshot?.done ? s.snapshot : null;
  },
  { timeoutMs: 180_000, intervaloMs: 2000 },
);
registra(
  "7.1c cálculo em lote conclui com as 3 linhas OK",
  "job done, 3 sucessos, zero divergência",
  `jobId=${calcJobId ? "sim" : "não"} done=${fim?.done} success=${fim?.success} divergencia=${fim?.divergencia} erro=${fim?.error}`,
  !!fim && fim.success === 3,
  { snapshotFinal: fim ? { total: fim.total, success: fim.success, divergencia: fim.divergencia, error: fim.error } : null },
);

/* 7.1d — criar a requisição-lote COMPOSTA ---------------------------- */
const rCriar = await post("A", "/api/propostas/criar", {
  calcJobId,
  linhas: rows.map((r) => r.linha),
  params: PARAMS_CRIAR,
  tomadoresUploadId: rTom.json?.uploadId,
  arquivo: "TESTE-SOD-emissoes.csv",
});
const loteId = rCriar.json?.requisicao?.id ?? null;
registra(
  "7.1d lote COMPOSTO criado (3 tomadores + 3 propostas)",
  "201 com composto:true, 6 itens e 3 vínculos",
  `HTTP ${rCriar.status} itens=${rCriar.json?.requisicao?.totalItens} composto=${rCriar.json?.requisicao?.composto} vinculos=${rCriar.json?.requisicao?.vinculos}`,
  rCriar.status === 201 &&
    rCriar.json?.requisicao?.totalItens === 6 &&
    rCriar.json?.requisicao?.composto === true &&
    rCriar.json?.requisicao?.vinculos === 3,
  { requisicaoId: loteId, resposta: rCriar.json },
);
if (!loteId) {
  log(`ABORTANDO US-07 — resposta: ${JSON.stringify(rCriar.json).slice(0, 900)}`);
  evidencia("50-us07-lote-composto", { quando: agora(), passos });
  process.exit(1);
}

const detalhe = (perfil) => get(perfil, `/api/sod/requisicoes/${loteId}`);
const dep = await detalhe("B");
const itens = dep.json?.itens ?? [];
const tomadoresItens = itens.filter((i) => i.tipo === "tomador.cadastrar");
const propostasItens = itens.filter((i) => i.tipo === "proposta.criar");

/* 7.2 — encadeamento e vínculo --------------------------------------- */
registra(
  "7.2 encadeamento tomador→proposta persistido",
  "tomadores primeiro (ordem 1..3) e cada proposta com dependeDeItemId",
  `tomadores=${tomadoresItens.length} propostas=${propostasItens.length} ` +
    `comVinculo=${propostasItens.filter((p) => p.dependeDeItemId).length}`,
  tomadoresItens.length === 3 &&
    propostasItens.length === 3 &&
    propostasItens.every((p) => !!p.dependeDeItemId) &&
    tomadoresItens.every((t) => t.ordem <= 3),
  { itens },
);

/* 7.3 — violação de SoD + propagação de exceção ----------------------- */
const r73sod = await post("A", `/api/sod/requisicoes/${loteId}/decisao`, { decisao: "aprovar" });
const tomadorC2 = tomadoresItens.find((t) => String(t.resumo?.nome ?? "").includes("C2"));
const propostaC2 = propostasItens.find((p) => p.dependeDeItemId === tomadorC2?.id);
const MOTIVO = "TESTE-SOD: exceção de homologação — documentação do tomador C2 pendente (US-07).";
const r73 = await post("B", `/api/sod/requisicoes/${loteId}/decisao`, {
  decisao: "aprovar",
  excecoes: [{ itemId: tomadorC2.id, motivo: MOTIVO }],
});
registra(
  "7.3a violação de SoD no lote composto",
  "403 VIOLACAO_SOD",
  `HTTP ${r73sod.status} code=${r73sod.json?.code}`,
  r73sod.status === 403 && r73sod.json?.code === "VIOLACAO_SOD",
  { resposta: r73sod.json },
);
registra(
  "7.3b exceção que reprova tomador propaga para a proposta vinculada",
  "decisão aceita; a proposta de C2 fica reprovada por propagação, com o motivo do tomador",
  `HTTP ${r73.status} aprovados=${r73.json?.execucao?.aprovados} placar=${JSON.stringify(r73.json?.placar)}`,
  r73.status === 200,
  { resposta: r73.json },
);

/* 7.4/7.5 — execução, conferência e placar por tipo ------------------- */
const fimLote = await aguardar(
  async () => {
    const d = await detalhe("B");
    const e = d.json?.requisicao?.estado;
    return e && e !== "aprovada/executando" ? d : null;
  },
  { timeoutMs: 300_000, intervaloMs: 3000 },
);
const dFinal = fimLote ?? (await detalhe("B"));
const itensFinais = dFinal.json?.itens ?? [];
const porEstado = itensFinais.reduce((acc, i) => {
  acc[`${i.tipo}:${i.estado}`] = (acc[`${i.tipo}:${i.estado}`] ?? 0) + 1;
  return acc;
}, {});
const propC2Final = itensFinais.find((i) => i.id === propostaC2?.id);
const tomC2Final = itensFinais.find((i) => i.id === tomadorC2?.id);
registra(
  "7.3c propagação registrada no item da proposta",
  "proposta vinculada reprovada com origem propagacao e o motivo do tomador",
  `tomadorC2=${tomC2Final?.estado} propostaC2=${propC2Final?.estado} motivo=${JSON.stringify(propC2Final?.motivo ?? null)}`,
  tomC2Final?.estado === "reprovada" && propC2Final?.estado === "reprovada" && !!propC2Final?.motivo,
  { itemTomadorC2: tomC2Final, itemPropostaC2: propC2Final },
);
const executadasProp = itensFinais.filter(
  (i) => i.tipo === "proposta.criar" && i.estado === "executada",
);
registra(
  "7.4 execução com cálculo oficial + conferência contra a planilha (RN02)",
  "2 propostas executadas sem divergência de conferência",
  `estadoLote=${dFinal.json?.requisicao?.estado} porEstado=${JSON.stringify(porEstado)}`,
  executadasProp.length === 2,
  {
    estadoLote: dFinal.json?.requisicao?.estado,
    placar: dFinal.json?.placar ?? null,
    placarPorTipo: dFinal.json?.placarPorTipo ?? null,
    itens: itensFinais,
  },
);
registra(
  "7.5 placar por tipo distingue tomadores × propostas",
  "placarPorTipo presente com os dois níveis",
  JSON.stringify(dFinal.json?.placarPorTipo ?? null),
  !!dFinal.json?.placarPorTipo,
  {},
);

/* Estado ------------------------------------------------------------- */
const propostasCriadas = [];
for (const item of executadasProp) {
  const d = await get("B", `/api/sod/requisicoes/${loteId}/itens/${item.id}`);
  const r = d.json?.item?.resultado ?? {};
  if (r.nrProsp) propostasCriadas.push({ nrProsp: Number(r.nrProsp), cpf: r.cpf ?? null, itemId: item.id });
}
st.propostas = {
  ...(st.propostas ?? {}),
  ...Object.fromEntries(
    propostasCriadas.map((p, i) => [`L${i + 1}`, { ...p, origem: "US-07 lote composto" }]),
  ),
};
st.tomadores = {
  ...(st.tomadores ?? {}),
  ...Object.fromEntries(
    COMP.map((c) => {
      const it = itensFinais.find(
        (i) => i.tipo === "tomador.cadastrar" && i.documento === c.cpf,
      );
      return [c.id, { cpf: c.cpf, nome: c.nome, origem: "US-07 composto", estado: it?.estado ?? "?" }];
    }),
  ),
};
st.requisicoes = { ...(st.requisicoes ?? {}), "US-07": { loteComposto: loteId } };
salvarEstado(st);

log(`\npropostas criadas no composto: ${JSON.stringify(propostasCriadas)}`);
log(`evidência: ${evidencia("50-us07-lote-composto", { quando: agora(), passos })}`);
log(`resultado: ${passos.filter((p) => p.resultado === "PASSOU").length}/${passos.length} cenários PASSOU`);
