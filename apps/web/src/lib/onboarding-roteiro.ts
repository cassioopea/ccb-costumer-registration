/**
 * Roteiro do tour, itens do checklist e hints — TUDO configurável aqui.
 * Edite os textos sem tocar na lógica (ProductTour, Checklist e Hint só leem
 * estas listas). Fio condutor: cada parada conecta a função ao GANHO DE TEMPO
 * na emissão da CCB de ponta a ponta.
 */

/** Páginas que o tour visita — o App sabe navegar até cada uma. */
export type PaginaTour =
  | "inicio"
  | "tomadores"
  | "painel-propostas"
  | "lote-propostas"
  | "proposta-individual";

export interface PassoTour {
  id: string;
  pagina: PaginaTour;
  /** `data-tour="..."` do elemento a destacar; ausente = modal centralizado. */
  seletor?: string;
  titulo: string;
  texto: string;
}

export const ROTEIRO_TOUR: PassoTour[] = [
  {
    id: "boas-vindas",
    pagina: "inicio",
    titulo: "Bem-vindo à Esteira de Originação",
    texto:
      "Em ~2 minutos mostro como a ferramenta encurta a emissão de uma CCB de ponta a " +
      "ponta — do cadastro do tomador ao contrato — comparado ao trabalho manual no " +
      "Portal de Crédito. Use Próximo/Anterior; Esc sai a qualquer momento.",
  },
  {
    id: "inicio-saude",
    pagina: "inicio",
    seletor: "inicio-saude",
    titulo: "Saúde da esteira num olhar",
    texto:
      "Aqui você vê onde cada proposta está agora, o que está travando e o que passou " +
      "do SLA. Acompanhar os gargalos evita propostas esquecidas numa fila — o que, na " +
      "prática, é tempo perdido na emissão.",
  },
  {
    id: "tomadores",
    pagina: "tomadores",
    seletor: "tomadores-tabela",
    titulo: "A base de tomadores",
    texto:
      "Consulte, edite e cadastre tomadores. O cadastro em lote (por arquivo) elimina " +
      "digitar cliente por cliente na Sinqia — o maior gargalo manual antes da proposta.",
  },
  {
    id: "painel",
    pagina: "painel-propostas",
    seletor: "painel-esteira",
    titulo: "O painel da esteira",
    texto:
      "Cada etapa do workflow vira uma fila. Você acompanha, filtra por convênio e move " +
      "propostas pela esteira — inclusive em lote — sem abrir o Portal para cada uma.",
  },
  {
    id: "lote",
    pagina: "lote-propostas",
    seletor: "lote-upload",
    titulo: "Propostas em lote — o maior ganho",
    texto:
      "Suba o Emissoes.xlsx e crie dezenas de propostas de uma vez, com cálculo e " +
      "conferência automáticos. É o passo que mais reduz tempo frente ao Portal manual.",
  },
  {
    id: "individual",
    pagina: "proposta-individual",
    seletor: "individual-cliente",
    titulo: "Proposta individual",
    texto:
      "Para casos avulsos, o mesmo motor de cálculo e as mesmas travas — busca o " +
      "tomador, calcula, confere e cria uma proposta só, sem planilha.",
  },
];

/** Itens do checklist de primeiros passos (ordem = ordem exibida). */
export interface ItemChecklist {
  id: string;
  label: string;
  /** Para onde o item leva ao clicar. */
  pagina: PaginaTour;
}

export const CHECKLIST_ITENS: ItemChecklist[] = [
  { id: "ver_saude", label: "Ver a saúde da esteira", pagina: "inicio" },
  { id: "consultar_tomador", label: "Consultar um tomador", pagina: "tomadores" },
  { id: "abrir_painel", label: "Abrir o painel de propostas", pagina: "painel-propostas" },
  { id: "proposta_individual", label: "Criar uma proposta individual", pagina: "proposta-individual" },
  { id: "rodar_lote", label: "Rodar um lote de teste (HML)", pagina: "lote-propostas" },
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
};
