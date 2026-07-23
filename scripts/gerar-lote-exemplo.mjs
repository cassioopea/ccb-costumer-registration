#!/usr/bin/env node
// Gera um CSV de exemplo com ~70 tomadores de CCB (dados FAKE de teste),
// contendo erros injetados de propósito para exercitar o dry-run.
// Saída: exemplos/tomadores-ccb-exemplo.csv
//
// Uso: node scripts/gerar-lote-exemplo.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, "../exemplos/tomadores-ccb-exemplo.csv");

// ---- RNG determinístico (LCG) para reprodutibilidade ----
let seed = 20260723;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const int = (min, max) => min + Math.floor(rnd() * (max - min + 1));

// ---- Dígitos verificadores ----
function cpfCheckDigits(base9) {
  const d = base9.split("").map(Number);
  let s = 0;
  for (let i = 0; i < 9; i++) s += d[i] * (10 - i);
  let r = s % 11;
  const dv1 = r < 2 ? 0 : 11 - r;
  d.push(dv1);
  s = 0;
  for (let i = 0; i < 10; i++) s += d[i] * (11 - i);
  r = s % 11;
  const dv2 = r < 2 ? 0 : 11 - r;
  return base9 + dv1 + dv2;
}
function cnpjCheckDigits(base12) {
  const d = base12.split("").map(Number);
  const w1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const w2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  let s = 0;
  for (let i = 0; i < 12; i++) s += d[i] * w1[i];
  let r = s % 11;
  const dv1 = r < 2 ? 0 : 11 - r;
  d.push(dv1);
  s = 0;
  for (let i = 0; i < 13; i++) s += d[i] * w2[i];
  r = s % 11;
  const dv2 = r < 2 ? 0 : 11 - r;
  return base12 + dv1 + dv2;
}
const gerarCpf = () => cpfCheckDigits(String(int(100000000, 999999999)));
const gerarCnpj = () => cnpjCheckDigits(String(int(10000000, 99999999)) + "0001");

// ---- Massa de dados fake ----
const nomesPf = [
  "Ana Beatriz Souza", "Carlos Eduardo Lima", "Fernanda Oliveira Costa",
  "João Pedro Almeida", "Mariana Ribeiro Santos", "Rafael Gomes Pereira",
  "Juliana Martins Rocha", "Bruno Henrique Dias", "Camila Ferreira Nunes",
  "Lucas Aparecido Melo", "Patrícia Cardoso Pinto", "Rodrigo Barbosa Teixeira",
  "Aline Cristina Moraes", "Gustavo Henrique Faria", "Larissa Menezes Cunha",
  "Thiago Ramos Azevedo", "Vanessa Lopes Correia", "Felipe Andrade Moura",
  "Isabela Nogueira Freitas", "Marcelo Vieira Campos",
];
const nomesPj = [
  "Aurora Serviços Digitais LTDA", "Bandeirante Comércio de Alimentos ME",
  "Cordilheira Logística e Transportes LTDA", "Delta Engenharia e Projetos SA",
  "Estrela Confecções Têxteis LTDA", "Frota Rápida Locadora de Veículos ME",
  "Girassol Agroindústria LTDA", "Horizonte Consultoria Empresarial SA",
  "Ipê Materiais de Construção LTDA", "Jacarandá Móveis Planejados ME",
  "Kalunga Distribuidora de Peças LTDA", "Litoral Turismo e Eventos SA",
];
const cidades = [
  ["São Paulo", "SP"], ["Rio de Janeiro", "RJ"], ["Belo Horizonte", "MG"],
  ["Porto Alegre", "RS"], ["Curitiba", "PR"], ["Salvador", "BA"],
  ["Recife", "PE"], ["Fortaleza", "CE"], ["Goiânia", "GO"], ["Belém", "PA"],
];
const ruas = ["Rua das Acácias", "Avenida Brasil", "Rua XV de Novembro", "Alameda Santos",
  "Travessa dos Pioneiros", "Rua Sete de Setembro", "Avenida Paulista", "Rua do Comércio"];
const bairros = ["Centro", "Jardim América", "Vila Nova", "Boa Vista", "Industrial", "Bela Vista"];
const cargos = ["ANALISTA", "GERENTE", "MEDICO", "ADVOGADO", "ENGENHEIRO", "PROFESSOR"];

// ---- Colunas (mesmo conjunto do template.csv) ----
const COLUMNS = [
  "dsNome", "nrCpfCnpj", "sgEstado", "dtAbert", "dtValcad", "cdSituac", "dsSituac",
  "nrCep", "dsEnd", "nrEnd", "dsBairro", "dsCidade", "dsCompl",
  "nrDDD", "nrTel", "nrDDDCel", "nrCel", "dsEmail",
  "cdPess", "cdAtvCl", "cdAutscr", "cdGrupo", "cdPais",
  "bensImoveis[0].idAcao", "bensImoveis[0].cdPais", "bensImoveis[0].nmImovel",
  "bensImoveis[0].tpImovel", "bensImoveis[0].nmEnd", "bensImoveis[0].nrEnd",
  "bensImoveis[0].nmBairro", "bensImoveis[0].nmCidade", "bensImoveis[0].nrCep",
  "bensImoveis[0].sgEstado",
  "dadosBancarios[0].idAcao", "dadosBancarios[0].nrBanco", "dadosBancarios[0].nrAgencia",
  "dadosBancarios[0].nrConta", "dadosBancarios[0].dvConta", "dadosBancarios[0].idPrincipal",
  "dadosBancarios[0].dtAbert",
  "dadosPf.dtNasc", "dadosPf.tpSexo", "dadosPf.cdProf", "dadosPf.tpDoc", "dadosPf.nrDoc",
  "dadosPf.sgEmissor", "dadosPf.dtEmissao", "dadosPf.sgEstadoNat", "dadosPf.cdEstCivil",
  "dadosPf.idUniao", "dadosPf.nomeMae", "dadosPf.nomePai", "dadosPf.naturalidade",
  "dadosPf.nomeCidadeNaturalidade", "dadosPf.nacionalidade", "dadosPf.idGrinst",
  "dadosPf.nrDepend", "dadosPf.idLe6515", "dadosPf.cdPais",
  "dadosPj.amFatMes", "dadosPj.cdCapital", "dadosPj.cdSetor", "dadosPj.cdTribute",
  "dadosPj.dtAberturaEmpresa", "dadosPj.idConsti", "dadosPj.idContAcio",
  "dadosPj.nomeFantasia", "dadosPj.qtFuncio",
  "dadosProfissionais.cdProf", "dadosProfissionais.dsCargo", "dadosProfissionais.dtAdmis",
  "dadosProfissionais.vlRendaBruta", "dadosProfissionais.vlRendaLiquida",
  "dadosProfissionais.cdPorte", "dadosProfissionais.cdLoctb", "dadosProfissionais.cdPais",
  "dadosProfissionais.nrCep", "dadosProfissionais.nmEnd", "dadosProfissionais.nrEnd",
  "dadosProfissionais.nmBairro", "dadosProfissionais.nmCidade", "dadosProfissionais.sgEstado",
  "refPessoais[0].nome", "refPessoais[0].nrDDDTel", "refPessoais[0].nrTel",
];

const cep = () => String(int(10000000, 99999999));
const emailFrom = (nome) =>
  nome.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z]/g, ".").replace(/\.+/g, ".").slice(0, 20) + "@exemplo.test.br";

function linhaPf() {
  const nome = pick(nomesPf);
  const [cidade, uf] = pick(cidades);
  const r = {};
  r["dsNome"] = nome;
  r["nrCpfCnpj"] = gerarCpf();
  r["sgEstado"] = uf;
  r["dtAbert"] = String(int(2005, 2023)) + "0101";
  r["dtValcad"] = "20260723";
  r["cdSituac"] = "1";
  r["dsSituac"] = "ATIVO";
  r["nrCep"] = cep();
  r["dsEnd"] = pick(ruas);
  r["nrEnd"] = String(int(10, 3999));
  r["dsBairro"] = pick(bairros);
  r["dsCidade"] = cidade;
  r["nrDDD"] = String(int(11, 99));
  r["nrTel"] = String(int(20000000, 39999999));
  r["nrDDDCel"] = String(int(11, 99));
  r["nrCel"] = String(int(900000000, 999999999));
  r["dsEmail"] = emailFrom(nome);
  r["cdPess"] = "1";
  r["cdAtvCl"] = "0";
  r["cdAutscr"] = "S";
  r["cdGrupo"] = "1";
  r["cdPais"] = "1";
  r["dadosBancarios[0].idAcao"] = "IN";
  r["dadosBancarios[0].nrBanco"] = String(pick([1, 33, 104, 237, 341]));
  r["dadosBancarios[0].nrAgencia"] = String(int(1, 9999));
  r["dadosBancarios[0].nrConta"] = String(int(10000, 999999));
  r["dadosBancarios[0].dvConta"] = String(int(0, 9));
  r["dadosBancarios[0].idPrincipal"] = "S";
  r["dadosBancarios[0].dtAbert"] = "19900101";
  r["dadosPf.dtNasc"] = String(int(1960, 2003)) + "0" + int(1, 9) + int(10, 28);
  r["dadosPf.tpSexo"] = pick(["M", "F"]);
  // Códigos de profissão válidos na Sinqia (4 e 7 são recusados pela API).
  const cdProf = String(pick([1, 2, 3, 5, 6]));
  r["dadosPf.cdProf"] = cdProf;
  r["dadosPf.tpDoc"] = "1";
  r["dadosPf.nrDoc"] = String(int(100000000, 999999999));
  r["dadosPf.sgEmissor"] = "SSP";
  r["dadosPf.dtEmissao"] = "20100101";
  r["dadosPf.sgEstadoNat"] = uf;
  r["dadosPf.cdEstCivil"] = String(int(1, 5));
  r["dadosPf.idUniao"] = pick(["1", "2"]); // Sinqia aceita só 1 (Sim) ou 2 (Não)
  r["dadosPf.nomeMae"] = "Mãe de " + nome.split(" ")[0];
  r["dadosPf.nacionalidade"] = "1";
  r["dadosPf.idGrinst"] = String(int(1, 10));
  r["dadosPf.nrDepend"] = String(int(0, 4));
  r["dadosPf.idLe6515"] = "N";
  r["dadosPf.cdPais"] = "1";
  r["dadosProfissionais.cdProf"] = r["dadosPf.cdProf"];
  r["dadosProfissionais.dsCargo"] = pick(cargos);
  r["dadosProfissionais.dtAdmis"] = "20180101";
  r["dadosProfissionais.vlRendaBruta"] = (int(2000, 25000) + rnd()).toFixed(2);
  r["dadosProfissionais.vlRendaLiquida"] = (int(1500, 20000) + rnd()).toFixed(2);
  r["dadosProfissionais.cdPorte"] = String(int(1, 9));
  r["dadosProfissionais.cdLoctb"] = "1";
  r["dadosProfissionais.cdPais"] = "1";
  r["dadosProfissionais.nrCep"] = cep();
  r["dadosProfissionais.nmEnd"] = pick(ruas);
  r["dadosProfissionais.nrEnd"] = String(int(10, 3999));
  r["dadosProfissionais.nmBairro"] = pick(bairros);
  r["dadosProfissionais.nmCidade"] = cidade;
  r["dadosProfissionais.sgEstado"] = uf;
  r["refPessoais[0].nome"] = "Referência de " + nome.split(" ")[0];
  r["refPessoais[0].nrDDDTel"] = String(int(11, 99));
  r["refPessoais[0].nrTel"] = String(int(20000000, 39999999));
  return r;
}

function linhaPj() {
  const nome = pick(nomesPj);
  const [cidade, uf] = pick(cidades);
  const r = {};
  r["dsNome"] = nome;
  r["nrCpfCnpj"] = gerarCnpj();
  r["sgEstado"] = uf;
  r["dtAbert"] = String(int(2000, 2020)) + "0101";
  r["dtValcad"] = "20260723";
  r["cdSituac"] = "1";
  r["dsSituac"] = "ATIVO";
  r["nrCep"] = cep();
  r["dsEnd"] = pick(ruas);
  r["nrEnd"] = String(int(10, 3999));
  r["dsBairro"] = pick(bairros);
  r["dsCidade"] = cidade;
  r["nrDDD"] = String(int(11, 99));
  r["nrTel"] = String(int(2000000000, 3999999999));
  r["nrDDDCel"] = String(int(11, 99));
  r["nrCel"] = String(int(900000000, 999999999));
  r["dsEmail"] = emailFrom(nome.split(" ")[0]);
  r["cdPess"] = "23";
  r["cdAtvCl"] = "0";
  r["cdAutscr"] = "S";
  r["cdGrupo"] = "1";
  r["cdPais"] = "1";
  r["dadosBancarios[0].idAcao"] = "IN";
  r["dadosBancarios[0].nrBanco"] = String(pick([1, 33, 104, 237, 341]));
  r["dadosBancarios[0].nrAgencia"] = String(int(1, 9999));
  r["dadosBancarios[0].nrConta"] = String(int(10000, 999999));
  r["dadosBancarios[0].dvConta"] = String(int(0, 9));
  r["dadosBancarios[0].idPrincipal"] = "S";
  r["dadosBancarios[0].dtAbert"] = "19950101";
  r["dadosPj.amFatMes"] = String(int(100000, 5000000));
  r["dadosPj.cdCapital"] = pick(["N", "E", "M"]);
  r["dadosPj.cdSetor"] = String(int(1, 4));
  r["dadosPj.cdTribute"] = String(int(1, 3));
  r["dadosPj.dtAberturaEmpresa"] = r["dtAbert"];
  r["dadosPj.idConsti"] = String(int(1, 11));
  r["dadosPj.idContAcio"] = pick(["1", "2"]);
  r["dadosPj.nomeFantasia"] = nome.split(" ")[0];
  r["dadosPj.qtFuncio"] = String(int(1, 500));
  return r;
}

// ---- Injeção de erros (índice base-1 da linha de DADOS) ----
const erros = {
  4: (r) => { r["nrCpfCnpj"] = "1234567890"; },                 // CPF com 10 dígitos
  9: (r) => { r["dadosPj.cdSetor"] = "1"; r["dadosPj.cdCapital"] = "N"; }, // PF com bloco dadosPj
  13: (r) => { r["nrDDD"] = "abc"; },                            // número não-numérico
  17: (r) => { r["dadosPf.cdProf"] = "medico"; },                // texto em campo numérico
  22: (r) => { r["dadosPf.idGrinst"] = "20"; },                  // enum idGrinst fora (1-10)
  26: (r) => { r["bensImoveis[0].idAcao"] = "XX"; r["bensImoveis[0].cdPais"] = "1"; r["bensImoveis[0].nmImovel"] = "Casa"; r["bensImoveis[0].tpImovel"] = "1"; }, // idAcao inválido
  31: (r) => { r["nrCpfCnpj"] = r["nrCpfCnpj"] + "99"; },        // CNPJ com dígitos a mais (PJ)
  35: (r) => { r["dadosPj.cdCapital"] = "X"; },                  // enum cdCapital fora (N/E/M)
  40: (r) => { r["dadosPj.cdSetor"] = "9"; },                    // enum cdSetor fora (1-4)
  44: (r) => { r["dadosPj.idContAcio"] = "3"; },                 // enum idContAcio fora (1/2)
  48: (r) => { r["dadosPj.idConsti"] = "99"; },                  // enum idConsti fora (1-11)
  52: (r) => { r["dadosPf.dtNasc"] = "20200101"; },              // PJ com bloco dadosPf
};

const TOTAL = 70;
const rows = [];
const relatorio = [];
for (let i = 1; i <= TOTAL; i++) {
  // Padrão: ~60% PF, ~40% PJ. Alguns índices são forçados a um tipo para casar o erro.
  const forcaPj = [9, 31, 35, 40, 44, 48].includes(i); // erros de PJ (ou PF+dadosPj)
  const forcaPf = [4, 13, 17, 22, 26, 52].includes(i);
  let tipo;
  if (i === 9) tipo = "PF"; // PF + bloco dadosPj (erro de bloco)
  else if (i === 52) tipo = "PJ"; // PJ + bloco dadosPf (erro de bloco)
  else if (forcaPj) tipo = "PJ";
  else if (forcaPf) tipo = "PF";
  else tipo = rnd() < 0.6 ? "PF" : "PJ";

  const r = tipo === "PF" ? linhaPf() : linhaPj();
  if (erros[i]) {
    erros[i](r);
    relatorio.push(`  linha ${i} (${tipo}): erro injetado`);
  }
  rows.push(r);
}

// ---- Serialização CSV ----
const esc = (v) => {
  const s = v == null ? "" : String(v);
  return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const linhasCsv = [COLUMNS.join(",")];
for (const r of rows) linhasCsv.push(COLUMNS.map((c) => esc(r[c] ?? "")).join(","));
const csv = "﻿" + linhasCsv.join("\r\n");

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, csv, "utf8");

console.log(`✅ Gerado: ${OUT}`);
console.log(`   ${TOTAL} tomadores (dados fake de teste).`);
console.log(`   ${Object.keys(erros).length} linhas com erro injetado:`);
console.log(relatorio.join("\n"));
