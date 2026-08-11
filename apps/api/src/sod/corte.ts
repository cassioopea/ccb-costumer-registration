import type { FastifyReply } from "fastify";
import { ROTULO_TIPO_ACAO, type TipoAcaoSod } from "@cadastro-lote/shared";
import { aprovacaoAtiva, type AprovacaoAtivaFn } from "./flags.js";

/**
 * Esteira de Aprovação (SoD) — CORTE centralizado da execução direta (US-05,
 * RN01): com a flag de um tipo ativa, NENHUMA rota do BFF executa aquela ação
 * diretamente na Sinqia, para nenhum usuário.
 *
 * Como usar (contrato para a Onda 2): TODA rota que executa uma ação sensível
 * na Sinqia chama `guardarExecucaoDireta(tipo, reply)` IMEDIATAMENTE antes do
 * bloco de execução direta — depois do desvio para requisição, se a rota o
 * tiver. Nas rotas da Onda 1 o desvio (flag ativa → cria requisição) atende a
 * UI primeiro; o guard é a barreira à prova de esquecimento: rota futura sem
 * desvio, ou flag ativada entre as duas leituras, morre aqui com o erro
 * estável — zero efeitos colaterais, zero chamadas à Sinqia.
 */

/** Código estável do erro de corte — o front e integrações tratam por ele. */
export const CODIGO_CORTE_SOD = "ACAO_SOB_APROVACAO";

/** Resposta padrão do corte: 409 + código próprio + orientação de requisição. */
export function responderCorteSod(reply: FastifyReply, tipo: TipoAcaoSod): FastifyReply {
  return reply.code(409).send({
    error:
      `${ROTULO_TIPO_ACAO[tipo]}: ação sob aprovação obrigatória (SoD) — crie uma ` +
      `requisição para um segundo operador decidir; a execução direta está desativada.`,
    code: CODIGO_CORTE_SOD,
    tipo,
  });
}

/**
 * Verifica a flag do tipo ANTES de qualquer chamada Sinqia. Devolve true se o
 * corte respondeu (flag ativa) — a rota DEVE retornar imediatamente sem tocar
 * a Sinqia. False = flag inativa, fluxo direto liberado.
 */
export function guardarExecucaoDireta(
  tipo: TipoAcaoSod,
  reply: FastifyReply,
  aprovacaoAtivaFn: AprovacaoAtivaFn = aprovacaoAtiva,
): boolean {
  if (!aprovacaoAtivaFn(tipo)) return false;
  responderCorteSod(reply, tipo);
  return true;
}
