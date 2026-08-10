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
        titulo: "Fluxo: onde cada proposta está agora",
        texto:
          "A camada operacional responde “o que está no fluxo hoje”: ativas, aguardando " +
          "ação humana, atrasadas acima do SLA e concluídas. É a leitura que antes exigia " +
          "varrer o Portal fila por fila.",
      },
      {
        id: "inicio-gargalos",
        destino: DESTINO.inicio,
        seletor: "inicio-gargalos",
        titulo: "Onde está travando",
        texto:
          "As etapas ordenadas por tamanho de fila, com o ⚠ marcando quantas passaram das " +
          "72 h. Clique numa barra e o Painel abre já naquela fila, com o convênio filtrado " +
          "junto — do diagnóstico à ação em um clique.",
        lado: "left",
      },
      {
        id: "inicio-filtro-convenio",
        destino: DESTINO.inicio,
        seletor: "inicio-filtro-convenio",
        titulo: "Um filtro governa as quatro camadas",
        texto:
          "O convênio escolhido vale para números, gráficos e funil ao mesmo tempo — " +
          "acompanhar um originador específico deixa de ser um relatório à parte. O botão " +
          "ao lado recarrega ignorando o cache.",
        lado: "bottom",
        padding: 4,
        raio: 12,
      },
      {
        id: "inicio-valor",
        destino: DESTINO.inicio,
        seletor: "inicio-valor",
        titulo: "Valor: quanto a esteira originou",
        texto:
          "Contratos efetivados no mês, comparação com o mês anterior e ticket médio com " +
          "mediana ao lado. O líquido liberado só existe para o que foi criado aqui — a " +
          "cobertura fica à vista para o número nunca ser lido como maior do que é.",
      },
      {
        id: "inicio-velocidade",
        destino: DESTINO.inicio,
        seletor: "inicio-velocidade",
        titulo: "Velocidade: fila é uma coisa, duração é outra",
        texto:
          "Tempo de ciclo da criação ao contrato e quanto cada etapa consome, em média. " +
          "“Onde está travando” mostra quantas propostas estão paradas; aqui é o tempo que " +
          "a etapa custa. Juntas, as duas dizem se o gargalo é volume ou processo.",
      },
      {
        id: "inicio-funil",
        destino: DESTINO.inicio,
        seletor: "inicio-funil",
        titulo: "Conversão: onde o negócio se perde",
        texto:
          "Da persona tomadora ao contrato, com a passagem de cada degrau e a maior perda " +
          "em destaque. O primeiro degrau conta quem está marcado como tomador na Base — " +
          "nem todo cliente é, de fato, um tomador.",
      },
    ],
  },
  {
    id: "tomadores",
    titulo: "Tomadores",
    resumo: "Consultar, editar, alterar situação e cadastrar — um a um ou por arquivo.",
    passos: [
      {
        id: "tomadores-filtro",
        destino: DESTINO.tomadores,
        seletor: "tomadores-filtro",
        titulo: "A base inteira, busca instantânea",
        texto:
          "A base carrega sozinha ao abrir. Digite número, nome ou CPF/CNPJ, com ou sem " +
          "máscara: o número casa exato, nome e documento casam por parte do texto. O " +
          "filtro é local — responde enquanto você digita, sem nova ida à Sinqia.",
        lado: "bottom",
      },
      {
        id: "tomadores-selecao",
        destino: DESTINO.tomadores,
        seletor: "tomadores-selecao",
        titulo: "Selecione os filtrados, não só os visíveis",
        texto:
          "A tabela desenha até 200 linhas, mas este botão marca todos os resultados do " +
          "filtro — inclusive os que não aparecem. É o que torna a ação em massa viável em " +
          "base grande. Antes dele, os chips PF/PJ recarregam a base já filtrada na Sinqia.",
        aoFaltar: "centralizar",
        textoSemAlvo:
          "Com a base carregada, um botão acima da tabela marca todos os resultados do " +
          "filtro — inclusive os que não aparecem, já que a tabela desenha até 200 linhas. " +
          "É o que torna a ação em massa viável em base grande.",
      },
      {
        id: "tomadores-alterar-situacao",
        destino: DESTINO.tomadores,
        seletor: "tomadores-alterar-situacao",
        titulo: "Alterar situação em massa",
        texto:
          "Ativar ou inativar vários tomadores de uma vez, com a lista à vista antes de " +
          "confirmar. Em produção o botão da modal só libera depois que você digita " +
          "ALTERAR — atrito proposital numa ação irreversível.",
        lado: "bottom",
        padding: 4,
        raio: 12,
      },
      {
        id: "tomadores-propostas",
        destino: DESTINO.tomadores,
        seletor: "tomadores-btn-propostas",
        titulo: "As propostas do tomador, sem sair da tela",
        texto:
          "Consulta somente leitura das propostas daquele tomador na Sinqia. Em “Ver dados” " +
          "abrem-se os dados completos e o plano de parcelas — suficiente para responder ao " +
          "originador na hora, sem abrir o Portal.",
        lado: "left",
        padding: 4,
        raio: 10,
        aoFaltar: "centralizar",
        textoSemAlvo:
          "Cada linha da base tem um botão “Propostas”: consulta somente leitura das " +
          "propostas daquele tomador na Sinqia, com “Ver dados” abrindo os dados completos " +
          "e o plano de parcelas.",
      },
      {
        id: "tomadores-editar",
        destino: DESTINO.tomadores,
        seletor: "tomadores-btn-editar",
        titulo: "Editar completa o que falta",
        texto:
          "Abre o cadastro já preenchido, com a ação AL (alterar) armada. Serve para " +
          "completar um cadastro incompleto sem recriar o tomador — e sem risco de duplicar " +
          "quem já existe na Sinqia.",
        lado: "left",
        padding: 4,
        raio: 10,
        aoFaltar: "centralizar",
        textoSemAlvo:
          "Cada linha da base tem “Editar”: abre o cadastro já preenchido, com a ação AL " +
          "(alterar) armada — completa um cadastro incompleto sem recriar o tomador.",
      },
      {
        id: "cadastro-obrigatorios",
        destino: DESTINO.cadastroIndividual,
        seletor: "cadastro-obrigatorios",
        titulo: "Os obrigatórios vêm da Sinqia",
        texto:
          "A ferramenta pergunta à Sinqia o que ESTE ambiente exige e marca os campos com " +
          "asterisco no formulário. O cadastro é aceito incompleto, com avisos — mas " +
          "completar aqui evita retrabalho lá na frente, no Motor de Crédito.",
      },
      {
        id: "cadastro-controles",
        destino: DESTINO.cadastroIndividual,
        seletor: "cadastro-controles",
        titulo: "Controles do cadastro",
        texto:
          "step FI finaliza e envia ao Motor de Crédito; idAcao define incluir, alterar ou " +
          "excluir. São os parâmetros que o Portal esconde — aqui ficam explícitos, " +
          "conferíveis e registrados. Os botões de exemplo PF/PJ preenchem tudo para testar.",
      },
      {
        id: "cadastro-lote",
        destino: DESTINO.cadastroLote,
        seletor: "cadastro-lote-upload",
        titulo: "Em lote: mesma rota, por arquivo",
        texto:
          "CSV ou JSON, com template para baixar. Mesma rota e mesma validação do cadastro " +
          "individual — o que muda é o volume. Validar antes mostra os erros linha a linha, " +
          "sem enviar nada à Sinqia.",
      },
    ],
  },
  {
    id: "propostas",
    titulo: "Propostas",
    resumo: "A esteira fila a fila, movimentação e criação em lote ou avulsa.",
    passos: [
      {
        id: "painel-esteira",
        destino: DESTINO.painel,
        seletor: "painel-esteira",
        titulo: "Cada etapa vira uma fila",
        texto:
          "O workflow inteiro em uma faixa, com a contagem de cada etapa. Etapas vazias — " +
          "inclusive as de passagem automática — ficam ocultas, para a tela mostrar só o que " +
          "existe. Clique numa etapa para abrir a fila dela.",
      },
      {
        id: "painel-fila",
        destino: DESTINO.painel,
        seletor: "painel-fila",
        titulo: "A fila, agrupada por convênio",
        texto:
          "Dentro da etapa, as propostas vêm agrupadas por convênio, com total e soma de " +
          "valor por grupo — a leitura que o originador cobra. Os filtros ficam recolhidos " +
          "para a tabela ser a protagonista, e “Exportar CSV” baixa a fila como está na tela.",
        acao: "painel.selecionarPrimeiraFila",
      },
      {
        id: "painel-sla",
        destino: DESTINO.painel,
        seletor: "painel-sla",
        titulo: "SLA e histórico, linha a linha",
        texto:
          "Há quanto tempo a proposta está parada NESTA etapa: horas até 72 h, dias depois. " +
          "É o mesmo número que vira “atrasadas” no dashboard. Ao lado, o histórico abre as " +
          "transições da proposta sem precisar do Portal.",
        acao: "painel.selecionarPrimeiraFila",
        lado: "bottom",
        padding: 4,
        raio: 8,
      },
      {
        id: "painel-mover",
        destino: DESTINO.painel,
        seletor: "painel-mover-linha",
        titulo: "Mover: uma proposta ou a seleção inteira",
        texto:
          "Aqui você move uma proposta; marcando várias, o botão “Mover selecionadas” leva " +
          "todas para a mesma etapa. Os destinos são revalidados na Sinqia, e a observação é " +
          "obrigatória — ela entra no histórico de TODAS as propostas movidas.",
        acao: "painel.selecionarPrimeiraFila",
        lado: "left",
        padding: 4,
        raio: 10,
        aoFaltar: "centralizar",
        textoSemAlvo:
          "Na fila, cada linha tem o gesto de mover, e marcando várias o botão “Mover " +
          "selecionadas” leva todas para a mesma etapa. Os destinos são revalidados na " +
          "Sinqia, e a observação é obrigatória — entra no histórico de todas as propostas.",
      },
      {
        id: "lote-pipeline",
        destino: DESTINO.lotePropostas,
        seletor: "lote-pipeline",
        titulo: "Lote de propostas: quatro passos",
        texto:
          "Carregar o Emissoes, verificar os clientes, calcular e conferir, criar. O " +
          "indicador acompanha a fase, e você pode voltar a qualquer passo sem perder o que " +
          "já fez — não é um assistente que prende.",
        lado: "bottom",
        padding: 4,
        raio: 12,
      },
      {
        id: "lote-resumo",
        destino: DESTINO.lotePropostas,
        seletor: "lote-resumo",
        titulo: "O cálculo não grava nada",
        texto:
          "O cálculo devolve parcela, CET e IOF para conferência contra a planilha SEM " +
          "gravar na Sinqia — só a criação escreve. Produto, convênio e loja vêm das listas " +
          "da Sinqia; taxa e data valem para o arquivo todo. É o passo que mais reduz tempo " +
          "frente ao Portal manual.",
        lado: "top",
        padding: 4,
        raio: 14,
        // O resumo vivo só existe com uma planilha carregada.
        aoFaltar: "centralizar",
        textoSemAlvo:
          "Depois de carregar a planilha, uma barra fixa no rodapé consolida o que será " +
          "gravado e carrega a ação da fase. O cálculo devolve parcela, CET e IOF para " +
          "conferência SEM gravar na Sinqia — só a criação escreve. É o passo que mais " +
          "reduz tempo frente ao Portal manual.",
      },
      {
        id: "proposta-individual",
        destino: DESTINO.propostaIndividual,
        seletor: "individual-cliente",
        titulo: "Proposta individual: o mesmo motor",
        texto:
          "Para casos avulsos: busca o tomador, monta a operação, calcula, confere e cria " +
          "uma proposta só. O líquido é o que o tomador recebe; TAC e seguro são financiados " +
          "por cima dele. Mesmas travas do lote, sem planilha.",
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
