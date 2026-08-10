/**
 * @homolog — US-09: movimentação em massa (composição lote × movimentação).
 *
 * Ordem: uma movimentação INDIVIDUAL pendente torna a proposta inelegível ao
 * lote (RN04) → lote-subconjunto com confirmação → bloqueio unificado nas duas
 * direções → decisão bidirecional → execução item a item.
 */
import { aguardar, estado, evidencia, get, log, login, post, salvarEstado, agora } from "./lib.mjs";

await login("A");
await login("B");

const st = estado();
const fila = st.propostasFila ?? [];
if (fila.length < 3) throw new Error("Estado sem 3 propostas na fila — rode 70-prep-propostas-fila.mjs.");

const passos = [];
const registra = (id, esperado, obtido, ok, extra = {}) => {
  passos.push({ id, esperado, obtido, resultado: ok ? "PASSOU" : "FALHOU", ...extra });
  log(`${ok ? "PASSOU" : "FALHOU"}  ${id} — ${obtido}`);
  return ok;
};

async function linhaPainel(nrProsp) {
  const r = await post("A", "/api/propostas/painel", { filtros: { nrPropos: String(nrProsp) }, size: 3 });
  return r.json?.propostas?.[0] ?? null;
}

// Estado atual (a etapa pode ter avançado sozinha desde a preparação).
const linhas = [];
for (const p of fila) linhas.push(await linhaPainel(p.nrProsp));
const filaAtual = linhas[0]?.nrStatus ?? null;
const homogeneas = linhas.every((l) => l && l.nrStatus === filaAtual);
log(`propostas: ${linhas.map((l) => `${l?.nrProsp}@${l?.nrStatus}`).join(", ")} (homogêneas=${homogeneas})`);
if (!homogeneas) throw new Error("As propostas não estão na mesma fila — impossível testar o lote homogêneo.");

const transicoes = await get("A", `/api/propostas-transicoes?nrWf=1&nrStatus=${filaAtual}`);
const destino = (transicoes.json?.transicoes ?? [])[0];
if (!destino) throw new Error(`Fila ${filaAtual} sem transições disponíveis.`);
const OBS = "TESTE-SOD-US09 movimentacao em massa de homologacao";

const itemDe = (l) => ({
  nrProsp: l.nrProsp,
  nrCpf: l.nrCpfCnpj,
  nmCliente: l.nmClient,
  cdProd: l.cdProd,
  nrContra: l.nrContra ?? null,
});
const corpoLote = (selecao, extra = {}) => ({
  nrWf: 1,
  nrStatusAtual: filaAtual,
  dsStatusAtual: linhas[0].dsStatus,
  proxStatus: destino.proxStatus,
  dsObserv: OBS,
  itens: selecao.map(itemDe),
  ...extra,
});

/* 9.0 — movimentação individual pendente na primeira proposta ---------- */
const r90 = await post("A", "/api/propostas-transferir", {
  nrProsp: linhas[0].nrProsp,
  nrWf: 1,
  nrStatusAtual: filaAtual,
  dsStatusAtual: linhas[0].dsStatus,
  proxStatus: destino.proxStatus,
  dsObserv: "TESTE-SOD-US09 individual previa",
  nrCpf: linhas[0].nrCpfCnpj,
  nmCliente: linhas[0].nmClient,
  cdProd: linhas[0].cdProd,
  nrContra: linhas[0].nrContra ?? null,
});
const reqIndividual = r90.json?.requisicao?.id ?? null;
registra(
  "9.0 movimentação individual pendente (pré-condição)",
  "201 pendente na proposta 1",
  `HTTP ${r90.status} estado=${r90.json?.requisicao?.estado}`,
  r90.status === 201,
  { requisicaoId: reqIndividual, nrProsp: linhas[0].nrProsp },
);

/* 9.1 — elegibilidade (RN04): seleção com uma bloqueada --------------- */
const r91 = await post("A", "/api/propostas-transferir-lote", corpoLote(linhas));
registra(
  "9.1 elegibilidade RN04: seleção com proposta bloqueada",
  "409 SUBCONJUNTO_NAO_CONFIRMADO com inelegíveis apontadas por motivo; nada criado",
  `HTTP ${r91.status} code=${r91.json?.code} inelegiveis=${(r91.json?.inelegiveis ?? []).length} elegiveis=${r91.json?.elegiveis}`,
  r91.status === 409 && r91.json?.code === "SUBCONJUNTO_NAO_CONFIRMADO",
  { resposta: r91.json },
);

/* 9.2 — lote-subconjunto com confirmação ------------------------------ */
const r92 = await post(
  "A",
  "/api/propostas-transferir-lote",
  corpoLote(linhas, { confirmarSubconjunto: true }),
);
const loteId = r92.json?.requisicao?.id ?? null;
registra(
  "9.2 lote-subconjunto criado com confirmação explícita",
  "201 com 2 itens (a bloqueada fica de fora)",
  `HTTP ${r92.status} itens=${r92.json?.requisicao?.totalItens ?? "-"} removidas=${r92.json?.requisicao?.inelegiveisRemovidas ?? "-"}`,
  r92.status === 201,
  { requisicaoId: loteId, resposta: r92.json },
);
if (!loteId) {
  log(`ABORTANDO US-09 — ${JSON.stringify(r92.json).slice(0, 700)}`);
  evidencia("71-us09-massa", { quando: agora(), passos });
  process.exit(1);
}

const detalhe = (perfil) => get(perfil, `/api/sod/requisicoes/${loteId}`);
const dep92 = await detalhe("B");
const itensLote = dep92.json?.itens ?? [];

/* 9.3 — bloqueio unificado: item de lote bloqueia a individual -------- */
const alvoUnificado = linhas.find((l) => itensLote.some((i) => i.documento === String(l.nrProsp)));
const r93 = await post("A", "/api/propostas-transferir", {
  nrProsp: alvoUnificado.nrProsp,
  nrWf: 1,
  nrStatusAtual: filaAtual,
  dsStatusAtual: alvoUnificado.dsStatus,
  proxStatus: destino.proxStatus,
  dsObserv: "TESTE-SOD-US09 tentativa individual sobre item de lote",
  nrCpf: alvoUnificado.nrCpfCnpj,
  nmCliente: alvoUnificado.nmClient,
  cdProd: alvoUnificado.cdProd,
  nrContra: alvoUnificado.nrContra ?? null,
});
const ativas = await get("A", "/api/sod/movimentacoes-ativas");
registra(
  "9.3 bloqueio unificado lote → individual (fonte única)",
  "409 MOVIMENTACAO_BLOQUEADA na individual; o agregado mostra o item de lote",
  `HTTP ${r93.status} code=${r93.json?.code} ativas=${(ativas.json?.movimentacoes ?? []).length} ` +
    `deLote=${(ativas.json?.movimentacoes ?? []).filter((m) => m.lote).length}`,
  r93.status === 409 && r93.json?.code === "MOVIMENTACAO_BLOQUEADA",
  { resposta: r93.json, movimentacoesAtivas: ativas.json?.movimentacoes ?? null },
);

/* 9.4 — violação de SoD + decisão bidirecional ------------------------ */
const r94sod = await post("A", `/api/sod/requisicoes/${loteId}/decisao`, { decisao: "aprovar" });
const itemExcecao = itensLote[itensLote.length - 1];
const MOTIVO = "TESTE-SOD: exceção de homologação — proposta fora do escopo do movimento (US-09).";
const r94 = await post("B", `/api/sod/requisicoes/${loteId}/decisao`, {
  decisao: "aprovar",
  excecoes: [{ itemId: itemExcecao.id, motivo: MOTIVO }],
});
registra(
  "9.4a violação de SoD no lote de movimentação",
  "403 VIOLACAO_SOD",
  `HTTP ${r94sod.status} code=${r94sod.json?.code}`,
  r94sod.status === 403 && r94sod.json?.code === "VIOLACAO_SOD",
  { resposta: r94sod.json },
);
registra(
  "9.4b decisão bidirecional no lote de movimentação (B)",
  "200; 1 item aprovado para execução, 1 reprovado com motivo",
  `HTTP ${r94.status} aprovados=${r94.json?.execucao?.aprovados} placar=${JSON.stringify(r94.json?.placar)}`,
  r94.status === 200 && r94.json?.execucao?.aprovados === itensLote.length - 1,
  { resposta: r94.json },
);

/* 9.5 — execução item a item ----------------------------------------- */
const fim = await aguardar(
  async () => {
    const d = await detalhe("B");
    const e = d.json?.requisicao?.estado;
    return e && e !== "aprovada/executando" ? d : null;
  },
  { timeoutMs: 180_000, intervaloMs: 2500 },
);
const dFinal = fim ?? (await detalhe("B"));
const itensFinais = dFinal.json?.itens ?? [];
const etapas = [];
for (const i of itensFinais) etapas.push({ nrProsp: i.documento, estado: i.estado, etapa: (await linhaPainel(i.documento))?.nrStatus });
registra(
  "9.5 execução item a item na sessão do aprovador",
  "item aprovado executado e movido na Sinqia; item reprovado permanece na fila de origem",
  `estadoLote=${dFinal.json?.requisicao?.estado} etapas=${JSON.stringify(etapas)}`,
  itensFinais.some((i) => i.estado === "executada") &&
    itensFinais.some((i) => i.estado === "reprovada") &&
    etapas.every((e) =>
      e.estado === "executada" ? e.etapa === destino.proxStatus : e.etapa === filaAtual,
    ),
  {
    estadoLote: dFinal.json?.requisicao?.estado,
    placar: dFinal.json?.placar ?? null,
    itens: itensFinais,
    etapasNaSinqia: etapas,
  },
);

/* 9.6 — a individual pendente coexiste e executa depois --------------- */
const r96 = reqIndividual
  ? await post("B", `/api/sod/requisicoes/${reqIndividual}/decisao`, { decisao: "aprovar" })
  : null;
const dep96 = reqIndividual ? await get("B", `/api/sod/requisicoes/${reqIndividual}`) : null;
const etapa96 = await linhaPainel(linhas[0].nrProsp);
registra(
  "9.6 individual e lote coexistem (bloqueio por proposta, não por fila)",
  "a movimentação individual da outra proposta executa normalmente",
  `estado=${dep96?.json?.requisicao?.estado} etapa=${etapa96?.nrStatus}`,
  dep96?.json?.requisicao?.estado === "executada" && etapa96?.nrStatus === destino.proxStatus,
  { resposta: r96?.json, resultado: dep96?.json?.requisicao?.resultado ?? null },
);

st.requisicoes = {
  ...(st.requisicoes ?? {}),
  "US-09": { lote: loteId, individualPrevia: reqIndividual, itemReprovado: itemExcecao.id },
};
salvarEstado(st);

log(`\nevidência: ${evidencia("71-us09-massa", { quando: agora(), passos })}`);
log(`resultado: ${passos.filter((p) => p.resultado === "PASSOU").length}/${passos.length} cenários PASSOU`);
