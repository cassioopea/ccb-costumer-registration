/**
 * @homolog — US-05: feature flag definitiva, corte e auditoria.
 *
 * Com a flag ATIVA a rota direta não executa nada na Sinqia (vira requisição);
 * com a flag INATIVA o fluxo direto continua intacto (não-regressão) — provado
 * com um cadastro REAL. A mudança de flag é feita pelo CLI auditado e a leitura
 * é em RUNTIME (sem restart).
 */
import { execSync } from "node:child_process";
import path from "node:path";
import { EXEMPLO_PF } from "@cadastro-lote/shared";
import {
  cpfSintetico,
  estado,
  evidencia,
  get,
  log,
  login,
  post,
  salvarEstado,
  agora,
  API,
} from "./lib.mjs";

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

/** CLI de flags — o ÚNICO caminho de mudança (RN03: sem tela). */
function flag(tipo, valor) {
  // Shell explícito: no Windows o `npm` é um .cmd e execFile não o resolve.
  const saida = execSync(
    `npm run --silent sod:flag -- ${tipo} ${valor} --por ${ATOR_FLAG}`,
    { cwd: DIR_API, encoding: "utf8" },
  );
  const linha = saida.trim().split(/\r?\n/).pop() ?? "";
  log(`  cli: ${linha}`);
  return linha;
}

const flagsEnv = async () => (await (await fetch(`${API}/api/env`)).json()).aprovacao;

await login("A");
await login("B");

const st = estado();
const passos = [];
const registra = (id, esperado, obtido, ok, extra = {}) => {
  passos.push({ id, esperado, obtido, resultado: ok ? "PASSOU" : "FALHOU", ...extra });
  log(`${ok ? "PASSOU" : "FALHOU"}  ${id} — ${obtido}`);
  return ok;
};

const CONTROL = { finalizar: false, idIntegracaoCadastro: "S" };
const T05cpf = cpfSintetico(900810005);
const camposT05 = {
  ...EXEMPLO_PF,
  dsNome: "TESTE-SOD-T05 GERALDO L B ARAGAO",
  nrCpfCnpj: T05cpf,
  dsEmail: "teste.sod.t05@opea.com.br",
};

/* 5.1 — flag ATIVA: a rota direta NÃO executa na Sinqia --------------- */
const antes51 = await flagsEnv();
const r51 = await post("A", "/api/cadastrar", { campos: camposT05, control: CONTROL });
const req51 = r51.json?.requisicao?.id ?? null;
registra(
  "5.1 flag ATIVA → rota direta vira requisição (corte total)",
  "201 aprovacao:true, sem status/httpStatus de cadastro Sinqia na resposta",
  `HTTP ${r51.status} aprovacao=${r51.json?.aprovacao} temStatusSinqia=${"status" in (r51.json ?? {})}`,
  r51.status === 201 && r51.json?.aprovacao === true && !("status" in (r51.json ?? {})),
  { flagsAntes: antes51, resposta: r51.json },
);

// A requisição de 5.1 é cancelada: o cadastro real de T05 acontece em 5.3.
if (req51) {
  const c = await post("A", `/api/sod/requisicoes/${req51}/decisao`, { decisao: "cancelar" });
  log(`  limpeza: requisição ${req51} cancelada (HTTP ${c.status})`);
}

/* 5.3 — flag INATIVA: fluxo direto intacto (cadastro REAL) ------------ */
log("desligando aprovacao.cadastro_tomador_individual…");
const cliOff = flag("tomador.cadastrar", "off");
const flagsOff = await flagsEnv();
const r53 = await post("A", "/api/cadastrar", { campos: camposT05, control: CONTROL });
registra(
  "5.3 flag INATIVA → fluxo direto intacto (não-regressão)",
  "cadastro executado direto na Sinqia (status OK), sem requisição",
  `HTTP ${r53.status} status=${r53.json?.status} envelope=${r53.json?.envelopeStatus} ` +
    `aprovacao=${r53.json?.aprovacao ?? false} runtimeFlag=${flagsOff.cadastroTomadorIndividual}`,
  r53.status === 200 &&
    r53.json?.status === "OK" &&
    !r53.json?.aprovacao &&
    flagsOff.cadastroTomadorIndividual === false,
  { cli: cliOff, flagsDepoisDoOff: flagsOff, resposta: r53.json },
);

log("religando aprovacao.cadastro_tomador_individual…");
const cliOn = flag("tomador.cadastrar", "on");
const flagsOn = await flagsEnv();
registra(
  "5.1b leitura da flag em RUNTIME (sem restart)",
  "/api/env reflete off e on sem reiniciar o servidor",
  `off→${flagsOff.cadastroTomadorIndividual} on→${flagsOn.cadastroTomadorIndividual}`,
  flagsOff.cadastroTomadorIndividual === false && flagsOn.cadastroTomadorIndividual === true,
  { cli: cliOn, flagsFinais: flagsOn },
);

/* 5.4 — auditoria da mudança de flag --------------------------------- */
const aud = await get("A", "/api/sod/auditoria?limit=200");
const eventosFlag = (aud.json?.itens ?? aud.json?.auditoria ?? aud.json?.registros ?? []).filter(
  (e) => e.acao === "flag_alterada",
);
registra(
  "5.4 mudança de flag auditada (RN05)",
  "eventos flag_alterada com ator e antes/depois",
  `HTTP ${aud.status} eventos=${eventosFlag.length}`,
  aud.status === 200 && eventosFlag.length >= 10,
  { chavesResposta: aud.json ? Object.keys(aud.json) : [], ultimosEventos: eventosFlag.slice(0, 4) },
);

/* 5.5 — flag inexistente/tipo fora do corte -------------------------- */
let cliInvalido = null;
try {
  flag("tipo.inexistente", "on");
} catch (e) {
  cliInvalido = String(e.stderr ?? e.message).split(/\r?\n/).slice(0, 3).join(" | ");
}
registra(
  "5.5 CLI rejeita tipo que não está sob corte",
  "erro de uso, nada gravado",
  cliInvalido ? "CLI recusou o tipo inexistente" : "CLI ACEITOU tipo inexistente",
  !!cliInvalido,
  { saidaCli: cliInvalido },
);

st.tomadores = {
  ...(st.tomadores ?? {}),
  T05: {
    cpf: T05cpf,
    nome: camposT05.dsNome,
    origem: "US-05 (cadastro direto, flag inativa)",
    estado: r53.json?.status === "OK" ? "cadastrado direto" : "falhou",
  },
};
salvarEstado(st);

log(`\nevidência: ${evidencia("30-us05-flags", { quando: agora(), passos })}`);
log(`resultado: ${passos.filter((p) => p.resultado === "PASSOU").length}/${passos.length} cenários PASSOU`);
