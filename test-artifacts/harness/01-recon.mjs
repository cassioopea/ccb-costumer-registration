/**
 * @homolog — Reconhecimento (somente LEITURA) para instanciar o plano.
 *
 * Nada é criado nem movido aqui: só consultas (campos obrigatórios, lookups de
 * produto/convênio/filial, filas do workflow e propostas por fila).
 */
import { get, login, evidencia, agora, log } from "./lib.mjs";

await login("A");

const resumo = { quando: agora() };

/* 1. Campos obrigatórios do cadastro de tomador ------------------------ */
const campos = await get("A", "/api/campos-obrigatorios");
resumo.camposObrigatorios = {
  status: campos.status,
  httpStatus: campos.json?.httpStatus ?? null,
  formato: campos.json?.formato ?? null,
  paths: campos.json?.paths ?? [],
};
log(`campos-obrigatorios: HTTP ${campos.status} — paths: ${JSON.stringify(resumo.camposObrigatorios.paths)}`);

/* 2. Lookups de proposta ---------------------------------------------- */
const lookups = await get("A", "/api/propostas/lookups");
const lk = lookups.json ?? {};
resumo.lookups = {
  status: lookups.status,
  convenios: (lk.convenios ?? []).slice(0, 12),
  totalConvenios: (lk.convenios ?? []).length,
  produtos: (lk.produtos ?? []).slice(0, 12),
  totalProdutos: (lk.produtos ?? []).length,
  filiais: (lk.filiais ?? []).slice(0, 12),
  totalFiliais: (lk.filiais ?? []).length,
  chaves: Object.keys(lk),
};
log(
  `lookups: HTTP ${lookups.status} — chaves ${JSON.stringify(resumo.lookups.chaves)} ` +
    `(convênios ${resumo.lookups.totalConvenios}, produtos ${resumo.lookups.totalProdutos}, filiais ${resumo.lookups.totalFiliais})`,
);

/* 3. Filas do workflow ------------------------------------------------ */
const filas = await get("A", "/api/propostas/filas");
resumo.filas = { status: filas.status, filas: filas.json?.filas ?? [] };
log(`filas: HTTP ${filas.status} — ${JSON.stringify(resumo.filas.filas)}`);

/* 4. Propostas por fila (as duas filas com mais itens) ---------------- */
resumo.painel = [];
const comItens = (resumo.filas.filas ?? [])
  .filter((f) => Number(f.qtde ?? f.quantidade ?? 0) > 0)
  .slice(0, 3);
for (const f of comItens) {
  const nrStatus = f.nrStatus ?? f.status ?? null;
  const nrWf = f.nrWf ?? null;
  const r = await get(
    "A",
    `/api/propostas/visao-geral?nrStatus=${nrStatus}&limite=5`,
  );
  const linhas = r.json?.propostas ?? r.json?.itens ?? [];
  resumo.painel.push({
    fila: { nrWf, nrStatus, dsStatus: f.dsStatus ?? f.descricao ?? null, qtde: f.qtde ?? null },
    status: r.status,
    chaves: r.json ? Object.keys(r.json) : [],
    amostra: linhas.slice(0, 5),
  });
  log(`visão-geral fila ${nrStatus}: HTTP ${r.status} — ${linhas.length} linha(s) na amostra`);
}

log(`evidência: ${evidencia("01-recon", resumo)}`);
