/**
 * @homolog — US-06: lote de tomadores (3 itens) com decisão bidirecional.
 *
 * A envia o CSV (vira requisição-lote); B aprova com UMA exceção reprovada.
 * Os aprovados executam sequencialmente na sessão de B; o placar e o motivo da
 * exceção têm de ficar registrados.
 */
import { EXEMPLO_PF } from "@cadastro-lote/shared";
import {
  API,
  aguardar,
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
const registra = (id, esperado, obtido, ok, extra = {}) => {
  passos.push({ id, esperado, obtido, resultado: ok ? "PASSOU" : "FALHOU", ...extra });
  log(`${ok ? "PASSOU" : "FALHOU"}  ${id} — ${obtido}`);
  return ok;
};

/* CSV do lote: 3 tomadores TESTE-SOD-L1a/b/c ------------------------- */
const COLUNAS = Object.keys(EXEMPLO_PF);
const csvCampo = (v) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const itens = ["L1a", "L1b", "L1c"].map((id, i) => ({
  id,
  cpf: cpfSintetico(900810010 + i),
  nome: `TESTE-SOD-${id} GERALDO L B ARAGAO`,
}));
const linhas = itens.map((it) => ({
  ...EXEMPLO_PF,
  dsNome: it.nome,
  nrCpfCnpj: it.cpf,
  dsEmail: `teste.sod.${it.id.toLowerCase()}@opea.com.br`,
}));
const csv = [
  COLUNAS.map(csvCampo).join(","),
  ...linhas.map((l) => COLUNAS.map((c) => csvCampo(l[c] ?? "")).join(",")),
].join("\r\n");

const CONTROL = { finalizar: false, idIntegracaoCadastro: "S" };

/* 6.1 — criar lote --------------------------------------------------- */
const r61 = await upload("A", "/api/import", "TESTE-SOD-lote-tomadores.csv", csv, CONTROL);
const loteId = r61.json?.requisicao?.id ?? null;
registra(
  "6.1 upload válido vira requisição-lote (A)",
  "201 aprovacao:true, lote pendente com 3 itens, zero Sinqia",
  `HTTP ${r61.status} aprovacao=${r61.json?.aprovacao} itens=${r61.json?.requisicao?.totalItens}`,
  r61.status === 201 && r61.json?.requisicao?.totalItens === 3,
  { requisicaoId: loteId, resposta: r61.json },
);
if (!loteId) {
  log(`ABORTANDO US-06 — resposta: ${JSON.stringify(r61.json ?? r61.texto).slice(0, 800)}`);
  evidencia("40-us06-lote-tomadores", { quando: agora(), passos });
  process.exit(1);
}

const detalhe = async (perfil) => get(perfil, `/api/sod/requisicoes/${loteId}`);
const dep61 = await detalhe("B");
const itensLote = dep61.json?.itens ?? [];

/* 6.2 — violação de SoD no lote -------------------------------------- */
const r62 = await post("A", `/api/sod/requisicoes/${loteId}/decisao`, { decisao: "aprovar" });
registra(
  "6.2 violação de SoD no lote (A decide o que A criou)",
  "403 VIOLACAO_SOD, lote intacto",
  `HTTP ${r62.status} code=${r62.json?.code}`,
  r62.status === 403 && r62.json?.code === "VIOLACAO_SOD",
  { resposta: r62.json },
);

/* 6.2b — exceção sem motivo é rejeitada ------------------------------ */
const alvoExcecao = itensLote.find((i) => String(i.resumo?.nome ?? "").includes("L1b"));
const r62b = await post("B", `/api/sod/requisicoes/${loteId}/decisao`, {
  decisao: "aprovar",
  excecoes: [{ itemId: alvoExcecao?.id, motivo: "" }],
});
registra(
  "6.2b exceção sem motivo é rejeitada (RN02/RN03)",
  "400 com mensagem de motivo obrigatório; nada decidido",
  `HTTP ${r62b.status} erro=${JSON.stringify(r62b.json?.error ?? null)}`,
  r62b.status === 400,
  { resposta: r62b.json },
);

/* 6.3 — decisão bidirecional: aprovar exceto L1b --------------------- */
const MOTIVO_EXC = "TESTE-SOD: exceção de homologação — renda não comprovada (US-06).";
const r63 = await post("B", `/api/sod/requisicoes/${loteId}/decisao`, {
  decisao: "aprovar",
  excecoes: [{ itemId: alvoExcecao.id, motivo: MOTIVO_EXC }],
});
registra(
  "6.3 decisão bidirecional aprovar-exceto-1 (B)",
  "200 com placar; 2 itens aprovados para execução, 1 reprovado",
  `HTTP ${r63.status} aprovados=${r63.json?.execucao?.aprovados} placar=${JSON.stringify(r63.json?.placar)}`,
  r63.status === 200 && r63.json?.execucao?.aprovados === 2,
  { resposta: r63.json },
);

/* 6.4 — execução sequencial + placar --------------------------------- */
const final = await aguardar(
  async () => {
    const d = await detalhe("B");
    const st2 = d.json?.requisicao?.estado;
    return st2 && st2 !== "aprovada/executando" ? d : null;
  },
  { timeoutMs: 120_000, intervaloMs: 2000 },
);
const dFinal = final ?? (await detalhe("B"));
const itensFinais = dFinal.json?.itens ?? [];
const placar = dFinal.json?.placar ?? null;
const executados = itensFinais.filter((i) => i.estado === "executada");
const reprovados = itensFinais.filter((i) => i.estado === "reprovada");
registra(
  "6.4 execução sequencial, placar e item reprovado com motivo",
  "2 itens executada, 1 reprovada com o motivo da exceção",
  `estadoLote=${dFinal.json?.requisicao?.estado} executados=${executados.length} reprovados=${reprovados.length} ` +
    `motivoExcecao=${JSON.stringify(reprovados[0]?.motivo ?? null)}`,
  executados.length === 2 && reprovados.length === 1 && !!reprovados[0]?.motivo,
  {
    estadoLote: dFinal.json?.requisicao?.estado,
    placar,
    itens: itensFinais,
    duracaoMediaItemMs: dFinal.json?.requisicao?.resultado?.duracaoMediaItemMs ?? null,
  },
);

/* 6.5 — duplicidade recíproca lote → individual ---------------------- */
const cpfExecutado = executados[0]?.documento ?? null;
const jaExecutado = { ...EXEMPLO_PF, dsNome: "TESTE-SOD-DUP GERALDO", nrCpfCnpj: cpfExecutado ?? "" };
const r65 = cpfExecutado
  ? await post("A", "/api/cadastrar", { campos: jaExecutado, control: CONTROL })
  : { status: 0, json: null };
// Item de lote já EXECUTADO não bloqueia mais (só pendente/executando bloqueiam),
// então o esperado aqui é a criação passar — o bloqueio recíproco é testado com o
// lote AINDA pendente, no cenário 6.5b abaixo.
const req65 = r65.json?.requisicao?.id ?? null;
if (req65) await post("A", `/api/sod/requisicoes/${req65}/decisao`, { decisao: "cancelar" });

/* 6.5b — bloqueio recíproco com lote PENDENTE ------------------------ */
const csv2 = [
  COLUNAS.map(csvCampo).join(","),
  COLUNAS.map((c) =>
    csvCampo(
      { ...EXEMPLO_PF, dsNome: "TESTE-SOD-L2a GERALDO", nrCpfCnpj: cpfSintetico(900810020) }[c] ?? "",
    ),
  ).join(","),
].join("\r\n");
const r65bLote = await upload("A", "/api/import", "TESTE-SOD-lote2.csv", csv2, CONTROL);
const lote2 = r65bLote.json?.requisicao?.id ?? null;
const r65bInd = await post("A", "/api/cadastrar", {
  campos: { ...EXEMPLO_PF, dsNome: "TESTE-SOD-L2a-DUP GERALDO", nrCpfCnpj: cpfSintetico(900810020) },
  control: CONTROL,
});
registra(
  "6.5 duplicidade tridimensional: item de lote pendente bloqueia a individual (RN06)",
  "409 DUPLICIDADE_PENDENTE na individual enquanto o item do lote está pendente",
  `loteCriado=${r65bLote.status} individual=${r65bInd.status} code=${r65bInd.json?.code}`,
  r65bLote.status === 201 && r65bInd.status === 409 && r65bInd.json?.code === "DUPLICIDADE_PENDENTE",
  {
    respostaIndividual: r65bInd.json,
    observacaoItemExecutado: {
      cpf: cpfExecutado,
      httpIndividualAposExecucao: r65.status,
      nota: "Item já EXECUTADO não bloqueia nova requisição (só pendente/executando) — comportamento esperado.",
    },
  },
);
// Limpeza: o lote auxiliar é cancelado pelo criador.
if (lote2) {
  const c = await post("A", `/api/sod/requisicoes/${lote2}/decisao`, { decisao: "cancelar" });
  log(`  limpeza: lote auxiliar ${lote2} cancelado (HTTP ${c.status})`);
}

st.tomadores = {
  ...(st.tomadores ?? {}),
  ...Object.fromEntries(
    itens.map((it) => {
      const item = itensFinais.find((i) => i.documento === it.cpf);
      return [
        it.id,
        { cpf: it.cpf, nome: it.nome, origem: "US-06 lote", estado: item?.estado ?? "?" },
      ];
    }),
  ),
};
st.requisicoes = { ...(st.requisicoes ?? {}), "US-06": { lote: loteId, loteAuxiliar: lote2 } };
salvarEstado(st);

log(`\nevidência: ${evidencia("40-us06-lote-tomadores", { quando: agora(), passos })}`);
log(`resultado: ${passos.filter((p) => p.resultado === "PASSOU").length}/${passos.length} cenários PASSOU`);
