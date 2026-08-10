/**
 * @homolog — US-04, cenário 4.5 refeito: a proposta criada pela execução tem de
 * aparecer no painel. (A primeira tentativa leu a chave errada do resultado: o
 * número da proposta vive em `resultado.nrProsp`.)
 */
import { estado, evidencia, get, log, login, post, salvarEstado, agora } from "./lib.mjs";

await login("A");
const st = estado();
const reqs = st.requisicoes?.["US-04"] ?? {};
const passos = [];

async function nrPropostaDe(requisicaoId) {
  if (!requisicaoId) return null;
  const d = await get("A", `/api/sod/requisicoes/${requisicaoId}`);
  const r = d.json?.requisicao?.resultado ?? {};
  return { nrProsp: r.nrProsp ? Number(r.nrProsp) : null, nrClient: r.nrClient ?? null, estado: d.json?.requisicao?.estado };
}

const p01 = await nrPropostaDe(reqs.proposta);
const painel = p01?.nrProsp
  ? await post("A", "/api/propostas/painel", { filtros: { nrPropos: String(p01.nrProsp) }, size: 5 })
  : null;
const linha = painel?.json?.propostas?.[0] ?? null;
const ok = !!linha && Number(linha.nrProsp) === p01?.nrProsp;
passos.push({
  id: "4.5 proposta aparece no painel",
  esperado: "proposta encontrada, etapa 20050 Contrato em Assinatura",
  obtido: `nrProsp=${p01?.nrProsp ?? "-"} etapa=${linha?.nrStatus ?? "-"} ${linha?.dsStatus ?? ""}`,
  resultado: ok ? "PASSOU" : "FALHOU",
  linhaPainel: linha,
});
log(`${ok ? "PASSOU" : "FALHOU"}  4.5 — proposta ${p01?.nrProsp} etapa ${linha?.nrStatus} ${linha?.dsStatus ?? ""}`);

// Histórico da proposta (etapa vigente) — base de comparação para a US-08.
const hist = p01?.nrProsp ? await get("A", `/api/propostas-historico/${p01.nrProsp}`) : null;
passos.push({
  id: "4.5b histórico da proposta (linha do tempo)",
  obtido: `HTTP ${hist?.status} — ${(hist?.json?.historicos ?? []).length} registro(s)`,
  historicos: hist?.json?.historicos ?? null,
  resultado: hist?.status === 200 ? "PASSOU" : "FALHOU",
});
log(`histórico da proposta ${p01?.nrProsp}: ${JSON.stringify(hist?.json?.historicos ?? [])}`);

st.propostas = {
  ...(st.propostas ?? {}),
  ...(p01?.nrProsp
    ? {
        P01: {
          nrProsp: p01.nrProsp,
          cpf: st.tomadores?.T01?.cpf ?? null,
          nome: st.tomadores?.T01?.nome ?? null,
          requisicao: reqs.proposta,
          nrStatus: linha?.nrStatus ?? null,
          cdProd: linha?.cdProd ?? null,
          nrContra: linha?.nrContra ?? null,
          nmClient: linha?.nmClient ?? null,
          nrCpfCnpj: linha?.nrCpfCnpj ?? null,
        },
      }
    : {}),
};
st.tomadores = {
  ...(st.tomadores ?? {}),
  ...(st.tomadores?.T01 ? { T01: { ...st.tomadores.T01, nrClient: p01?.nrClient ?? null } } : {}),
};
salvarEstado(st);

log(`evidência: ${evidencia("21-us04-painel", { quando: agora(), passos })}`);
