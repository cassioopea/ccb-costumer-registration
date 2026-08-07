import type { FilaWf } from "./api";

/**
 * Taxonomia SEMÂNTICA das etapas do workflow — o dashboard lê por categoria,
 * não por status técnico. Poucas categorias, cada uma com cor fixa de estado
 * e definição de uma linha (padrão aprendido da esteira de referência).
 *
 * O mapa por código cobre o workflow Opea conhecido (e-mail "Fluxo Workflow",
 * promovido a PROD em 2026-08-06); o fallback por palavra-chave garante que
 * etapas novas ganhem uma categoria razoável sem mudança de código.
 */

export type CategoriaEtapa =
  | "andamento"
  | "aguardando"
  | "atencao"
  | "concluida"
  | "negada"
  | "cancelada";

export interface CategoriaInfo {
  label: string;
  definicao: string;
  /**
   * Cor de ESTADO (CSS var) — a MESMA em todos os lugares: donut, barras,
   * cartões da esteira, pílula de status e histórico.
   */
  cor: string;
  /** Cor do texto sobre `cor` (para pílulas/preenchimentos). */
  corTexto: string;
}

export const CATEGORIAS: Record<CategoriaEtapa, CategoriaInfo> = {
  andamento: {
    label: "Em andamento",
    definicao: "Etapas de passagem — o motor avança sozinho.",
    cor: "var(--info)",
    corTexto: "var(--info-foreground)",
  },
  aguardando: {
    label: "Aguardando ação",
    definicao: "Paradas à espera de alguém: formalização, assinatura ou desembolso.",
    cor: "var(--warning)",
    corTexto: "var(--warning-foreground)",
  },
  atencao: {
    label: "Requer atenção",
    definicao: "Risco apontado ou documentos pendentes.",
    cor: "var(--laranja-500)",
    corTexto: "#491b12", // laranja-900 da paleta Opea
  },
  concluida: {
    label: "Concluídas",
    definicao: "Contrato finalizado no portal.",
    cor: "var(--success)",
    corTexto: "var(--success-foreground)",
  },
  negada: {
    label: "Negadas",
    definicao: "Reprovadas na análise de crédito.",
    cor: "var(--destructive)",
    corTexto: "var(--destructive-foreground)",
  },
  cancelada: {
    label: "Canceladas",
    definicao: "Encerradas antes da conclusão.",
    cor: "var(--muted-foreground)",
    corTexto: "oklch(0.99 0 0)",
  },
};

/** Ordem de exibição nas legendas/gráficos. */
export const ORDEM_CATEGORIAS: CategoriaEtapa[] = [
  "andamento",
  "aguardando",
  "atencao",
  "concluida",
  "negada",
  "cancelada",
];

const POR_CODIGO: Record<number, CategoriaEtapa> = {
  20005: "andamento", // Início de operação
  20010: "andamento", // Simulação
  20013: "andamento", // Aprovada (Ibratan) — transita
  20015: "andamento", // Formalização
  20040: "andamento", // Operação para despacho
  20051: "andamento", // Contrato Assinado — o motor encadeia sozinho
  20016: "aguardando", // Finalizado Portal (aguardando formalização)
  20050: "aguardando", // Contrato em Assinatura
  20052: "aguardando", // Aprovado para Desembolso
  20020: "atencao", // Risco operação
  20030: "atencao", // Documentos pendentes
  20014: "negada", // Negada (Ibratan)
  20053: "concluida", // Contrato Finalizado no Portal
  20056: "cancelada", // Cancelado
};

export function categoriaDaEtapa(nrStatus: number | null, dsStatus: string): CategoriaEtapa {
  if (nrStatus !== null && POR_CODIGO[nrStatus]) return POR_CODIGO[nrStatus];
  const ds = dsStatus.toLowerCase();
  if (/cancelad/.test(ds)) return "cancelada";
  if (/negad|reprovad/.test(ds)) return "negada";
  if (/finalizado no portal|conclu/.test(ds)) return "concluida";
  if (/pendent|risco/.test(ds)) return "atencao";
  if (/assinatura|desembolso|formaliza/.test(ds)) return "aguardando";
  return "andamento";
}

/** Soma as contagens das filas por categoria. */
export function contagemPorCategoria(filas: FilaWf[]): Record<CategoriaEtapa, number> {
  const contagem = Object.fromEntries(
    ORDEM_CATEGORIAS.map((c) => [c, 0]),
  ) as Record<CategoriaEtapa, number>;
  for (const f of filas) {
    contagem[categoriaDaEtapa(f.nrStatus, f.dsStatus)] += f.qtFilhos;
  }
  return contagem;
}
