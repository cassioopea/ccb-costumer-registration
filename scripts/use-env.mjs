#!/usr/bin/env node
// Copia .env.<ambiente> para .env no diretório do app que chamou o script.
// Uso: node ../../scripts/use-env.mjs hml   (a partir de apps/api ou apps/web)
import { copyFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const target = process.argv[2];
if (!["hml", "prod"].includes(target)) {
  console.error('Uso: use-env.mjs <hml|prod>');
  process.exit(1);
}

const cwd = process.cwd();
const src = resolve(cwd, `.env.${target}`);
const dest = resolve(cwd, ".env");

if (!existsSync(src)) {
  console.error(`❌ Arquivo não encontrado: ${src}`);
  console.error(`   Crie ${`.env.${target}`} a partir de .env.example.`);
  process.exit(1);
}

copyFileSync(src, dest);
console.log(`✅ .env agora aponta para ${target.toUpperCase()} (copiado de .env.${target})`);
if (target === "prod") {
  console.log("⚠️  ATENÇÃO: ambiente de PRODUÇÃO ativo. Cadastros serão reais.");
}
