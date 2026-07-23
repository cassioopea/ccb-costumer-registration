import Papa from "papaparse";

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

/** Linha de exemplo PF (o CPF é genérico de teste). */
const EXAMPLE_PF: Record<string, string> = {
  dsNome: "Geraldo Luiz Bruno Aragão",
  nrCpfCnpj: "15032465070",
  sgEstado: "PA",
  dtAbert: "20001205",
  dtValcad: "20260307",
  cdSituac: "1",
  dsSituac: "ATIVO",
  nrCep: "67110570",
  dsEnd: "Passagem São José de Ribamar",
  nrEnd: "681",
  dsBairro: "Guanabara",
  dsCidade: "Ananindeua",
  nrDDD: "91",
  nrTel: "25969156",
  nrDDDCel: "91",
  nrCel: "994453733",
  dsEmail: "geraldo-aragao98@br.festo.com",
  cdPess: "1",
  cdAtvCl: "0",
  cdAutscr: "S",
  cdGrupo: "1",
  cdPais: "1",
  "bensImoveis[0].idAcao": "IN",
  "bensImoveis[0].cdPais": "1",
  "bensImoveis[0].nmImovel": "Casa",
  "bensImoveis[0].tpImovel": "1",
  "bensImoveis[0].nmEnd": "Passagem São José de Ribamar",
  "bensImoveis[0].nrEnd": "681",
  "bensImoveis[0].nmBairro": "Guanabara",
  "bensImoveis[0].nmCidade": "Ananindeua",
  "bensImoveis[0].nrCep": "67110570",
  "bensImoveis[0].sgEstado": "PA",
  "dadosBancarios[0].idAcao": "IN",
  "dadosBancarios[0].nrBanco": "1",
  "dadosBancarios[0].nrAgencia": "1584",
  "dadosBancarios[0].nrConta": "144460",
  "dadosBancarios[0].dvConta": "7",
  "dadosBancarios[0].idPrincipal": "S",
  "dadosBancarios[0].dtAbert": "19900101",
  "dadosPf.dtNasc": "19800120",
  "dadosPf.tpSexo": "M",
  "dadosPf.cdProf": "2",
  "dadosPf.tpDoc": "1",
  "dadosPf.nrDoc": "236451467",
  "dadosPf.sgEmissor": "SSP",
  "dadosPf.dtEmissao": "19990101",
  "dadosPf.sgEstadoNat": "MG",
  "dadosPf.cdEstCivil": "1",
  "dadosPf.idUniao": "2",
  "dadosPf.nomeMae": "Marcelo Danilo Aragão",
  "dadosPf.nomePai": "Elza Isadora",
  "dadosPf.naturalidade": "1200401",
  "dadosPf.nomeCidadeNaturalidade": "Belo Horizonte",
  "dadosPf.nacionalidade": "1",
  "dadosPf.idGrinst": "4",
  "dadosPf.nrDepend": "0",
  "dadosPf.idLe6515": "N",
  "dadosPf.cdPais": "1",
  "dadosProfissionais.cdProf": "2",
  "dadosProfissionais.dsCargo": "MEDICA",
  "dadosProfissionais.dtAdmis": "20000307",
  "dadosProfissionais.vlRendaBruta": "17992.40",
  "dadosProfissionais.vlRendaLiquida": "15000.00",
  "dadosProfissionais.cdPorte": "8",
  "dadosProfissionais.cdLoctb": "1",
  "dadosProfissionais.cdPais": "1",
  "dadosProfissionais.nrCep": "38412851",
  "dadosProfissionais.nmEnd": "Rua Mogno",
  "dadosProfissionais.nrEnd": "450",
  "dadosProfissionais.nmBairro": "Arroio da Manteiga",
  "dadosProfissionais.nmCidade": "São Leopoldo",
  "dadosProfissionais.sgEstado": "RS",
  "refPessoais[0].nome": "MARIA DAS DORES",
  "refPessoais[0].nrDDDTel": "31",
  "refPessoais[0].nrTel": "34567890",
};

/** Linha de exemplo PJ (usa dadosPj; deixa dadosPf vazio). */
const EXAMPLE_PJ: Record<string, string> = {
  dsNome: "Egalite Recursos Humanos Especiais LTDA",
  nrCpfCnpj: "10766388000190",
  sgEstado: "RS",
  dtAbert: "20090416",
  dtValcad: "20260307",
  cdSituac: "1",
  dsSituac: "ATIVO",
  nrCep: "90470282",
  dsEnd: "Avenida Carlos Gomes",
  nrEnd: "1672",
  dsBairro: "Auxiliadora",
  dsCidade: "Porto Alegre",
  nrDDD: "51",
  nrTel: "3427690775",
  nrDDDCel: "51",
  nrCel: "984103717",
  dsEmail: "egalite@gmail.com",
  cdPess: "23",
  cdAtvCl: "0",
  cdAutscr: "S",
  cdGrupo: "1",
  cdPais: "1",
  "dadosBancarios[0].idAcao": "IN",
  "dadosBancarios[0].nrBanco": "1",
  "dadosBancarios[0].nrAgencia": "1584",
  "dadosBancarios[0].nrConta": "144460",
  "dadosBancarios[0].dvConta": "7",
  "dadosBancarios[0].idPrincipal": "S",
  "dadosBancarios[0].dtAbert": "19900101",
  "dadosPj.amFatMes": "1000000",
  "dadosPj.cdCapital": "N",
  "dadosPj.cdSetor": "1",
  "dadosPj.cdTribute": "2",
  "dadosPj.dtAberturaEmpresa": "20090416",
  "dadosPj.idConsti": "1",
  "dadosPj.idContAcio": "1",
  "dadosPj.nomeFantasia": "Egalite RH",
  "dadosPj.qtFuncio": "0",
};

/** Gera o conteúdo do template.csv com 2 linhas de exemplo (PF e PJ). */
export function buildTemplateCsv(): string {
  const rows = [EXAMPLE_PF, EXAMPLE_PJ].map((ex) => {
    const ordered: Record<string, string> = {};
    for (const col of TEMPLATE_COLUMNS) ordered[col] = ex[col] ?? "";
    return ordered;
  });
  return Papa.unparse({ fields: TEMPLATE_COLUMNS, data: rows }, { newline: "\r\n" });
}
