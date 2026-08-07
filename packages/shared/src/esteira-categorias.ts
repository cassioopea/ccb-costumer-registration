/**
 * Taxonomia SEMÂNTICA das etapas do workflow — compartilhada entre o front
 * (cores/labels) e a API (agregações do dashboard). Poucas categorias; o mapa
 * por código cobre o workflow Opea conhecido (promovido a PROD em 2026-08-06)
 * e o fallback por palavra-chave absorve etapas novas sem mudança de código.
 */

export type CategoriaEtapa =
  | "andamento"
  | "aguardando"
  | "atencao"
  | "concluida"
  | "negada"
  | "cancelada";

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

/**
 * "Aprovada" no sentido do FUNIL: passou (pelo estado atual) do gate de
 * aprovação — Aprovado para Desembolso em diante. É uma aproximação por
 * estado corrente; o número exato exigiria o histórico de cada proposta.
 */
export function aprovadaNoFunil(nrStatus: number | null, dsStatus: string): boolean {
  const cat = categoriaDaEtapa(nrStatus, dsStatus);
  if (cat === "concluida") return true;
  if (nrStatus !== null && nrStatus >= 20051 && cat !== "cancelada" && cat !== "negada") {
    return true;
  }
  return /aprovado para desembolso|contrato assinado/i.test(dsStatus);
}
