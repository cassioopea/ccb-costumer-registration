import type { TipoAcaoSod } from "@cadastro-lote/shared";
import { sodServicoPadrao } from "./rotas.js";

/**
 * Esteira de Aprovação (SoD) — feature flags DEFINITIVAS por tipo de ação
 * (US-05, RN02). Fonte única: tabela `sod_flags` (mesmo banco/repositório da
 * esteira), lida em RUNTIME — mudança vale na requisição seguinte, sem
 * restart, e sobrevive a reinício por ser persistida. Ausência de registro =
 * INATIVA (RN07: estado padrão). O env provisório das US-02/US-04
 * (APROVACAO_*) foi REMOVIDO — não há segundo caminho de configuração.
 *
 * Mudança operacional (RN03: sem tela) somente pelo CLI auditado:
 *   npm run sod:flag -- <tipo> <on|off> --por <login>
 */

/**
 * Tipos com flag NESTA fase (Onda 1). A Onda 2 acrescenta os seus aqui ao
 * entregar cada história — tipo fora desta lista NUNCA é considerado sob
 * aprovação, mesmo que alguém insira linha na tabela (ações da Onda 2
 * permanecem intocadas até a US correspondente).
 */
export const TIPOS_COM_FLAG: readonly TipoAcaoSod[] = [
  "tomador.cadastrar", // US-02/US-05
  "proposta.criar", // US-04/US-05
  "tomador.cadastrar_lote", // US-06
  "proposta.criar_lote", // US-07
  "proposta.movimentar", // US-08
];

/** Nome de negócio da configuração de cada tipo (documentação, logs e CLI). */
export const CHAVE_APROVACAO: Partial<Record<TipoAcaoSod, string>> = {
  "tomador.cadastrar": "aprovacao.cadastro_tomador_individual",
  "proposta.criar": "aprovacao.criacao_proposta_individual",
  "tomador.cadastrar_lote": "aprovacao.cadastro_tomador_lote",
  "proposta.criar_lote": "aprovacao.criacao_proposta_lote",
  "proposta.movimentar": "aprovacao.movimentacao_proposta",
};

/**
 * Resolve a entrada do operador (CLI) para o tipo de ação: aceita o tipo
 * (`tomador.cadastrar`) ou a chave de negócio
 * (`aprovacao.cadastro_tomador_individual`). Null = não é um tipo com flag.
 */
export function resolverTipoComFlag(entrada: string): TipoAcaoSod | null {
  const limpa = entrada.trim().toLowerCase();
  for (const tipo of TIPOS_COM_FLAG) {
    if (limpa === tipo || limpa === CHAVE_APROVACAO[tipo]) return tipo;
  }
  return null;
}

/** O tipo de ação exige aprovação (requisição) em vez do fluxo direto? */
export function aprovacaoAtiva(tipo: TipoAcaoSod): boolean {
  if (!TIPOS_COM_FLAG.includes(tipo)) return false;
  return sodServicoPadrao().flagAtiva(tipo);
}

export type AprovacaoAtivaFn = typeof aprovacaoAtiva;
