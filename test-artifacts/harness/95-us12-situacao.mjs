/**
 * @homolog — US-12: alteração de situação de tomador (individual e massa).
 *
 * Inativação REAL em homologação (cdSituacao 2 = INATIVO) pelos tomadores de
 * teste. Inclui o cenário do aviso de impacto: inativar um tomador COM proposta
 * em andamento.
 */
import { aguardar, estado, evidencia, get, log, login, post, salvarEstado, agora } from "./lib.mjs";

await login("A");
await login("B");

const st = estado();
const passos = [];
const registra = (id, esperado, obtido, ok, detalhes = {}) => {
  passos.push({ id, esperado, obtido, veredito: ok ? "PASSOU" : "FALHOU", detalhes });
  log(`${ok ? "PASSOU" : "FALHOU"}  ${id} — ${obtido}`);
};

/**
 * nrCliente de cada tomador de teste (NÃO é o CPF). Os números reais de
 * homologação não vão para o repositório: preencha a partir do
 * `test-artifacts/estado.json` local (não versionado) ou da base de tomadores
 * (`POST /api/clientes` devolve `nrCliente` por documento).
 */
const CLIENTES = { T01: null, T02: null, T05: null, L1a: null, L1c: null, C1: null, C3: null };
for (const [id, nr] of Object.entries(CLIENTES)) {
  if (nr === null) {
    log(`ATENÇÃO: nrCliente de ${id} não preenchido — veja o comentário acima.`);
  }
}
const INATIVO = 2;

const alvo = (id, nrCliente) => ({
  nrCliente,
  nome: st.tomadores?.[id]?.nome ?? `TESTE-SOD-${id}`,
  documento: st.tomadores?.[id]?.cpf ?? "",
  situacaoAnterior: "1 — ATIVO",
});
const situacaoAtual = async (documento) => {
  const r = await post("A", "/api/clientes", { tipoPessoa: "F" });
  const c = (r.json?.items ?? []).find((x) => String(x.documento) === String(documento));
  return c ? { cdSituacao: c.cdSituacao, dsSituacao: c.dsSituacao } : null;
};

/* 12.1 — individual: ciclo completo em T05 ---------------------------- */
const antes121 = await situacaoAtual(st.tomadores?.T05?.cpf);
const r121 = await post("A", "/api/situacao", { cdSituacao: INATIVO, alvos: [alvo("T05", CLIENTES.T05)] });
const req121 = r121.json?.requisicao?.id ?? null;
registra(
  "12.1a alteração de situação vira requisição (A)",
  "201 aprovacao:true, pendente, zero chamada à Sinqia",
  `HTTP ${r121.status} aprovacao=${r121.json?.aprovacao} estado=${r121.json?.requisicao?.estado}`,
  r121.status === 201 && r121.json?.requisicao?.estado === "pendente",
  { requisicaoId: req121, situacaoAntes: antes121, resposta: r121.json },
);

/* 12.2 — duplicidade e violação de SoD -------------------------------- */
const r122dup = await post("A", "/api/situacao", { cdSituacao: INATIVO, alvos: [alvo("T05", CLIENTES.T05)] });
const r122sod = await post("A", `/api/sod/requisicoes/${req121}/decisao`, { decisao: "aprovar" });
registra(
  "12.1b duplicidade pendente e violação de SoD",
  "segunda requisição igual → 409; A aprovar a própria → 403",
  `duplicidade=${r122dup.status}/${r122dup.json?.code ?? "-"} sod=${r122sod.status}/${r122sod.json?.code}`,
  r122dup.status === 409 && r122sod.status === 403 && r122sod.json?.code === "VIOLACAO_SOD",
  { respostaDuplicidade: r122dup.json, respostaSod: r122sod.json },
);

/* 12.1c — aprovação por B com execução real --------------------------- */
const r121c = await post("B", `/api/sod/requisicoes/${req121}/decisao`, { decisao: "aprovar" });
const dep121 = await get("B", `/api/sod/requisicoes/${req121}`);
const depois121 = await situacaoAtual(st.tomadores?.T05?.cpf);
registra(
  "12.1c aprovação por B executa a alteração na Sinqia",
  "executada e situação do tomador alterada para INATIVO na plataforma",
  `HTTP ${r121c.status} estado=${dep121.json?.requisicao?.estado} ` +
    `situacao=${antes121?.cdSituacao}→${depois121?.cdSituacao} (${depois121?.dsSituacao})`,
  r121c.status === 200 &&
    dep121.json?.requisicao?.estado === "executada" &&
    depois121?.cdSituacao === INATIVO,
  {
    execucao: r121c.json?.execucao ?? null,
    resultadoIntegral: dep121.json?.requisicao?.resultado ?? null,
    historico: dep121.json?.historico ?? null,
  },
);

/* 12.2 — aviso de impacto: tomador COM proposta em andamento ---------- */
const propostasT01 = await get("A", `/api/clientes/${st.tomadores?.T01?.cpf}/propostas`);
const r122 = await post("A", "/api/situacao", { cdSituacao: INATIVO, alvos: [alvo("T01", CLIENTES.T01)] });
const req122 = r122.json?.requisicao?.id ?? null;
const dep122antes = await get("B", `/api/sod/requisicoes/${req122}`);
// O que o APROVADOR vê ANTES de decidir (payload + qualquer campo de impacto).
const campos122 = dep122antes.json?.requisicao
  ? Object.keys(dep122antes.json.requisicao)
  : [];
const r122ap = await post("B", `/api/sod/requisicoes/${req122}/decisao`, { decisao: "aprovar" });
const dep122 = await get("B", `/api/sod/requisicoes/${req122}`);
const resultado122 = dep122.json?.requisicao?.resultado ?? null;
const depois122 = await situacaoAtual(st.tomadores?.T01?.cpf);
registra(
  "12.2 inativação de tomador COM proposta em andamento (aviso de impacto)",
  "executada, com o impacto (propostas afetadas) registrado no resultado",
  `propostasDoTomador=${(propostasT01.json?.propostas ?? []).length} estado=${dep122.json?.requisicao?.estado} ` +
    `propostasAfetadas=${resultado122?.propostasAfetadas ?? "-"} situacao=${depois122?.cdSituacao}`,
  dep122.json?.requisicao?.estado === "executada" &&
    typeof resultado122?.propostasAfetadas === "number" &&
    resultado122.propostasAfetadas > 0,
  {
    requisicaoId: req122,
    propostasDoTomador: propostasT01.json?.propostas ?? null,
    camposVisiveisAntesDaDecisao: campos122,
    payloadRequisicao: dep122antes.json?.requisicao?.payload ?? null,
    resultadoIntegral: resultado122,
    execucao: r122ap.json?.execucao ?? null,
    observacao:
      "O impacto aparece no RESULTADO (pós-execução). Se o aviso pré-decisão existir, é a UI que o consulta — verificado na fase de UI.",
  },
);

/* 12.3 — massa (2 tomadores) com decisão bidirecional ----------------- */
const r123 = await post("A", "/api/situacao", {
  cdSituacao: INATIVO,
  alvos: [alvo("L1a", CLIENTES.L1a), alvo("L1c", CLIENTES.L1c)],
});
const lote123 = r123.json?.requisicao?.id ?? null;
const dep123 = await get("B", `/api/sod/requisicoes/${lote123}`);
const itens123 = dep123.json?.itens ?? [];
const itemExcecao = itens123.find((i) => String(i.resumo?.nome ?? "").includes("L1c")) ?? itens123[1];
const MOTIVO = "TESTE-SOD: exceção de homologação — manter L1c ativo (US-12).";
const r123dec = await post("B", `/api/sod/requisicoes/${lote123}/decisao`, {
  decisao: "aprovar",
  excecoes: [{ itemId: itemExcecao.id, motivo: MOTIVO }],
});
const fim123 = await aguardar(
  async () => {
    const d = await get("B", `/api/sod/requisicoes/${lote123}`);
    const e = d.json?.requisicao?.estado;
    return e && e !== "aprovada/executando" ? d : null;
  },
  { timeoutMs: 120_000, intervaloMs: 2000 },
);
const dFinal = fim123 ?? (await get("B", `/api/sod/requisicoes/${lote123}`));
const itensFinais = dFinal.json?.itens ?? [];
const sitL1a = await situacaoAtual(st.tomadores?.L1a?.cpf);
const sitL1c = await situacaoAtual(st.tomadores?.L1c?.cpf);
registra(
  "12.3 massa com decisão bidirecional (aprovar exceto 1)",
  "L1a inativado; L1c permanece ATIVO com o motivo da exceção",
  `criacao=${r123.status} itens=${itens123.length} estadoLote=${dFinal.json?.requisicao?.estado} ` +
    `L1a=${sitL1a?.cdSituacao} L1c=${sitL1c?.cdSituacao}`,
  r123.status === 201 &&
    itens123.length === 2 &&
    sitL1a?.cdSituacao === INATIVO &&
    sitL1c?.cdSituacao === 1,
  {
    requisicaoId: lote123,
    respostaDecisao: r123dec.json,
    placar: dFinal.json?.placar ?? null,
    itens: itensFinais,
    situacoes: { L1a: sitL1a, L1c: sitL1c },
  },
);

st.requisicoes = {
  ...(st.requisicoes ?? {}),
  "US-12": { individual: req121, comImpacto: req122, massa: lote123 },
};
st.tomadores = {
  ...(st.tomadores ?? {}),
  T05: { ...(st.tomadores?.T05 ?? {}), situacaoFinal: depois121?.dsSituacao ?? null },
  T01: { ...(st.tomadores?.T01 ?? {}), situacaoFinal: depois122?.dsSituacao ?? null },
  L1a: { ...(st.tomadores?.L1a ?? {}), situacaoFinal: sitL1a?.dsSituacao ?? null },
  L1c: { ...(st.tomadores?.L1c ?? {}), situacaoFinal: sitL1c?.dsSituacao ?? null },
};
salvarEstado(st);

log(`\nevidência: ${evidencia("95-us12-situacao", { quando: agora(), passos })}`);
log(`resultado: ${passos.filter((p) => p.veredito === "PASSOU").length}/${passos.length} cenários PASSOU`);
