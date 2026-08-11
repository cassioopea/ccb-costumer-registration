/**
 * @homolog — US-10, cenário 10.5'' (terceira tentativa, agora com o dado certo).
 *
 * As duas tentativas anteriores caíram na mesma armadilha: mover a proposta por
 * fora para 20056 (Cancelado) a deixa em etapa TERMINAL, e sem transições
 * disponíveis não há como provar que o descarte liberou o bloqueio. Aqui a
 * proposta é NOVA e a movimentação externa vai para 20051 (Contrato Assinado),
 * que o motor da Sinqia avança para 20052 — etapa com transições válidas.
 */
import { execSync } from "node:child_process";
import path from "node:path";
import { aguardar, estado, evidencia, get, log, login, post, agora } from "./lib.mjs";

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
const registra = (id, esperado, obtido, ok, detalhes = {}) => {
  passos.push({ id, esperado, obtido, veredito: ok ? "PASSOU" : "FALHOU", detalhes });
  log(`${ok ? "PASSOU" : "FALHOU"}  ${id} — ${obtido}`);
};

const linhaPainel = async (nr) =>
  (await post("A", "/api/propostas/painel", { filtros: { nrPropos: String(nr) }, size: 3 })).json
    ?.propostas?.[0] ?? null;
const transicoesDe = async (nrWf, nrStatus) =>
  (await get("A", `/api/propostas-transicoes?nrWf=${nrWf}&nrStatus=${nrStatus}`)).json?.transicoes ?? [];
const corpo = (l, prox, obs) => ({
  nrProsp: l.nrProsp,
  nrWf: l.nrWf,
  nrStatusAtual: l.nrStatus,
  dsStatusAtual: l.dsStatus,
  proxStatus: prox,
  dsObserv: obs,
  nrCpf: l.nrCpfCnpj,
  nmCliente: l.nmClient,
  cdProd: l.cdProd,
  nrContra: l.nrContra ?? null,
});

/* Proposta nova para o tomador C3 (assinatura inédita: 8.000 em 6x) ---- */
const tom = st.tomadores?.C3;
if (!tom?.cpf) throw new Error("Sem tomador C3 no estado.");
const calc = await post("A", "/api/propostas/calcular-uma", {
  cpf: tom.cpf,
  nome: tom.nome,
  dados: { vlLiquido: 8000, qtParcelas: 6, dtVct1Ap: 20260910, vlTac: 0, vlSeguro: 0, vlOutros: 0 },
  params: { txJuros: 12, cdProd: 1015, idCarCtr: 31, dtContra: 20260810 },
});
const reqProp = await post("A", "/api/propostas/criar-uma", {
  calcId: calc.json.calcId,
  params: { txJuros: 12, cdProd: 1015, idCarCtr: 31, cdConven: "111", dtContra: 20260810 },
  forcarDuplicada: false,
});
await post("B", `/api/sod/requisicoes/${reqProp.json.requisicao.id}/decisao`, { decisao: "aprovar" });
const depProp = await get("B", `/api/sod/requisicoes/${reqProp.json.requisicao.id}`);
const nrProsp = Number(depProp.json?.requisicao?.resultado?.nrProsp);
log(`proposta nova: ${nrProsp} (requisição ${reqProp.json.requisicao.id})`);

// Espera o motor levar a proposta a 20050 (etapa com transições).
const l0 = await aguardar(
  async () => {
    const l = await linhaPainel(nrProsp);
    return l && l.nrStatus === 20050 ? l : null;
  },
  { timeoutMs: 240_000, intervaloMs: 5000 },
);
if (!l0) throw new Error(`Proposta ${nrProsp} não chegou a 20050 na janela de espera.`);
log(`proposta ${nrProsp} em ${l0.nrStatus} (${l0.dsStatus})`);

/* Requisição (20050→20051) + movimentação externa para 20051 ---------- */
const criar = await post("A", "/api/propostas-transferir", corpo(l0, 20051, "TESTE-SOD-US10 liberacao"));
const reqId = criar.json?.requisicao?.id ?? null;

const cliOff = flag("proposta.movimentar", "off");
const externo = await post("A", "/api/propostas-transferir", corpo(l0, 20051, "TESTE-SOD-US10 movida por fora (mesmo destino, por outro caminho)"));
const cliOn = flag("proposta.movimentar", "on");

const dec = await post("B", `/api/sod/requisicoes/${reqId}/decisao`, { decisao: "aprovar" });
const depFalha = await get("B", `/api/sod/requisicoes/${reqId}`);
const causa = depFalha.json?.requisicao?.resultado?.causa ?? null;
registra(
  "10.5''a divergência externa gera falha e mantém o bloqueio",
  "falha (divergencia_externa) e proposta ainda bloqueada",
  `externo=${externo.status} estado=${depFalha.json?.requisicao?.estado} causa=${causa}`,
  depFalha.json?.requisicao?.estado === "falha" && causa === "divergencia_externa",
  { nrProsp, requisicaoId: reqId, cliOff, cliOn, respostaDecisao: dec.json, resultado: depFalha.json?.requisicao?.resultado ?? null },
);

/* Etapa viva + tentativa ANTES e DEPOIS do descarte ------------------- */
const lAtual = await aguardar(
  async () => {
    const l = await linhaPainel(nrProsp);
    const t = l ? await transicoesDe(l.nrWf, l.nrStatus) : [];
    return t.length > 0 ? { l, t } : null;
  },
  { timeoutMs: 120_000, intervaloMs: 5000 },
);
const destino2 = lAtual?.t?.[0] ?? null;
const antes = destino2
  ? await post("A", "/api/propostas-transferir", corpo(lAtual.l, destino2.proxStatus, "TESTE-SOD-US10 antes do descarte"))
  : null;

const MOTIVO = "TESTE-SOD: movimentação já aplicada por outro caminho — divergência resolvida (US-10).";
const desc = await post("B", `/api/sod/requisicoes/${reqId}/descarte`, { motivo: MOTIVO });
const depDesc = await get("B", `/api/sod/requisicoes/${reqId}`);

const depois = destino2
  ? await post("A", "/api/propostas-transferir", corpo(lAtual.l, destino2.proxStatus, "TESTE-SOD-US10 depois do descarte"))
  : null;
if (depois?.json?.requisicao?.id) {
  await post("A", `/api/sod/requisicoes/${depois.json.requisicao.id}/decisao`, { decisao: "cancelar" });
}
const ativasFim = await get("A", "/api/sod/movimentacoes-ativas");

registra(
  "10.5''b descarte com motivo LIBERA o bloqueio para nova requisição",
  "antes: 409 MOVIMENTACAO_BLOQUEADA; depois: 201",
  destino2
    ? `etapa=${lAtual.l.nrStatus} antes=${antes.status}/${antes.json?.code ?? "-"} ` +
      `descarte=${desc.status}/${depDesc.json?.requisicao?.estado} depois=${depois.status}`
    : "proposta sem transições — não aplicável",
  !!destino2 &&
    antes.status === 409 &&
    antes.json?.code === "MOVIMENTACAO_BLOQUEADA" &&
    desc.status === 200 &&
    depDesc.json?.requisicao?.estado === "descartada" &&
    depois.status === 201,
  {
    etapaAtual: lAtual?.l?.nrStatus ?? null,
    destinoUsado: destino2,
    respostaAntes: antes?.json ?? null,
    respostaDescarte: desc.json,
    motivoRegistrado: depDesc.json?.requisicao?.motivo ?? null,
    respostaDepois: depois?.json ?? null,
    historicoDescarte: depDesc.json?.historico ?? null,
    movimentacoesAtivasNoFim: (ativasFim.json?.movimentacoes ?? []).filter((m) => m.nrProsp === nrProsp),
  },
);

log(`\nevidência: ${evidencia("86-us10-liberacao", { quando: agora(), passos })}`);
log(`resultado: ${passos.filter((p) => p.veredito === "PASSOU").length}/${passos.length} cenários PASSOU`);
