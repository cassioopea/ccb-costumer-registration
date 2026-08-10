/**
 * @homolog — US-08: movimentação individual de proposta (BUG REPORTADO).
 *
 * Evidência completa: payload da requisição, estado antes/depois, resposta do
 * BFF, histórico da proposta na Sinqia antes e depois (prova se houve ou não
 * chamada efetiva) e trilha de auditoria.
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

const nrProsp = st.propostas?.P01?.nrProsp;
if (!nrProsp) throw new Error("Sem proposta P01 no estado — rode as US-04 antes.");

/* Dados reais da proposta no painel ---------------------------------- */
const painel = await post("A", "/api/propostas/painel", {
  filtros: { nrPropos: String(nrProsp) },
  size: 5,
});
const linha = painel.json?.propostas?.[0] ?? null;
if (!linha) throw new Error(`Proposta ${nrProsp} não encontrada no painel.`);

const transicoes = await get("A", `/api/propostas-transicoes?nrWf=${linha.nrWf}&nrStatus=${linha.nrStatus}`);
const destino = (transicoes.json?.transicoes ?? []).find((t) => t.proxStatus === 20051);
if (!destino) throw new Error("Transição 20050→20051 não disponível.");

const corpoTransferencia = {
  nrProsp: linha.nrProsp,
  nrWf: linha.nrWf,
  nrStatusAtual: linha.nrStatus,
  dsStatusAtual: linha.dsStatus,
  proxStatus: destino.proxStatus,
  dsObserv: "TESTE-SOD-US08 movimentacao de homologacao",
  nrCpf: linha.nrCpfCnpj,
  nmCliente: linha.nmClient,
  cdProd: linha.cdProd,
  nrContra: linha.nrContra ?? null,
};

const histAntes = await get("A", `/api/propostas-historico/${nrProsp}`);

/* 8.1 — criar requisição de movimentação ----------------------------- */
const r81 = await post("A", "/api/propostas-transferir", corpoTransferencia);
const reqMov = r81.json?.requisicao?.id ?? null;
registra(
  "8.1 movimentação vira requisição pendente (A)",
  "201 aprovacao:true, pendente, zero transfStatus na Sinqia",
  `HTTP ${r81.status} aprovacao=${r81.json?.aprovacao} estado=${r81.json?.requisicao?.estado} destino=${r81.json?.destino?.dsStatus}`,
  r81.status === 201 && r81.json?.requisicao?.estado === "pendente",
  { requisicaoId: reqMov, corpoEnviado: corpoTransferencia, resposta: r81.json },
);
if (!reqMov) {
  log(`ABORTANDO US-08 — resposta: ${JSON.stringify(r81.json).slice(0, 800)}`);
  evidencia("60-us08-movimentacao", { quando: agora(), passos });
  process.exit(1);
}

const detalhe = (perfil) => get(perfil, `/api/sod/requisicoes/${reqMov}`);
const depAntes = await detalhe("B");

/* 8.2 — indicador agregado do painel --------------------------------- */
const r82 = await get("A", "/api/sod/movimentacoes-ativas");
const ativa = (r82.json?.movimentacoes ?? []).find((m) => m.nrProsp === Number(nrProsp));
registra(
  "8.2 indicador do painel (endpoint agregado)",
  "a proposta aparece como movimentação ativa com origem→destino",
  `HTTP ${r82.status} ativas=${(r82.json?.movimentacoes ?? []).length} estado=${ativa?.estado} ` +
    `origem=${ativa?.origem?.nrStatus}→destino=${ativa?.destino?.proxStatus}`,
  r82.status === 200 && !!ativa && ativa.estado === "pendente",
  { movimentacaoAtiva: ativa, total: (r82.json?.movimentacoes ?? []).length },
);

/* 8.3 — bloqueio de segunda requisição (RN03) ------------------------ */
const r83 = await post("A", "/api/propostas-transferir", corpoTransferencia);
registra(
  "8.3 bloqueio de segunda requisição por proposta (RN03)",
  "409 MOVIMENTACAO_BLOQUEADA com requisicaoExistente",
  `HTTP ${r83.status} code=${r83.json?.code} existente=${r83.json?.requisicaoExistente?.id ?? "-"}`,
  r83.status === 409 && r83.json?.code === "MOVIMENTACAO_BLOQUEADA",
  { resposta: r83.json },
);

/* 8.4 — violação de SoD ---------------------------------------------- */
const r84 = await post("A", `/api/sod/requisicoes/${reqMov}/decisao`, { decisao: "aprovar" });
registra(
  "8.4 violação de SoD na movimentação",
  "403 VIOLACAO_SOD",
  `HTTP ${r84.status} code=${r84.json?.code}`,
  r84.status === 403 && r84.json?.code === "VIOLACAO_SOD",
  { resposta: r84.json },
);

/* 8.5 — APROVAÇÃO por B: a execução deve mover na Sinqia -------------- */
const t0 = Date.now();
const r85 = await post("B", `/api/sod/requisicoes/${reqMov}/decisao`, { decisao: "aprovar" });
const ms85 = Date.now() - t0;
const depDepois = await detalhe("B");
const histDepois = await get("A", `/api/propostas-historico/${nrProsp}`);
const painelDepois = await post("A", "/api/propostas/painel", {
  filtros: { nrPropos: String(nrProsp) },
  size: 5,
});
const linhaDepois = painelDepois.json?.propostas?.[0] ?? null;
const estadoFinal = depDepois.json?.requisicao?.estado;
const resultado = depDepois.json?.requisicao?.resultado ?? null;

registra(
  "8.5 aprovação por B executa a movimentação na Sinqia",
  "executada; transfStatus confirmado pela Sinqia",
  `HTTP ${r85.status} estado=${estadoFinal} causa=${resultado?.causa ?? "-"} ` +
    `etapa=${resultado?.etapa ?? "-"} (${ms85} ms)`,
  r85.status === 200 && estadoFinal === "executada",
  {
    respostaBff: r85.json,
    payloadPersistido: depAntes.json?.requisicao?.payload ?? null,
    estadoAntes: depAntes.json?.requisicao?.estado,
    estadoDepois: estadoFinal,
    resultadoIntegral: resultado,
    historicoAuditoria: depDepois.json?.historico ?? null,
    duracaoMs: ms85,
  },
);

/* 8.6 — etapa refletida no painel e no histórico --------------------- */
const statusDepois = linhaDepois?.nrStatus ?? null;
const seqAntes = (histAntes.json?.historicos ?? []).length;
const seqDepois = (histDepois.json?.historicos ?? []).length;
registra(
  "8.6 etapa refletida na Sinqia (painel e histórico)",
  "proposta em 20051 Contrato Assinado, com novo registro no histórico",
  `painel=${statusDepois} registrosHistorico=${seqAntes}→${seqDepois}`,
  statusDepois === 20051 && seqDepois > seqAntes,
  {
    historicoAntes: histAntes.json?.historicos ?? null,
    historicoDepois: histDepois.json?.historicos ?? null,
    linhaPainelDepois: linhaDepois,
  },
);

/* 8.7 — indicador após a decisão ------------------------------------- */
const r87 = await get("A", "/api/sod/movimentacoes-ativas");
const ativaDepois = (r87.json?.movimentacoes ?? []).find((m) => m.nrProsp === Number(nrProsp));
registra(
  "8.7 indicador do painel após a decisão",
  "executada sai da lista de ativas; falha PERMANECE (bloqueio mantido)",
  `ativa=${ativaDepois ? `${ativaDepois.estado} (bloqueio mantido)` : "não (liberada)"}`,
  estadoFinal === "executada" ? !ativaDepois : !!ativaDepois,
  { movimentacaoAtiva: ativaDepois ?? null },
);

st.requisicoes = { ...(st.requisicoes ?? {}), "US-08": { movimentacao: reqMov, nrProsp } };
st.propostas = {
  ...(st.propostas ?? {}),
  P01: { ...(st.propostas?.P01 ?? {}), nrStatusDepoisUS08: statusDepois, requisicaoMov: reqMov },
};
salvarEstado(st);

log(`\nevidência: ${evidencia("60-us08-movimentacao", { quando: agora(), passos })}`);
log(`resultado: ${passos.filter((p) => p.resultado === "PASSOU").length}/${passos.length} cenários PASSOU`);
