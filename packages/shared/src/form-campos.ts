/**
 * Catálogo declarativo dos campos do cadastro individual.
 *
 * POR QUE DECLARATIVO: o formulário é renderizado a partir daqui, e o estado da
 * tela é um mapa achatado `{ "dadosPf.dtNasc": "19800120" }` — exatamente o
 * formato que uma linha de CSV produz. Assim o cadastro individual passa pelo
 * MESMO caminho de coerção/validação/montagem do lote (`parseFlatRow` →
 * `clienteSchema` → `buildRequest`), sem duplicar regra nenhuma.
 *
 * ESCOPO: o modelo completo do Swagger tem ~200 campos. Aqui estão os do
 * conjunto prático — os mesmos do `template.csv`, derivados do payload PF
 * validado em HML. Campos fora dessa lista continuam aceitos pelo schema
 * (`.passthrough()`), só não têm campo na tela.
 */

export type TipoCampo = "texto" | "numero" | "decimal" | "data" | "select";

export interface OpcaoCampo {
  valor: string;
  label: string;
}

export interface CampoForm {
  /** Caminho achatado, igual à coluna do CSV: "dadosPf.dtNasc". */
  path: string;
  label: string;
  tipo: TipoCampo;
  secao: SecaoId;
  /** Ausente = vale para PF e PJ. */
  aplica?: "PF" | "PJ";
  opcoes?: OpcaoCampo[];
  /** Texto de ajuda curto embaixo do campo. */
  hint?: string;
  placeholder?: string;
  /**
   * Obrigatório de verdade — hoje só o documento, que o `clienteSchema` exige
   * (11 ou 14 dígitos). O resto quem decide é a Sinqia: a lista autoritativa de
   * obrigatórios vem da rota de campos obrigatórios, ainda não integrada.
   */
  obrigatorio?: boolean;
}

export type SecaoId =
  | "identificacao"
  | "endereco"
  | "contato"
  | "classificacao"
  | "pf"
  | "pj"
  | "profissionais"
  | "bancarios"
  | "imovel"
  | "referencia";

export interface SecaoForm {
  id: SecaoId;
  titulo: string;
  descricao?: string;
  /** Ausente = vale para PF e PJ. */
  aplica?: "PF" | "PJ";
  /** Começa recolhida (campos menos usados). */
  recolhida?: boolean;
}

export const SECOES: SecaoForm[] = [
  { id: "identificacao", titulo: "Identificação", descricao: "O documento define se o cadastro é PF (11 dígitos) ou PJ (14)." },
  { id: "endereco", titulo: "Endereço principal" },
  { id: "contato", titulo: "Contato" },
  { id: "pf", titulo: "Dados de pessoa física", aplica: "PF" },
  { id: "pj", titulo: "Dados de pessoa jurídica", aplica: "PJ" },
  { id: "profissionais", titulo: "Dados profissionais", recolhida: true },
  { id: "bancarios", titulo: "Dados bancários", descricao: "Primeira conta (dadosBancarios[0]).", recolhida: true },
  { id: "imovel", titulo: "Bem imóvel", descricao: "Primeiro imóvel (bensImoveis[0]).", recolhida: true },
  { id: "referencia", titulo: "Referência pessoal", descricao: "Primeira referência (refPessoais[0]).", recolhida: true },
  { id: "classificacao", titulo: "Classificação e códigos", descricao: "Códigos de domínio da Sinqia.", recolhida: true },
];

/* ------------------------------------------------------------------ */
/* Opções de enums (espelham enums.ts / regras confirmadas em HML)     */
/* ------------------------------------------------------------------ */

const OPT_SEXO: OpcaoCampo[] = [
  { valor: "M", label: "M — Masculino" },
  { valor: "F", label: "F — Feminino" },
];

/** Confirmado por mensagem de consistência real da Sinqia em HML. */
const OPT_UNIAO: OpcaoCampo[] = [
  { valor: "1", label: "1 — Sim" },
  { valor: "2", label: "2 — Não" },
];

const OPT_SN: OpcaoCampo[] = [
  { valor: "S", label: "S — Sim" },
  { valor: "N", label: "N — Não" },
];

const OPT_CAPITAL: OpcaoCampo[] = [
  { valor: "N", label: "N — Nacional" },
  { valor: "E", label: "E — Estrangeiro" },
  { valor: "M", label: "M — Misto" },
];

const OPT_SETOR: OpcaoCampo[] = [
  { valor: "1", label: "1" },
  { valor: "2", label: "2" },
  { valor: "3", label: "3" },
  { valor: "4", label: "4" },
];

const OPT_CONT_ACIO: OpcaoCampo[] = [
  { valor: "1", label: "1" },
  { valor: "2", label: "2" },
];

const numeradas = (n: number): OpcaoCampo[] =>
  Array.from({ length: n }, (_, i) => ({ valor: String(i + 1), label: String(i + 1) }));

const OPT_GRINST = numeradas(10);
const OPT_ETNIA = numeradas(6);
const OPT_CONSTI = numeradas(11);

const OPT_REL_TRAB: OpcaoCampo[] = [
  { valor: "C", label: "C" },
  { valor: "T", label: "T" },
  { valor: "E", label: "E" },
  { valor: "S", label: "S" },
  { valor: "A", label: "A" },
  { valor: "O", label: "O" },
];

/* ------------------------------------------------------------------ */
/* Campos                                                              */
/* ------------------------------------------------------------------ */

const DICA_DATA = "Data no formato AAAAMMDD (ex.: 19800120).";

export const CAMPOS: CampoForm[] = [
  /* Identificação */
  {
    path: "nrCpfCnpj",
    label: "CPF / CNPJ",
    tipo: "texto",
    secao: "identificacao",
    obrigatorio: true,
    placeholder: "só dígitos, sem máscara",
    hint: "11 dígitos = PF, 14 = PJ. A máscara é removida automaticamente.",
  },
  { path: "dsNome", label: "Nome / Razão social", tipo: "texto", secao: "identificacao" },
  { path: "dtAbert", label: "Data de abertura/cadastro", tipo: "data", secao: "identificacao", hint: DICA_DATA },
  { path: "dtValcad", label: "Validade do cadastro", tipo: "data", secao: "identificacao", hint: DICA_DATA },

  /* Endereço */
  { path: "nrCep", label: "CEP", tipo: "texto", secao: "endereco", placeholder: "só dígitos" },
  { path: "dsEnd", label: "Logradouro", tipo: "texto", secao: "endereco" },
  { path: "nrEnd", label: "Número", tipo: "texto", secao: "endereco", hint: "Trafega como texto na API." },
  { path: "dsCompl", label: "Complemento", tipo: "texto", secao: "endereco" },
  { path: "dsBairro", label: "Bairro", tipo: "texto", secao: "endereco" },
  { path: "dsCidade", label: "Cidade", tipo: "texto", secao: "endereco" },
  { path: "sgEstado", label: "UF", tipo: "texto", secao: "endereco", placeholder: "PA" },

  /* Contato */
  { path: "nrDDD", label: "DDD (fixo)", tipo: "numero", secao: "contato" },
  { path: "nrTel", label: "Telefone fixo", tipo: "numero", secao: "contato" },
  { path: "nrDDDCel", label: "DDD (celular)", tipo: "numero", secao: "contato" },
  { path: "nrCel", label: "Celular", tipo: "numero", secao: "contato" },
  { path: "dsEmail", label: "E-mail", tipo: "texto", secao: "contato" },

  /* PF */
  { path: "dadosPf.dtNasc", label: "Data de nascimento", tipo: "data", secao: "pf", aplica: "PF", hint: DICA_DATA },
  { path: "dadosPf.tpSexo", label: "Sexo", tipo: "select", secao: "pf", aplica: "PF", opcoes: OPT_SEXO },
  {
    path: "dadosPf.cdProf",
    label: "Código da profissão",
    tipo: "numero",
    secao: "pf",
    aplica: "PF",
    hint: "Tabela fixa da Sinqia. 4 e 7 são recusados; a tabela completa ainda não foi fornecida.",
  },
  { path: "dadosPf.tpDoc", label: "Tipo de documento", tipo: "numero", secao: "pf", aplica: "PF" },
  { path: "dadosPf.nrDoc", label: "Número do documento", tipo: "texto", secao: "pf", aplica: "PF" },
  { path: "dadosPf.sgEmissor", label: "Órgão emissor", tipo: "texto", secao: "pf", aplica: "PF", placeholder: "SSP" },
  { path: "dadosPf.dtEmissao", label: "Data de emissão", tipo: "data", secao: "pf", aplica: "PF", hint: DICA_DATA },
  { path: "dadosPf.sgEstadoNat", label: "UF de naturalidade", tipo: "texto", secao: "pf", aplica: "PF" },
  { path: "dadosPf.cdEstCivil", label: "Estado civil (código)", tipo: "numero", secao: "pf", aplica: "PF" },
  {
    path: "dadosPf.idUniao",
    label: "União estável",
    tipo: "select",
    secao: "pf",
    aplica: "PF",
    opcoes: OPT_UNIAO,
    hint: "A Sinqia aceita só 1 (Sim) ou 2 (Não).",
  },
  { path: "dadosPf.nomeMae", label: "Nome da mãe", tipo: "texto", secao: "pf", aplica: "PF" },
  { path: "dadosPf.nomePai", label: "Nome do pai", tipo: "texto", secao: "pf", aplica: "PF" },
  { path: "dadosPf.naturalidade", label: "Naturalidade (código IBGE)", tipo: "numero", secao: "pf", aplica: "PF" },
  { path: "dadosPf.nomeCidadeNaturalidade", label: "Cidade de naturalidade", tipo: "texto", secao: "pf", aplica: "PF" },
  { path: "dadosPf.nacionalidade", label: "Nacionalidade (código)", tipo: "numero", secao: "pf", aplica: "PF" },
  { path: "dadosPf.idGrinst", label: "Grau de instrução", tipo: "select", secao: "pf", aplica: "PF", opcoes: OPT_GRINST },
  { path: "dadosPf.idEtnia", label: "Etnia", tipo: "select", secao: "pf", aplica: "PF", opcoes: OPT_ETNIA },
  { path: "dadosPf.nrDepend", label: "Nº de dependentes", tipo: "numero", secao: "pf", aplica: "PF" },
  { path: "dadosPf.idLe6515", label: "Lei 6.515", tipo: "select", secao: "pf", aplica: "PF", opcoes: OPT_SN },
  { path: "dadosPf.cdPais", label: "País (código)", tipo: "numero", secao: "pf", aplica: "PF" },

  /* PJ */
  { path: "dadosPj.nomeFantasia", label: "Nome fantasia", tipo: "texto", secao: "pj", aplica: "PJ" },
  { path: "dadosPj.dtAberturaEmpresa", label: "Data de abertura da empresa", tipo: "data", secao: "pj", aplica: "PJ", hint: DICA_DATA },
  { path: "dadosPj.cdCapital", label: "Capital", tipo: "select", secao: "pj", aplica: "PJ", opcoes: OPT_CAPITAL },
  { path: "dadosPj.cdSetor", label: "Setor", tipo: "select", secao: "pj", aplica: "PJ", opcoes: OPT_SETOR },
  { path: "dadosPj.idConsti", label: "Constituição", tipo: "select", secao: "pj", aplica: "PJ", opcoes: OPT_CONSTI },
  { path: "dadosPj.idContAcio", label: "Controle acionário", tipo: "select", secao: "pj", aplica: "PJ", opcoes: OPT_CONT_ACIO },
  { path: "dadosPj.cdTribute", label: "Tributação (código)", tipo: "numero", secao: "pj", aplica: "PJ" },
  { path: "dadosPj.cdPorte", label: "Porte (código)", tipo: "numero", secao: "pj", aplica: "PJ" },
  { path: "dadosPj.amFatMes", label: "Ano/mês do faturamento", tipo: "numero", secao: "pj", aplica: "PJ" },
  { path: "dadosPj.vlFatMes", label: "Faturamento mensal", tipo: "decimal", secao: "pj", aplica: "PJ" },
  { path: "dadosPj.qtFuncio", label: "Nº de funcionários", tipo: "numero", secao: "pj", aplica: "PJ" },
  { path: "dadosPj.qtFiliais", label: "Nº de filiais", tipo: "numero", secao: "pj", aplica: "PJ" },
  { path: "dadosPj.nrInscEst", label: "Inscrição estadual", tipo: "texto", secao: "pj", aplica: "PJ" },
  { path: "dadosPj.nrInscMun", label: "Inscrição municipal", tipo: "texto", secao: "pj", aplica: "PJ" },
  { path: "dadosPj.nrNire", label: "NIRE", tipo: "texto", secao: "pj", aplica: "PJ" },

  /* Profissionais */
  {
    path: "dadosProfissionais.cdProf",
    label: "Código da profissão",
    tipo: "numero",
    secao: "profissionais",
    hint: "Mesma tabela do cdProf de PF — 4 e 7 são recusados.",
  },
  { path: "dadosProfissionais.dsCargo", label: "Cargo", tipo: "texto", secao: "profissionais" },
  { path: "dadosProfissionais.dsEmpres", label: "Empresa", tipo: "texto", secao: "profissionais" },
  { path: "dadosProfissionais.dtAdmis", label: "Data de admissão", tipo: "data", secao: "profissionais", hint: DICA_DATA },
  { path: "dadosProfissionais.vlRendaBruta", label: "Renda bruta", tipo: "decimal", secao: "profissionais" },
  { path: "dadosProfissionais.vlRendaLiquida", label: "Renda líquida", tipo: "decimal", secao: "profissionais" },
  { path: "dadosProfissionais.tpRelacaoTrab", label: "Relação de trabalho", tipo: "select", secao: "profissionais", opcoes: OPT_REL_TRAB },
  { path: "dadosProfissionais.cdPorte", label: "Porte (código)", tipo: "numero", secao: "profissionais" },
  { path: "dadosProfissionais.cdLoctb", label: "Local de trabalho (código)", tipo: "numero", secao: "profissionais" },
  { path: "dadosProfissionais.cdPais", label: "País (código)", tipo: "numero", secao: "profissionais" },
  { path: "dadosProfissionais.nrCep", label: "CEP (trabalho)", tipo: "texto", secao: "profissionais" },
  { path: "dadosProfissionais.nmEnd", label: "Logradouro (trabalho)", tipo: "texto", secao: "profissionais" },
  { path: "dadosProfissionais.nrEnd", label: "Número (trabalho)", tipo: "texto", secao: "profissionais" },
  { path: "dadosProfissionais.nmBairro", label: "Bairro (trabalho)", tipo: "texto", secao: "profissionais" },
  { path: "dadosProfissionais.nmCidade", label: "Cidade (trabalho)", tipo: "texto", secao: "profissionais" },
  { path: "dadosProfissionais.sgEstado", label: "UF (trabalho)", tipo: "texto", secao: "profissionais" },

  /* Bancários */
  { path: "dadosBancarios[0].nrBanco", label: "Banco", tipo: "numero", secao: "bancarios" },
  { path: "dadosBancarios[0].nrAgencia", label: "Agência", tipo: "numero", secao: "bancarios" },
  { path: "dadosBancarios[0].nrConta", label: "Conta", tipo: "texto", secao: "bancarios", hint: "Trafega como texto." },
  { path: "dadosBancarios[0].dvConta", label: "Dígito", tipo: "texto", secao: "bancarios" },
  { path: "dadosBancarios[0].idPrincipal", label: "Conta principal", tipo: "select", secao: "bancarios", opcoes: OPT_SN },
  { path: "dadosBancarios[0].dtAbert", label: "Abertura da conta", tipo: "data", secao: "bancarios", hint: DICA_DATA },

  /* Imóvel */
  { path: "bensImoveis[0].nmImovel", label: "Descrição do imóvel", tipo: "texto", secao: "imovel", placeholder: "Casa" },
  { path: "bensImoveis[0].tpImovel", label: "Tipo do imóvel", tipo: "texto", secao: "imovel", hint: "Código que trafega como texto." },
  { path: "bensImoveis[0].vlImovel", label: "Valor do imóvel", tipo: "decimal", secao: "imovel" },
  { path: "bensImoveis[0].nrCep", label: "CEP do imóvel", tipo: "texto", secao: "imovel" },
  { path: "bensImoveis[0].nmEnd", label: "Logradouro do imóvel", tipo: "texto", secao: "imovel" },
  { path: "bensImoveis[0].nrEnd", label: "Número do imóvel", tipo: "texto", secao: "imovel" },
  { path: "bensImoveis[0].nmBairro", label: "Bairro do imóvel", tipo: "texto", secao: "imovel" },
  { path: "bensImoveis[0].nmCidade", label: "Cidade do imóvel", tipo: "texto", secao: "imovel" },
  { path: "bensImoveis[0].sgEstado", label: "UF do imóvel", tipo: "texto", secao: "imovel" },
  { path: "bensImoveis[0].cdPais", label: "País do imóvel (código)", tipo: "numero", secao: "imovel" },

  /* Referência */
  { path: "refPessoais[0].nome", label: "Nome da referência", tipo: "texto", secao: "referencia" },
  { path: "refPessoais[0].nrDDDTel", label: "DDD da referência", tipo: "numero", secao: "referencia" },
  { path: "refPessoais[0].nrTel", label: "Telefone da referência", tipo: "numero", secao: "referencia" },

  /* Classificação */
  { path: "cdPess", label: "Tipo de pessoa (cdPess)", tipo: "numero", secao: "classificacao" },
  { path: "cdSituac", label: "Situação (código)", tipo: "numero", secao: "classificacao" },
  { path: "dsSituac", label: "Situação (descrição)", tipo: "texto", secao: "classificacao" },
  { path: "cdAtvCl", label: "Atividade do cliente", tipo: "numero", secao: "classificacao" },
  { path: "cdAutscr", label: "Autoriza SCR", tipo: "select", secao: "classificacao", opcoes: OPT_SN },
  { path: "cdGrupo", label: "Grupo", tipo: "numero", secao: "classificacao" },
  { path: "cdPais", label: "País (código)", tipo: "numero", secao: "classificacao" },
  { path: "cdRamoAtiv", label: "Ramo de atividade", tipo: "numero", secao: "classificacao" },
  { path: "tpEnd", label: "Tipo de endereço", tipo: "numero", secao: "classificacao" },
  { path: "tpResid", label: "Tipo de residência", tipo: "numero", secao: "classificacao" },
  { path: "idLgpd", label: "LGPD", tipo: "texto", secao: "classificacao" },
];

/* ------------------------------------------------------------------ */
/* Campos obrigatórios vindos da Sinqia                                */
/* ------------------------------------------------------------------ */

export interface CamposObrigatorios {
  /** Caminhos achatados exigidos pela Sinqia (ex.: "dadosPf.dtNasc"). */
  paths: string[];
  /**
   * Formato reconhecido na resposta. "desconhecido" = a resposta veio, mas em
   * forma que não soubemos interpretar — a UI mostra o JSON cru nesse caso.
   */
  formato: "lista-strings" | "lista-objetos" | "modelo-cliente" | "desconhecido";
}

/** Achata `{cliente:{dadosPf:{dtNasc:0}}}` em ["dadosPf.dtNasc", ...]. */
function achatarChaves(obj: unknown, prefixo = "", saida: string[] = []): string[] {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return saida;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const path = prefixo ? `${prefixo}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      achatarChaves(v, path, saida);
    } else {
      saida.push(path);
    }
  }
  return saida;
}

/**
 * Normaliza a resposta de `consultarCamposObrigatorios`.
 *
 * O Swagger declara como resposta o MODELO COMPLETO do cliente, o que não diz
 * qual é a semântica em runtime. Então aceitamos as formas plausíveis e, quando
 * nada casa, devolvemos "desconhecido" — a tela mostra o JSON cru para o
 * operador (e para nós) descobrirmos o formato de verdade sem chutar.
 */
export function normalizeCamposObrigatorios(body: unknown): CamposObrigatorios {
  const vazio: CamposObrigatorios = { paths: [], formato: "desconhecido" };
  if (!body || typeof body !== "object") return vazio;

  const root = body as Record<string, unknown>;

  // Desembrulha envelope/wrappers comuns antes de decidir.
  const candidatos: unknown[] = [root];
  for (const k of ["data", "result", "campos", "camposObrigatorios", "content", "payload"]) {
    if (root[k] !== undefined) candidatos.push(root[k]);
  }

  for (const c of candidatos) {
    if (Array.isArray(c) && c.length > 0) {
      // ["dsNome", "nrCpfCnpj"]
      if (c.every((x) => typeof x === "string")) {
        return { paths: c as string[], formato: "lista-strings" };
      }
      // [{campo:"dsNome", obrigatorio:true}]
      if (c.every((x) => x && typeof x === "object")) {
        const paths: string[] = [];
        for (const item of c as Record<string, unknown>[]) {
          const nome = item.campo ?? item.nome ?? item.path ?? item.field ?? item.atributo;
          const obrig = item.obrigatorio ?? item.required ?? item.idObrigatorio;
          const exigido =
            obrig === undefined || obrig === true || obrig === "S" || obrig === 1 || obrig === "true";
          if (typeof nome === "string" && exigido) paths.push(nome);
        }
        if (paths.length > 0) return { paths, formato: "lista-objetos" };
      }
    }
  }

  // Modelo do cliente: as chaves presentes indicam os campos exigidos.
  const cliente = root.cliente ?? root;
  const paths = achatarChaves(cliente);
  if (paths.length > 0) return { paths, formato: "modelo-cliente" };

  return vazio;
}

/** Detecta PF/PJ pelo que está digitado no campo de documento. */
export function tipoPorDocumento(doc: string): "PF" | "PJ" | "?" {
  const d = (doc ?? "").replace(/\D/g, "");
  if (d.length === 11) return "PF";
  if (d.length === 14) return "PJ";
  return "?";
}

/**
 * Campos visíveis para o tipo detectado.
 *
 * Enquanto o documento está incompleto ("?"), esconde os blocos PF e PJ: mostrar
 * os dois convidaria a preencher ambos, e o schema rejeita cadastro com
 * `dadosPf` e `dadosPj` juntos.
 */
export function camposVisiveis(tipo: "PF" | "PJ" | "?"): CampoForm[] {
  return CAMPOS.filter((c) => !c.aplica || c.aplica === tipo);
}

export function secoesVisiveis(tipo: "PF" | "PJ" | "?"): SecaoForm[] {
  return SECOES.filter((s) => !s.aplica || s.aplica === tipo);
}
