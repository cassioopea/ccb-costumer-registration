import type { TipoAcaoSod } from "@cadastro-lote/shared";
import { env } from "./../env.js";

/**
 * Esteira de Aprovação (SoD) — toggles por tipo de ação (RN05, US-02).
 *
 * Fonte na Onda 1: variável de ambiente (o único padrão de configuração do
 * repo — env.ts com zod). A US-05 troca a FONTE (flag persistida, com
 * auditoria de mudança) atrás desta mesma função — os chamadores não mudam.
 * Tipo sem chave configurada = fluxo direto (toggle inexistente ≠ ligado).
 */

/** Nome de negócio da configuração de cada tipo (documentação e logs). */
export const CHAVE_APROVACAO: Partial<Record<TipoAcaoSod, string>> = {
  "tomador.cadastrar": "aprovacao.cadastro_tomador_individual",
};

/** Valor bruto configurado para cada tipo — só os tipos já entregues entram. */
const FONTE_ENV: Partial<Record<TipoAcaoSod, () => string>> = {
  "tomador.cadastrar": () => env.APROVACAO_CADASTRO_TOMADOR_INDIVIDUAL,
};

const LIGADO = new Set(["1", "true", "on", "sim"]);

/** O tipo de ação exige aprovação (requisição) em vez do fluxo direto? */
export function aprovacaoAtiva(tipo: TipoAcaoSod): boolean {
  const bruto = FONTE_ENV[tipo]?.() ?? "";
  return LIGADO.has(bruto.trim().toLowerCase());
}

export type AprovacaoAtivaFn = typeof aprovacaoAtiva;
