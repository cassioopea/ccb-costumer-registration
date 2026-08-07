import { categoriaDaEtapa, type CategoriaEtapa } from "@cadastro-lote/shared";
import type { FilaWf } from "./api";

/**
 * Camada VISUAL da taxonomia de categorias — a lógica (códigos + fallback)
 * vive no shared (a API usa a mesma para agregar o dashboard); aqui ficam as
 * cores de estado, labels e definições de uma linha.
 */

export { categoriaDaEtapa, type CategoriaEtapa };

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

/** Cores de SÉRIE para segmentar por convênio nos gráficos (não são estado). */
export const CORES_SERIES = [
  "var(--wine-500)",
  "var(--info)",
  "var(--success)",
  "var(--laranja-500)",
  "var(--warning)",
  "var(--wine-600)",
  "var(--muted-foreground)",
];
