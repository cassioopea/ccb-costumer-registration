/**
 * @homolog — Reconhecimento parte 2 (somente LEITURA): propostas por fila e
 * transições permitidas pelo workflow. Insumo do plano das US-08/09.
 */
import { get, post, login, evidencia, agora, log } from "./lib.mjs";

await login("A");

const resumo = { quando: agora(), filas: {}, transicoes: {} };

for (const nrStatus of [20050, 20052, 20016]) {
  const r = await post("A", "/api/propostas/painel", {
    filtros: { nrStatus },
    size: 5,
  });
  const lista = r.json?.propostas ?? r.json?.itens ?? r.json?.linhas ?? [];
  resumo.filas[nrStatus] = {
    status: r.status,
    chaves: r.json ? Object.keys(r.json) : [],
    qtd: Array.isArray(lista) ? lista.length : null,
    amostra: Array.isArray(lista) ? lista.slice(0, 3) : lista,
  };
  log(`painel fila ${nrStatus}: HTTP ${r.status} — ${resumo.filas[nrStatus].qtd} linha(s)`);

  const t = await get("A", `/api/propostas-transicoes?nrWf=1&nrStatus=${nrStatus}`);
  resumo.transicoes[nrStatus] = { status: t.status, transicoes: t.json?.transicoes ?? [] };
  log(`transições de ${nrStatus}: HTTP ${t.status} — ${JSON.stringify(t.json?.transicoes ?? [])}`);
}

log(`evidência: ${evidencia("02-recon-painel", resumo)}`);
