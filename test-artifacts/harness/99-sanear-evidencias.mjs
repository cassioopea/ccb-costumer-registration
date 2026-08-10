/**
 * @homolog — saneamento das evidências já gravadas.
 *
 * A primeira versão da redação trocava identidades apenas por IGUALDADE de
 * valor, e os logins vazavam dentro de frases inteiras devolvidas pelo BFF
 * ("criada por X em …") e pelo CLI de flags ("por X. Mudança auditada"). Este
 * script reaplica `redigir` (agora com troca em prosa) sobre TODO o conteúdo de
 * `test-artifacts/`, e falha se sobrar qualquer ocorrência de login distintivo.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { credenciais, redigir, log } from "./lib.mjs";

const RAIZ = path.resolve(import.meta.dirname, "..");

function arquivos(dir) {
  const saida = [];
  for (const nome of readdirSync(dir)) {
    const p = path.join(dir, nome);
    if (statSync(p).isDirectory()) {
      if (nome === "harness") continue; // o harness não guarda dados de execução
      saida.push(...arquivos(p));
    } else if (/\.(json|md)$/.test(nome)) {
      saida.push(p);
    }
  }
  return saida;
}

const { A, B } = credenciais();
const distintivos = [A.user, B.user].filter((u) => u.includes(".") || u.trim().length >= 8);

let alterados = 0;
for (const arq of arquivos(RAIZ)) {
  const antes = readFileSync(arq, "utf8");
  const depois = redigir(antes);
  if (depois !== antes) {
    writeFileSync(arq, depois, "utf8");
    alterados++;
    log(`saneado: ${path.relative(RAIZ, arq)}`);
  }
}
log(`arquivos alterados: ${alterados}`);

// Verificação final: nenhum login distintivo pode restar.
const restantes = [];
for (const arq of arquivos(RAIZ)) {
  const texto = readFileSync(arq, "utf8");
  for (const login of distintivos) {
    if (texto.toLowerCase().includes(login.trim().toLowerCase())) {
      restantes.push(`${path.relative(RAIZ, arq)} (login distintivo presente)`);
    }
  }
}
if (restantes.length > 0) {
  console.error("FALHOU — ainda há login em:\n  " + restantes.join("\n  "));
  process.exit(1);
}
log("verificação OK: nenhum login distintivo nas evidências.");
