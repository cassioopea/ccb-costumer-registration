/**
 * @homolog — US-08, investigação do bug reportado ("a movimentação não executa
 * na aprovação"). O caminho felizzz 20050→20051 executou (script 60). Aqui as
 * variantes realistas:
 *
 *  V1: destino "Cancelado" (20056) — no Portal essa transição usa Ocorrência 11
 *      (incluirOcorrencia) junto do transfStatus; a ferramenta chama só o
 *      transfStatus. Se a Sinqia recusar, é causa raiz candidata.
 *  V2: destino a partir de 20051 (etapa nova da proposta movida no script 60).
 *  V3: DIVERGÊNCIA EXTERNA — a proposta sai da etapa de origem por fora entre a
 *      requisição e a aprovação. Reproduz "aprovei e nada moveu" com a causa
 *      correta e gera a falha real que a US-10 precisa.
 */
import { execSync } from "node:child_process";
import path from "node:path";
import { estado, evidencia, get, log, login, post, salvarEstado, agora } from "./lib.mjs";

/**
 * Ator das mudanças de flag: vai para a trilha de auditoria (o CLI exige --por).
 * NÃO fica fixo no código — é o login de um operador real. Informe em
 * HOMOLOG_FLAG_ATOR ao rodar.
 */
const ATOR_FLAG = process.env.HOMOLOG_FLAG_ATOR ?? '';
if (!ATOR_FLAG) {
  console.error('Defina HOMOLOG_FLAG_ATOR=<login> — o CLI de flags exige o ator para auditar.');
  process.exit(1);
}

const DIR_API = path.resolve(import.meta.dirname, "..", "..", "apps", "api");
const flag = (tipo, valor) =>
  execSync(`npm run --silent sod:flag -- ${tipo} ${valor} --por ${ATOR_FLAG}`, {
    cwd: DIR_API,
    encoding: "utf8",
  }).trim();

await login("A");
await login("B");

const st = estado();
const passos = [];
const registra = (id, esperado, obtido, ok, extra = {}) => {
  passos.push({ id, esperado, obtido, resultado: ok ? "PASSOU" : "FALHOU", ...extra });
  log(`${ok ? "PASSOU" : "FALHOU"}  ${id} — ${obtido}`);
  return ok;
};

async function linhaPainel(nrProsp) {
  const r = await post("A", "/api/propostas/painel", { filtros: { nrPropos: String(nrProsp) }, size: 5 });
  return r.json?.propostas?.[0] ?? null;
}
async function transicoesDe(nrWf, nrStatus) {
  const t = await get("A", `/api/propostas-transicoes?nrWf=${nrWf}&nrStatus=${nrStatus}`);
  return t.json?.transicoes ?? [];
}
function corpo(linha, proxStatus, obs) {
  return {
    nrProsp: linha.nrProsp,
    nrWf: linha.nrWf,
    nrStatusAtual: linha.nrStatus,
    dsStatusAtual: linha.dsStatus,
    proxStatus,
    dsObserv: obs,
    nrCpf: linha.nrCpfCnpj,
    nmCliente: linha.nmClient,
    cdProd: linha.cdProd,
    nrContra: linha.nrContra ?? null,
  };
}
async function cicloMovimentacao(nrProsp, proxStatus, obs) {
  const linha = await linhaPainel(nrProsp);
  const criar = await post("A", "/api/propostas-transferir", corpo(linha, proxStatus, obs));
  const id = criar.json?.requisicao?.id ?? null;
  if (!id) return { linha, criar, id: null };
  const dec = await post("B", `/api/sod/requisicoes/${id}/decisao`, { decisao: "aprovar" });
  const dep = await get("B", `/api/sod/requisicoes/${id}`);
  const hist = await get("A", `/api/propostas-historico/${nrProsp}`);
  const depois = await linhaPainel(nrProsp);
  return { linha, criar, id, dec, dep, hist, depois };
}

/* V1 — destino Cancelado (20056), que no Portal exige ocorrência ------- */
const alvoV1 = st.propostas?.L1?.nrProsp ?? null;
if (alvoV1) {
  const v1 = await cicloMovimentacao(alvoV1, 20056, "TESTE-SOD-US08-V1 cancelamento de homologacao");
  const est = v1.dep?.json?.requisicao?.estado;
  registra(
    "V1 movimentação para 20056 (Cancelado) — destino com ocorrência no Portal",
    "executada, com a proposta em 20056 na Sinqia",
    `criar=${v1.criar.status} estado=${est} causa=${v1.dep?.json?.requisicao?.resultado?.causa ?? "-"} ` +
      `etapaPainel=${v1.depois?.nrStatus ?? "-"}`,
    est === "executada" && v1.depois?.nrStatus === 20056,
    {
      nrProsp: alvoV1,
      requisicaoId: v1.id,
      respostaCriacao: v1.criar.json,
      respostaDecisao: v1.dec?.json,
      resultadoIntegral: v1.dep?.json?.requisicao?.resultado ?? null,
      historicoDepois: v1.hist?.json?.historicos ?? null,
    },
  );
} else {
  registra("V1 movimentação para 20056", "-", "sem proposta L1 no estado", false, {});
}

/* V2 — movimentação a partir de 20051 (etapa nova da P01) -------------- */
const p01 = st.propostas?.P01?.nrProsp ?? null;
const linhaP01 = p01 ? await linhaPainel(p01) : null;
const transP01 = linhaP01 ? await transicoesDe(linhaP01.nrWf, linhaP01.nrStatus) : [];
if (linhaP01 && transP01.length > 0) {
  const destino = transP01[0];
  const v2 = await cicloMovimentacao(p01, destino.proxStatus, "TESTE-SOD-US08-V2 avanco de etapa");
  const est = v2.dep?.json?.requisicao?.estado;
  registra(
    `V2 movimentação ${linhaP01.nrStatus}→${destino.proxStatus} (${destino.dsStatus})`,
    "executada, etapa refletida na Sinqia",
    `criar=${v2.criar.status} estado=${est} causa=${v2.dep?.json?.requisicao?.resultado?.causa ?? "-"} ` +
      `etapaPainel=${v2.depois?.nrStatus ?? "-"}`,
    est === "executada" && v2.depois?.nrStatus === destino.proxStatus,
    {
      nrProsp: p01,
      requisicaoId: v2.id,
      destino,
      respostaDecisao: v2.dec?.json,
      resultadoIntegral: v2.dep?.json?.requisicao?.resultado ?? null,
      historicoDepois: v2.hist?.json?.historicos ?? null,
    },
  );
} else {
  registra(
    "V2 movimentação a partir da etapa nova",
    "-",
    `etapa ${linhaP01?.nrStatus} sem transições disponíveis`,
    true,
    { transicoes: transP01, observacao: "Sem destino válido: nada a testar nesta variante." },
  );
}

/* V3 — DIVERGÊNCIA EXTERNA (aprovei e nada moveu) --------------------- */
const alvoV3 = st.propostas?.L2?.nrProsp ?? null;
if (alvoV3) {
  const linha = await linhaPainel(alvoV3);
  const criar = await post("A", "/api/propostas-transferir", corpo(linha, 20051, "TESTE-SOD-US08-V3"));
  const reqV3 = criar.json?.requisicao?.id ?? null;

  // Move a proposta POR FORA da esteira: flag off → rota direta → flag on.
  const cliOff = flag("proposta.movimentar", "off");
  const externo = await post("A", "/api/propostas-transferir", corpo(linha, 20056, "TESTE-SOD-US08-V3 movida por fora"));
  const cliOn = flag("proposta.movimentar", "on");
  const linhaExterna = await linhaPainel(alvoV3);

  const dec = await post("B", `/api/sod/requisicoes/${reqV3}/decisao`, { decisao: "aprovar" });
  const dep = await get("B", `/api/sod/requisicoes/${reqV3}`);
  const resultado = dep.json?.requisicao?.resultado ?? null;
  const depois = await linhaPainel(alvoV3);
  const ativas = await get("A", "/api/sod/movimentacoes-ativas");
  const aindaAtiva = (ativas.json?.movimentacoes ?? []).find((m) => m.nrProsp === Number(alvoV3));

  registra(
    "V3 divergência externa: aprovação NÃO move e registra falha explicada",
    "falha com causa divergencia_externa, esperado × atual, nada movido, bloqueio mantido",
    `movidaPorFora=${externo.status}/${linhaExterna?.nrStatus} estado=${dep.json?.requisicao?.estado} ` +
      `causa=${resultado?.causa} etapaFinal=${depois?.nrStatus} bloqueioMantido=${!!aindaAtiva}`,
    dep.json?.requisicao?.estado === "falha" &&
      resultado?.causa === "divergencia_externa" &&
      depois?.nrStatus === linhaExterna?.nrStatus &&
      !!aindaAtiva,
    {
      nrProsp: alvoV3,
      requisicaoId: reqV3,
      cliFlagOff: cliOff,
      cliFlagOn: cliOn,
      movimentacaoExterna: externo.json,
      respostaDecisao: dec.json,
      resultadoIntegral: resultado,
      historicoAuditoria: dep.json?.historico ?? null,
      movimentacaoAindaAtiva: aindaAtiva ?? null,
    },
  );
  st.requisicoes = {
    ...(st.requisicoes ?? {}),
    "US-08-V3": { movimentacaoEmFalha: reqV3, nrProsp: alvoV3 },
  };
} else {
  registra("V3 divergência externa", "-", "sem proposta L2 no estado", false, {});
}

salvarEstado(st);
log(`\nevidência: ${evidencia("61-us08-variantes", { quando: agora(), passos })}`);
log(`resultado: ${passos.filter((p) => p.resultado === "PASSOU").length}/${passos.length} variantes conforme esperado`);
