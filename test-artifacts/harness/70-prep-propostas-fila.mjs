/**
 * @homolog — Preparação da US-09: 3 propostas novas na MESMA fila (20050).
 *
 * As propostas das US-04/07 já foram movidas/canceladas nas variantes da US-08,
 * então a movimentação em massa precisa de um conjunto novo e homogêneo. Usa
 * tomadores JÁ cadastrados (T02, T05, C1) pelo caminho individual (A cria,
 * B aprova) — sem conferência de planilha, mais curto que o lote.
 */
import { estado, evidencia, get, log, login, post, salvarEstado, agora } from "./lib.mjs";

await login("A");
await login("B");

const st = estado();
const alvos = ["T02", "T05", "C1"]
  .map((id) => ({ id, ...(st.tomadores?.[id] ?? {}) }))
  .filter((t) => t.cpf);
if (alvos.length < 3) throw new Error(`Tomadores insuficientes no estado: ${JSON.stringify(alvos)}`);

const DADOS = { vlLiquido: 8000, qtParcelas: 6, dtVct1Ap: 20260910, vlTac: 0, vlSeguro: 0, vlOutros: 0 };
const PARAMS_CALC = { txJuros: 12, cdProd: 1015, idCarCtr: 31, dtContra: 20260810 };
const PARAMS_CRIAR = { ...PARAMS_CALC, cdConven: "111" };

const criadas = [];
for (const t of alvos) {
  const calc = await post("A", "/api/propostas/calcular-uma", {
    cpf: t.cpf,
    nome: t.nome,
    dados: DADOS,
    params: PARAMS_CALC,
  });
  if (!calc.json?.calcId) {
    log(`  ${t.id}: cálculo falhou — ${JSON.stringify(calc.json).slice(0, 200)}`);
    continue;
  }
  const req = await post("A", "/api/propostas/criar-uma", {
    calcId: calc.json.calcId,
    params: PARAMS_CRIAR,
    forcarDuplicada: false,
  });
  const id = req.json?.requisicao?.id ?? null;
  if (!id) {
    log(`  ${t.id}: requisição não criada — HTTP ${req.status} ${JSON.stringify(req.json).slice(0, 200)}`);
    continue;
  }
  await post("B", `/api/sod/requisicoes/${id}/decisao`, { decisao: "aprovar" });
  const dep = await get("B", `/api/sod/requisicoes/${id}`);
  const r = dep.json?.requisicao?.resultado ?? {};
  const nrProsp = r.nrProsp ? Number(r.nrProsp) : null;
  log(
    `  ${t.id}: requisição ${id} → ${dep.json?.requisicao?.estado}` +
      (nrProsp ? ` proposta ${nrProsp}` : ` causa=${r.causa ?? "-"}`),
  );
  if (nrProsp) criadas.push({ id: t.id, cpf: t.cpf, nome: t.nome, nrProsp, requisicao: id });
}

// Confirma a fila de cada uma (todas devem estar em 20050).
const detalhes = [];
for (const c of criadas) {
  const p = await post("A", "/api/propostas/painel", { filtros: { nrPropos: String(c.nrProsp) }, size: 5 });
  const linha = p.json?.propostas?.[0] ?? null;
  detalhes.push({ ...c, linha });
  log(`  proposta ${c.nrProsp}: etapa ${linha?.nrStatus} ${linha?.dsStatus ?? ""}`);
}

st.propostasFila = detalhes.map((d) => ({
  nrProsp: d.nrProsp,
  cpf: d.cpf,
  requisicao: d.requisicao,
  nrWf: d.linha?.nrWf ?? null,
  nrStatus: d.linha?.nrStatus ?? null,
  dsStatus: d.linha?.dsStatus ?? null,
  nrCpfCnpj: d.linha?.nrCpfCnpj ?? null,
  nmClient: d.linha?.nmClient ?? null,
  cdProd: d.linha?.cdProd ?? null,
  nrContra: d.linha?.nrContra ?? null,
}));
salvarEstado(st);

log(`\npropostas prontas na fila: ${st.propostasFila.map((p) => `${p.nrProsp}@${p.nrStatus}`).join(", ")}`);
log(`evidência: ${evidencia("70-prep-propostas-fila", { quando: agora(), propostas: st.propostasFila })}`);
