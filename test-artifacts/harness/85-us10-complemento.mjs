/**
 * @homolog — US-10, complemento.
 *
 * 10.5': o cenário "descarte libera o bloqueio" precisa de uma proposta que
 * AINDA possa ser movida. No script 80 a proposta da falha estava em etapa
 * terminal (20056), então a liberação só apareceu no endpoint agregado. Aqui o
 * ciclo é completo em uma proposta viva: requisição → divergência externa →
 * falha → descarte → NOVA requisição aceita.
 *
 * 10.6': reconferência do retry em `proposta.criar` (no script 80 a evidência
 * gravada teve o campo de veredito sobrescrito pelo objeto de resultado).
 */
import { execSync } from "node:child_process";
import path from "node:path";
import { estado, evidencia, get, log, login, post, agora } from "./lib.mjs";

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

const linhaPainel = async (nrProsp) =>
  (await post("A", "/api/propostas/painel", { filtros: { nrPropos: String(nrProsp) }, size: 3 })).json
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

/* Alvo: a proposta do item REPROVADO da US-09 — segue viva em 20050. --- */
/**
 * Nº da proposta usada no ciclo (o item REPROVADO do lote da US-09, que segue
 * vivo em 20050). O número real de homologação não vai para o repositório:
 * pegue no `test-artifacts/estado.json` local ou no painel de propostas.
 */
const alvo = Number(process.env.HOMOLOG_NR_PROSP ?? 0);
if (!alvo) {
  log("Informe a proposta: HOMOLOG_NR_PROSP=<nº> npx tsx test-artifacts/harness/85-us10-complemento.mjs");
  process.exit(1);
}
const l0 = await linhaPainel(alvo);
const trans0 = await transicoesDe(l0.nrWf, l0.nrStatus);
const destino = trans0.find((t) => t.proxStatus === 20051) ?? trans0[0];
log(`alvo ${alvo} em ${l0.nrStatus} (${l0.dsStatus}); destino ${destino?.proxStatus}`);

/* Requisição → move por fora → aprova → falha ------------------------- */
const criar = await post("A", "/api/propostas-transferir", corpo(l0, destino.proxStatus, "TESTE-SOD-US10 ciclo completo"));
const reqId = criar.json?.requisicao?.id ?? null;

const cliOff = flag("proposta.movimentar", "off");
const externo = await post("A", "/api/propostas-transferir", corpo(l0, 20056, "TESTE-SOD-US10 movida por fora"));
const cliOn = flag("proposta.movimentar", "on");

const dec = await post("B", `/api/sod/requisicoes/${reqId}/decisao`, { decisao: "aprovar" });
const depFalha = await get("B", `/api/sod/requisicoes/${reqId}`);
const ativasFalha = await get("A", "/api/sod/movimentacoes-ativas");
const bloqueada = (ativasFalha.json?.movimentacoes ?? []).some((m) => m.nrProsp === alvo);
registra(
  "10.5'a falha por divergência externa mantém o bloqueio",
  "falha com causa divergencia_externa e proposta bloqueada",
  `movidaPorFora=${externo.status} estado=${depFalha.json?.requisicao?.estado} ` +
    `causa=${depFalha.json?.requisicao?.resultado?.causa} bloqueada=${bloqueada}`,
  depFalha.json?.requisicao?.estado === "falha" &&
    depFalha.json?.requisicao?.resultado?.causa === "divergencia_externa" &&
    bloqueada,
  { requisicaoId: reqId, cliOff, cliOn, respostaDecisao: dec.json, resultado: depFalha.json?.requisicao?.resultado ?? null },
);

/* Bloqueio impede nova requisição ANTES do descarte ------------------- */
const lAtual = await linhaPainel(alvo);
const transAtual = await transicoesDe(lAtual.nrWf, lAtual.nrStatus);
const destino2 = transAtual[0] ?? null;
const antesDescarte = destino2
  ? await post("A", "/api/propostas-transferir", corpo(lAtual, destino2.proxStatus, "TESTE-SOD-US10 antes do descarte"))
  : null;

/* Descarte com motivo ------------------------------------------------- */
const MOTIVO = "TESTE-SOD: proposta cancelada por fora — movimentação sem efeito (US-10).";
const desc = await post("B", `/api/sod/requisicoes/${reqId}/descarte`, { motivo: MOTIVO });
const depDesc = await get("B", `/api/sod/requisicoes/${reqId}`);

/* Nova requisição DEPOIS do descarte --------------------------------- */
const depoisDescarte = destino2
  ? await post("A", "/api/propostas-transferir", corpo(lAtual, destino2.proxStatus, "TESTE-SOD-US10 depois do descarte"))
  : null;
if (depoisDescarte?.json?.requisicao?.id) {
  await post("A", `/api/sod/requisicoes/${depoisDescarte.json.requisicao.id}/decisao`, { decisao: "cancelar" });
}

registra(
  "10.5'b descarte libera o bloqueio para uma NOVA requisição",
  "antes do descarte 409 MOVIMENTACAO_BLOQUEADA; depois 201",
  destino2
    ? `antes=${antesDescarte.status}/${antesDescarte.json?.code ?? "-"} descarte=${desc.status}/${depDesc.json?.requisicao?.estado} depois=${depoisDescarte.status}`
    : `proposta em ${lAtual.nrStatus} sem transições — não aplicável`,
  destino2
    ? antesDescarte.status === 409 &&
      antesDescarte.json?.code === "MOVIMENTACAO_BLOQUEADA" &&
      desc.status === 200 &&
      depDesc.json?.requisicao?.estado === "descartada" &&
      depoisDescarte.status === 201
    : false,
  {
    etapaAtual: lAtual.nrStatus,
    destinoUsado: destino2,
    respostaAntes: antesDescarte?.json ?? null,
    respostaDescarte: desc.json,
    motivoRegistrado: depDesc.json?.requisicao?.motivo ?? null,
    respostaDepois: depoisDescarte?.json ?? null,
    historico: depDesc.json?.historico ?? null,
  },
);

/* 10.6' — reconferência do retry em proposta.criar -------------------- */
const reqProp = st.requisicoes?.["US-10"]?.propostaRetry ?? null;
if (reqProp) {
  const antes = await get("B", `/api/sod/requisicoes/${reqProp}`);
  const vedado = await post("A", `/api/sod/requisicoes/${reqProp}/retry`);
  const retry = await post("B", `/api/sod/requisicoes/${reqProp}/retry`);
  const dep = await get("B", `/api/sod/requisicoes/${reqProp}`);
  const tentativas = (dep.json?.historico ?? []).filter((h) => h.acao === "execucao_iniciada");
  registra(
    "10.6' retry em proposta.criar: vedado ao criador, executado pelo aprovador",
    "403 para A; 200 para B; histórico com uma tentativa a mais e payload intacto",
    `estadoAntes=${antes.json?.requisicao?.estado} vedado=${vedado.status}/${vedado.json?.code} ` +
      `retryB=${retry.status} estadoDepois=${dep.json?.requisicao?.estado} ` +
      `causa=${dep.json?.requisicao?.resultado?.causa} tentativas=${tentativas.length}`,
    vedado.status === 403 &&
      vedado.json?.code === "VIOLACAO_SOD" &&
      retry.status === 200 &&
      tentativas.length >= 3,
    {
      payloadIntacto:
        JSON.stringify(antes.json?.requisicao?.payload) === JSON.stringify(dep.json?.requisicao?.payload),
      causa: dep.json?.requisicao?.resultado?.causa ?? null,
      detalhe: dep.json?.requisicao?.resultado?.detalhe ?? null,
      totalTentativas: tentativas.length,
    },
  );
}

log(`\nevidência: ${evidencia("85-us10-complemento", { quando: agora(), passos })}`);
log(`resultado: ${passos.filter((p) => p.veredito === "PASSOU").length}/${passos.length} cenários PASSOU`);
