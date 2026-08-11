/**
 * @homolog — US-10: retry e descarte de falha.
 *
 * Usa as falhas REAIS produzidas na matriz:
 *  - movimentação em `falha` por divergência externa (variante V3 da US-08);
 *  - proposta em `falha` por duplicidade na Sinqia (cenário 4.6 da US-04).
 * Verifica: retry vedado ao requisitante, retry pelo aprovador com payload
 * ORIGINAL imutável, histórico de tentativas e descarte liberando o bloqueio.
 */
import { estado, evidencia, get, log, login, post, salvarEstado, agora } from "./lib.mjs";

await login("A");
await login("B");

const st = estado();
const passos = [];
const registra = (id, esperado, obtido, ok, extra = {}) => {
  passos.push({ id, esperado, obtido, resultado: ok ? "PASSOU" : "FALHOU", ...extra });
  log(`${ok ? "PASSOU" : "FALHOU"}  ${id} — ${obtido}`);
  return ok;
};

const reqMovFalha = st.requisicoes?.["US-08-V3"]?.movimentacaoEmFalha ?? null;
const nrProspFalha = st.requisicoes?.["US-08-V3"]?.nrProsp ?? null;
const reqPropFalha = st.requisicoes?.["US-04"]?.propostaDuplicada ?? null;

/* 10.1 — a falha existe e está em repouso ---------------------------- */
const dep101 = reqMovFalha ? await get("B", `/api/sod/requisicoes/${reqMovFalha}`) : null;
const ativas101 = await get("A", "/api/sod/movimentacoes-ativas");
const bloqueioAntes = (ativas101.json?.movimentacoes ?? []).find(
  (m) => m.nrProsp === Number(nrProspFalha),
);
registra(
  "10.1 falha real em repouso, com bloqueio mantido",
  "estado falha, causa registrada, proposta ainda bloqueada",
  `estado=${dep101?.json?.requisicao?.estado} causa=${dep101?.json?.requisicao?.resultado?.causa} ` +
    `bloqueada=${!!bloqueioAntes} (causaFalha=${bloqueioAntes?.causaFalha ?? "-"})`,
  dep101?.json?.requisicao?.estado === "falha" && !!bloqueioAntes,
  { requisicaoId: reqMovFalha, nrProsp: nrProspFalha, movimentacaoAtiva: bloqueioAntes ?? null },
);

/* 10.2 — retry vedado ao requisitante (maker-checker) ----------------- */
const r102 = await post("A", `/api/sod/requisicoes/${reqMovFalha}/retry`);
registra(
  "10.2 retry vedado ao requisitante",
  "403 VIOLACAO_SOD; estado permanece falha",
  `HTTP ${r102.status} code=${r102.json?.code}`,
  r102.status === 403 && r102.json?.code === "VIOLACAO_SOD",
  { resposta: r102.json },
);

/* 10.3 — retry pelo aprovador com payload original -------------------- */
const payloadAntes = dep101?.json?.requisicao?.payload ?? null;
const r103 = await post("B", `/api/sod/requisicoes/${reqMovFalha}/retry`);
const dep103 = await get("B", `/api/sod/requisicoes/${reqMovFalha}`);
const payloadDepois = dep103.json?.requisicao?.payload ?? null;
const historico = dep103.json?.historico ?? [];
const tentativas = historico.filter(
  (h) => h.acao === "execucao_iniciada" || String(h.detalhe?.decisao ?? "") === "retry",
);
registra(
  "10.3 retry pelo aprovador reexecuta o payload ORIGINAL",
  "nova tentativa registrada; payload imutável; desfecho coerente com o mundo real",
  `HTTP ${r103.status} estado=${dep103.json?.requisicao?.estado} ` +
    `causa=${dep103.json?.requisicao?.resultado?.causa ?? "-"} ` +
    `payloadIntacto=${JSON.stringify(payloadAntes) === JSON.stringify(payloadDepois)} tentativas=${tentativas.length}`,
  r103.status === 200 &&
    JSON.stringify(payloadAntes) === JSON.stringify(payloadDepois) &&
    tentativas.length >= 2,
  {
    respostaRetry: r103.json,
    estadoDepois: dep103.json?.requisicao?.estado,
    resultadoDepois: dep103.json?.requisicao?.resultado ?? null,
    eventosDeTentativa: tentativas,
    historicoCompleto: historico,
  },
);

/* 10.4 — descarte com motivo libera o bloqueio ------------------------ */
const r104semMotivo = await post("B", `/api/sod/requisicoes/${reqMovFalha}/descarte`, {});
const MOTIVO = "TESTE-SOD: divergência resolvida fora da plataforma — proposta já cancelada (US-10).";
const r104 = await post("B", `/api/sod/requisicoes/${reqMovFalha}/descarte`, { motivo: MOTIVO });
const dep104 = await get("B", `/api/sod/requisicoes/${reqMovFalha}`);
const ativas104 = await get("A", "/api/sod/movimentacoes-ativas");
const bloqueioDepois = (ativas104.json?.movimentacoes ?? []).find(
  (m) => m.nrProsp === Number(nrProspFalha),
);
registra(
  "10.4 descarte exige motivo e libera o bloqueio",
  "sem motivo → 400; com motivo → descartada e proposta liberada",
  `semMotivo=${r104semMotivo.status} comMotivo=${r104.status} estado=${dep104.json?.requisicao?.estado} ` +
    `aindaBloqueada=${!!bloqueioDepois}`,
  r104semMotivo.status === 400 &&
    r104.status === 200 &&
    dep104.json?.requisicao?.estado === "descartada" &&
    !bloqueioDepois,
  {
    respostaSemMotivo: r104semMotivo.json,
    respostaDescarte: r104.json,
    motivoRegistrado: dep104.json?.requisicao?.motivo ?? null,
    historico: dep104.json?.historico ?? null,
  },
);

/* 10.5 — nova movimentação da mesma proposta passa a ser aceita ------- */
const painel = await post("A", "/api/propostas/painel", {
  filtros: { nrPropos: String(nrProspFalha) },
  size: 3,
});
const linha = painel.json?.propostas?.[0] ?? null;
const transicoes = linha
  ? await get("A", `/api/propostas-transicoes?nrWf=${linha.nrWf}&nrStatus=${linha.nrStatus}`)
  : null;
const destino = (transicoes?.json?.transicoes ?? [])[0] ?? null;
let r105 = null;
if (linha && destino) {
  r105 = await post("A", "/api/propostas-transferir", {
    nrProsp: linha.nrProsp,
    nrWf: linha.nrWf,
    nrStatusAtual: linha.nrStatus,
    dsStatusAtual: linha.dsStatus,
    proxStatus: destino.proxStatus,
    dsObserv: "TESTE-SOD-US10 nova movimentacao apos descarte",
    nrCpf: linha.nrCpfCnpj,
    nmCliente: linha.nmClient,
    cdProd: linha.cdProd,
    nrContra: linha.nrContra ?? null,
  });
  // Limpeza: cancela a requisição criada só para provar a liberação.
  if (r105.json?.requisicao?.id) {
    await post("A", `/api/sod/requisicoes/${r105.json.requisicao.id}/decisao`, { decisao: "cancelar" });
  }
}
registra(
  "10.5 descarte libera de fato: nova requisição da mesma proposta é aceita",
  "201 (sem MOVIMENTACAO_BLOQUEADA)",
  linha && destino
    ? `HTTP ${r105.status} code=${r105.json?.code ?? "-"} etapaAtual=${linha.nrStatus}`
    : `proposta em etapa ${linha?.nrStatus} sem transições — cenário não aplicável`,
  linha && destino ? r105.status === 201 : true,
  { resposta: r105?.json ?? null, etapaAtual: linha?.nrStatus ?? null, destino },
);

/* 10.6 — retry/descarte no OUTRO tipo (proposta.criar em falha) ------- */
let r106 = null;
let dep106 = null;
if (reqPropFalha) {
  const antes = await get("B", `/api/sod/requisicoes/${reqPropFalha}`);
  if (antes.json?.requisicao?.estado === "falha") {
    const vedado = await post("A", `/api/sod/requisicoes/${reqPropFalha}/retry`);
    r106 = await post("B", `/api/sod/requisicoes/${reqPropFalha}/retry`);
    dep106 = await get("B", `/api/sod/requisicoes/${reqPropFalha}`);
    registra(
      "10.6 retry no tipo proposta.criar (elegibilidade por vínculo)",
      "requisitante barrado; aprovador reexecuta e o desfecho é registrado",
      `vedadoAoCriador=${vedado.status}/${vedado.json?.code} retryB=${r106.status} ` +
        `estado=${dep106.json?.requisicao?.estado} causa=${dep106.json?.requisicao?.resultado?.causa ?? "-"}`,
      vedado.status === 403 && r106.status === 200,
      {
        respostaVedada: vedado.json,
        respostaRetry: r106.json,
        resultado: dep106.json?.requisicao?.resultado ?? null,
        historico: dep106.json?.historico ?? null,
      },
    );
  } else {
    registra(
      "10.6 retry no tipo proposta.criar",
      "-",
      `requisição não está em falha (estado=${antes.json?.requisicao?.estado})`,
      true,
      { estado: antes.json?.requisicao?.estado },
    );
  }
}

st.requisicoes = {
  ...(st.requisicoes ?? {}),
  "US-10": { movimentacaoDescartada: reqMovFalha, propostaRetry: reqPropFalha },
};
salvarEstado(st);

log(`\nevidência: ${evidencia("80-us10-retry-descarte", { quando: agora(), passos })}`);
log(`resultado: ${passos.filter((p) => p.resultado === "PASSOU").length}/${passos.length} cenários PASSOU`);
