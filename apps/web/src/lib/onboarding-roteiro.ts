/**
 * Roteiro do tour, itens do checklist e hints — TUDO configurável aqui.
 * Edite os textos sem tocar na lógica (ProductTour, Checklist e Hint só leem
 * estas listas). Fio condutor: cada parada conecta a função ao GANHO DE TEMPO,
 * à GOVERNANÇA ou à VISIBILIDADE — nunca "o que é isto".
 *
 * Estrutura: o tour é dividido em CAPÍTULOS (um por área do produto). O usuário
 * percorre tudo em sequência ou entra direto num capítulo pelo índice. Ver
 * TOUR-EXPANDIDO.md § 10 para o roteiro aprovado.
 */

/* ------------------------------------------------------------------ *
 * Destino de um passo — para onde o tour leva a UI antes de ancorar.
 * As uniões batem com TelaClientes/TelaPropostas/TelaRequisicoes do App;
 * ficam declaradas aqui para o roteiro não depender de componentes.
 * ------------------------------------------------------------------ */

export type DestinoTour =
  | { modulo: "inicio" }
  | { modulo: "clientes"; tela: "situacao" | "individual" | "cadastro" }
  | { modulo: "propostas"; tela: "painel-propostas" | "lote-propostas" | "proposta-individual" }
  | { modulo: "requisicoes"; aba: "pendencias" | "minhas" };

/** Atalhos de leitura — o roteiro fica mais curto e menos sujeito a typo. */
export const DESTINO = {
  inicio: { modulo: "inicio" },
  tomadores: { modulo: "clientes", tela: "situacao" },
  cadastroIndividual: { modulo: "clientes", tela: "individual" },
  cadastroLote: { modulo: "clientes", tela: "cadastro" },
  painel: { modulo: "propostas", tela: "painel-propostas" },
  lotePropostas: { modulo: "propostas", tela: "lote-propostas" },
  propostaIndividual: { modulo: "propostas", tela: "proposta-individual" },
  pendencias: { modulo: "requisicoes", aba: "pendencias" },
  minhasRequisicoes: { modulo: "requisicoes", aba: "minhas" },
} as const satisfies Record<string, DestinoTour>;

/* ------------------------------------------------------------------ *
 * Ações de tela — o tour NÃO reimplementa comportamento: cada tela
 * registra o que sabe fazer (useAcaoTour) e o passo apenas declara o
 * nome. Assim abrir uma modal no tour é a mesma abertura do uso real.
 * ------------------------------------------------------------------ */

export type AcaoTourNome =
  | "tomadores.abrirPropostasDoPrimeiro"
  | "tomadores.fecharPropostas"
  | "tomadores.abrirAlterarSituacao"
  | "tomadores.fecharAlterarSituacao"
  | "painel.selecionarPrimeiraFila"
  | "painel.abrirMoverLote"
  | "painel.fecharMoverLote"
  | "pendencias.abrirPrimeiraRequisicao"
  | "pendencias.fecharDetalhe";

export interface PassoTour {
  id: string;
  /** Para onde a UI vai antes de ancorar o popover. */
  destino: DestinoTour;
  /** `data-tour="..."` do elemento a destacar; ausente = card centralizado. */
  seletor?: string;
  titulo: string;
  texto: string;
  /** Executada ANTES de ancorar (abrir modal, selecionar fila, …). */
  acao?: AcaoTourNome;
  /** Executada ao SAIR do passo — desfaz o que a `acao` abriu. */
  limpar?: AcaoTourNome;
  /**
   * O que fazer quando o elemento não aparece (flag inativa, fila vazia):
   * `centralizar` mostra o passo como card central (com `textoSemAlvo`, se
   * houver); `pular` segue para o próximo. Padrão: `centralizar`.
   */
  aoFaltar?: "centralizar" | "pular";
  /** Texto alternativo quando o passo cai em `centralizar` sem alvo. */
  textoSemAlvo?: string;
  /** Lado do popover; driver.js decide sozinho quando ausente. */
  lado?: "top" | "right" | "bottom" | "left";
  /** Folga do recorte do overlay — alvos pequenos pedem menos. */
  padding?: number;
  /** Raio do recorte; o padrão é concêntrico com o card (rounded-2xl). */
  raio?: number;
}

export interface CapituloTour {
  id: string;
  titulo: string;
  /** Uma linha no índice — o que o capítulo responde. */
  resumo: string;
  passos: PassoTour[];
}

/**
 * CAPÍTULOS. Capítulo sem passos não aparece no índice nem no percurso —
 * é assim que as Fases 2 e 3 vão preenchendo o roteiro sem quebrar o tour
 * de quem já está usando.
 */
export const CAPITULOS: CapituloTour[] = [
  {
    id: "abertura",
    titulo: "Abertura",
    resumo: "O que é a Esteira e como navegar por este tour.",
    passos: [
      {
        id: "boas-vindas",
        destino: DESTINO.inicio,
        titulo: "Bem-vindo à Esteira de Originação",
        texto:
          "A Esteira automatiza a originação de CCB sobre a Sinqia — do cadastro do " +
          "tomador ao contrato, com governança no meio. Vou mostrar isso em capítulos: " +
          "faça todos em sequência ou entre direto no que interessa. ←/→ navegam, Esc sai.",
      },
    ],
  },
  {
    id: "dashboard",
    titulo: "Dashboard",
    resumo: "A saúde da originação em quatro camadas — e onde está travando.",
    passos: [
      {
        id: "inicio-saude",
        destino: DESTINO.inicio,
        seletor: "inicio-saude",
        titulo: "Saúde da esteira num olhar",
        texto:
          "Aqui você vê onde cada proposta está agora, o que está travando e o que passou " +
          "do SLA. Acompanhar os gargalos evita propostas esquecidas numa fila — o que, na " +
          "prática, é tempo perdido na emissão.",
      },
    ],
  },
  {
    id: "tomadores",
    titulo: "Tomadores",
    resumo: "Consultar, editar, alterar situação e cadastrar — um a um ou por arquivo.",
    passos: [
      {
        id: "tomadores-base",
        destino: DESTINO.tomadores,
        seletor: "tomadores-tabela",
        titulo: "A base de tomadores",
        texto:
          "Consulte, edite e cadastre tomadores. O cadastro em lote (por arquivo) elimina " +
          "digitar cliente por cliente na Sinqia — o maior gargalo manual antes da proposta.",
      },
    ],
  },
  {
    id: "propostas",
    titulo: "Propostas",
    resumo: "A esteira fila a fila, movimentação e criação em lote ou avulsa.",
    passos: [
      {
        id: "painel",
        destino: DESTINO.painel,
        seletor: "painel-esteira",
        titulo: "O painel da esteira",
        texto:
          "Cada etapa do workflow vira uma fila. Você acompanha, filtra por convênio e move " +
          "propostas pela esteira — inclusive em lote — sem abrir o Portal para cada uma.",
      },
      {
        id: "lote",
        destino: DESTINO.lotePropostas,
        seletor: "lote-upload",
        titulo: "Propostas em lote — o maior ganho",
        texto:
          "Suba o Emissoes.xlsx e crie dezenas de propostas de uma vez, com cálculo e " +
          "conferência automáticos. É o passo que mais reduz tempo frente ao Portal manual.",
      },
      {
        id: "individual",
        destino: DESTINO.propostaIndividual,
        seletor: "individual-cliente",
        titulo: "Proposta individual",
        texto:
          "Para casos avulsos, o mesmo motor de cálculo e as mesmas travas — busca o " +
          "tomador, calcula, confere e cria uma proposta só, sem planilha.",
      },
    ],
  },
  {
    id: "aprovacao",
    titulo: "Esteira de Aprovação",
    resumo: "Segregação de funções: nada sensível executa sem um segundo operador.",
    passos: [], // Fase 3
  },
  {
    id: "sessao",
    titulo: "Sessão e ambiente",
    resumo: "Onde você está, quanto tempo tem e como reabrir este tour.",
    passos: [], // Fase 3
  },
];

/** Capítulos que realmente têm conteúdo — o índice e o percurso usam esta lista. */
export const CAPITULOS_ATIVOS = CAPITULOS.filter((c) => c.passos.length > 0);

export function capituloPorId(id: string): CapituloTour | undefined {
  return CAPITULOS_ATIVOS.find((c) => c.id === id);
}

/** Total de passos do tour completo — usado no índice ("N passos"). */
export const TOTAL_PASSOS = CAPITULOS_ATIVOS.reduce((acc, c) => acc + c.passos.length, 0);

/** Itens do checklist de primeiros passos (ordem = ordem exibida). */
export interface ItemChecklist {
  id: string;
  label: string;
  /** Para onde o item leva ao clicar. */
  destino: DestinoTour;
}

export const CHECKLIST_ITENS: ItemChecklist[] = [
  { id: "ver_saude", label: "Ver a saúde da esteira", destino: DESTINO.inicio },
  { id: "consultar_tomador", label: "Consultar um tomador", destino: DESTINO.tomadores },
  { id: "abrir_painel", label: "Abrir o painel de propostas", destino: DESTINO.painel },
  {
    id: "proposta_individual",
    label: "Criar uma proposta individual",
    destino: DESTINO.propostaIndividual,
  },
  { id: "rodar_lote", label: "Rodar um lote de teste (HML)", destino: DESTINO.lotePropostas },
];

/** Hints contextuais — texto ancorado a um `data-hint`, dispensável por usuário. */
export interface HintDef {
  id: string;
  titulo: string;
  texto: string;
}

export const HINTS: Record<string, HintDef> = {
  filtro_convenio: {
    id: "filtro_convenio",
    titulo: "Filtro por convênio",
    texto:
      "Todo o dashboard (números, gráfico e funil) passa a mostrar só o convênio " +
      "escolhido — útil para acompanhar um originador específico.",
  },
  aguardando_acao: {
    id: "aguardando_acao",
    titulo: "O que é “Aguardando ação”",
    texto:
      "Propostas paradas esperando alguém: formalização, assinatura ou desembolso. " +
      "São as que dependem de um passo humano para andar.",
  },
  params_lote: {
    id: "params_lote",
    titulo: "Parâmetros do lote",
    texto:
      "Valem para todas as linhas do arquivo. Produto, convênio e loja vêm das listas " +
      "da Sinqia; a taxa e a data do contrato você define aqui.",
  },
  persona_tomador: {
    id: "persona_tomador",
    titulo: "Persona tomadora",
    texto:
      "Pessoa física entra como tomadora automaticamente; pessoa jurídica só se você " +
      "marcar aqui. É essa marcação que alimenta a contagem de tomadores no dashboard — " +
      "nem todo cliente da base é, de fato, um tomador.",
  },
  tipo_pessoa: {
    id: "tipo_pessoa",
    titulo: "Filtro por tipo de pessoa",
    texto:
      "Alterna entre PF, PJ e todos. Trocar recarrega a base já filtrada na Sinqia — " +
      "depois a busca por nome/CPF é local e instantânea.",
  },
  painel_sla: {
    id: "painel_sla",
    titulo: "SLA — tempo na etapa",
    texto:
      "Há quanto tempo a proposta está parada nesta etapa: em horas até 72h, em dias " +
      "depois. Acima de 72h ela ganha destaque — é o sinal de que precisa de ação.",
  },
  dados_operacao: {
    id: "dados_operacao",
    titulo: "Dados da operação",
    texto:
      "O valor líquido é o que o tomador recebe; TAC, seguro e outros são financiados " +
      "por cima dele. A Sinqia calcula a parcela e o CET a partir daqui.",
  },
  campos_obrigatorios: {
    id: "campos_obrigatorios",
    titulo: "Campos obrigatórios da Sinqia",
    texto:
      "Consulte o que a Sinqia exige neste ambiente — os campos retornados ficam " +
      "marcados com * no formulário. O cadastro é aceito incompleto (com avisos), mas " +
      "completar evita retrabalho depois.",
  },
  controle_idacao: {
    id: "controle_idacao",
    titulo: "Ação do cadastro (idAcao)",
    texto:
      "Define o que a Sinqia faz: incluir (novo), alterar (completar existente) ou " +
      "excluir. Em branco, a Sinqia assume inclusão. Excluir não tem desfazer pela " +
      "ferramenta — teste em HML antes.",
  },
};
