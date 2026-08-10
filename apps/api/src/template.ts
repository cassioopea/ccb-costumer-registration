import Papa from "papaparse";
import { EXEMPLO_PF, EXEMPLO_PJ } from "@cadastro-lote/shared";

/**
 * Template CSV para cadastro em lote.
 *
 * Colunas achatadas com notação:
 *  - campo raiz do cliente:        dsNome, nrCpfCnpj, ...
 *  - objeto aninhado (ponto):      dadosPf.dtNasc, dadosProfissionais.vlRendaBruta
 *  - array (índice):               bensImoveis[0].nmImovel, dadosBancarios[0].nrConta
 *
 * Detecção PF/PJ é pelo comprimento de nrCpfCnpj (11=PF → dadosPf; 14=PJ → dadosPj).
 * Preencha só o que precisar; colunas vazias são ignoradas (não viram null).
 * Os campos de controle do lote (step/finalizar) NÃO vão no CSV — são definidos na tela.
 */

// Ordem das colunas do template (espelha o conjunto mínimo prático do exemplo PF validado).
const TEMPLATE_COLUMNS = [
  // Identificação / endereço / contato (nível cliente)
  "dsNome", "nrCpfCnpj", "sgEstado", "dtAbert", "dtValcad", "cdSituac", "dsSituac",
  "nrCep", "dsEnd", "nrEnd", "dsBairro", "dsCidade", "dsCompl",
  "nrDDD", "nrTel", "nrDDDCel", "nrCel", "dsEmail",
  "cdPess", "cdAtvCl", "cdAutscr", "cdGrupo", "cdPais",
  // bensImoveis[0]
  "bensImoveis[0].idAcao", "bensImoveis[0].cdPais", "bensImoveis[0].nmImovel",
  "bensImoveis[0].tpImovel", "bensImoveis[0].nmEnd", "bensImoveis[0].nrEnd",
  "bensImoveis[0].nmBairro", "bensImoveis[0].nmCidade", "bensImoveis[0].nrCep",
  "bensImoveis[0].sgEstado",
  // dadosBancarios[0]
  "dadosBancarios[0].idAcao", "dadosBancarios[0].nrBanco", "dadosBancarios[0].nrAgencia",
  "dadosBancarios[0].nrConta", "dadosBancarios[0].dvConta", "dadosBancarios[0].idPrincipal",
  "dadosBancarios[0].dtAbert",
  // dadosPf (PF)
  "dadosPf.dtNasc", "dadosPf.tpSexo", "dadosPf.cdProf", "dadosPf.tpDoc", "dadosPf.nrDoc",
  "dadosPf.sgEmissor", "dadosPf.dtEmissao", "dadosPf.sgEstadoNat", "dadosPf.cdEstCivil",
  "dadosPf.idUniao", "dadosPf.nomeMae", "dadosPf.nomePai", "dadosPf.naturalidade",
  "dadosPf.nomeCidadeNaturalidade", "dadosPf.nacionalidade", "dadosPf.idGrinst",
  "dadosPf.nrDepend", "dadosPf.idLe6515", "dadosPf.cdPais",
  // dadosPj (PJ) — preencher em vez de dadosPf quando documento tiver 14 dígitos
  "dadosPj.amFatMes", "dadosPj.cdCapital", "dadosPj.cdSetor", "dadosPj.cdTribute",
  "dadosPj.dtAberturaEmpresa", "dadosPj.idConsti", "dadosPj.idContAcio",
  "dadosPj.nomeFantasia", "dadosPj.qtFuncio",
  // dadosProfissionais
  "dadosProfissionais.cdProf", "dadosProfissionais.dsCargo", "dadosProfissionais.dtAdmis",
  "dadosProfissionais.vlRendaBruta", "dadosProfissionais.vlRendaLiquida",
  "dadosProfissionais.cdPorte", "dadosProfissionais.cdLoctb", "dadosProfissionais.cdPais",
  "dadosProfissionais.nrCep", "dadosProfissionais.nmEnd", "dadosProfissionais.nrEnd",
  "dadosProfissionais.nmBairro", "dadosProfissionais.nmCidade", "dadosProfissionais.sgEstado",
  // refPessoais[0]
  "refPessoais[0].nome", "refPessoais[0].nrDDDTel", "refPessoais[0].nrTel",
];

/** Gera o conteúdo do template.csv com 2 linhas de exemplo (PF e PJ). */
export function buildTemplateCsv(): string {
  const rows = [EXEMPLO_PF, EXEMPLO_PJ].map((ex) => {
    const ordered: Record<string, string> = {};
    for (const col of TEMPLATE_COLUMNS) ordered[col] = ex[col] ?? "";
    return ordered;
  });
  return Papa.unparse({ fields: TEMPLATE_COLUMNS, data: rows }, { newline: "\r\n" });
}

/**
 * Template CSV do lote de PROPOSTAS (US-07) — as mesmas colunas do
 * Emissoes.xlsx, para quem preferir montar o arquivo em CSV (o upload aceita
 * os dois formatos; no composto, os tomadores vão em arquivo separado, no
 * template de tomadores acima).
 *
 * Formatos: valores monetários com PONTO decimal (416.78); datas dd/mm/aaaa;
 * CPF pode vir com ou sem zeros à esquerda (o parser restaura); N_Contrato
 * fica vazio (gerado pela Sinqia).
 */
const TEMPLATE_PROPOSTAS_COLUMNS = [
  "Nome", "CPF", "ID_Sinqia", "N_CCB", "Valor da parcela inicial", "N_Contrato",
  "Liquido", "Financiado", "Quantidade Parcelas", "TAC", "Seguro", "Out. vlr",
  "1º vcto. De juros", "Situação",
];

const EXEMPLOS_PROPOSTAS: Array<Record<string, string>> = [
  {
    "Nome": "Maria Exemplo da Silva",
    "CPF": "06550599620",
    "ID_Sinqia": "333-6",
    "N_CCB": "CCB-2026-0001",
    "Valor da parcela inicial": "416.78",
    "N_Contrato": "",
    "Liquido": "10000.00",
    "Financiado": "10470.00",
    "Quantidade Parcelas": "36",
    "TAC": "350.00",
    "Seguro": "120.00",
    "Out. vlr": "0",
    "1º vcto. De juros": "05/09/2026",
    "Situação": "Compliance",
  },
  {
    "Nome": "João Exemplo Pereira",
    "CPF": "82635790304",
    "ID_Sinqia": "412-9",
    "N_CCB": "CCB-2026-0002",
    "Valor da parcela inicial": "1250.10",
    "N_Contrato": "",
    "Liquido": "24000.00",
    "Financiado": "24980.00",
    "Quantidade Parcelas": "24",
    "TAC": "500.00",
    "Seguro": "0",
    "Out. vlr": "480.00",
    "1º vcto. De juros": "10/09/2026",
    "Situação": "Validação Creditú",
  },
];

/** Gera o template CSV de propostas (Emissões) com 2 linhas de exemplo. */
export function buildTemplatePropostasCsv(): string {
  const rows = EXEMPLOS_PROPOSTAS.map((ex) => {
    const ordered: Record<string, string> = {};
    for (const col of TEMPLATE_PROPOSTAS_COLUMNS) ordered[col] = ex[col] ?? "";
    return ordered;
  });
  return Papa.unparse({ fields: TEMPLATE_PROPOSTAS_COLUMNS, data: rows }, { newline: "\r\n" });
}
