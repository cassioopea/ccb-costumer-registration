import { destroySession } from "./../session.js";
import type { ItemLoteSod, RequisicaoSod } from "./repositorio.js";
import type { SodServico } from "./dominio.js";
import {
  EXECUTORES,
  falhaExecucao,
  type ContextoExecucao,
  type ExecucaoDeps,
} from "./execucao.js";
import { TIPO_ITEM_DO_LOTE, type TipoAcaoSod } from "@cadastro-lote/shared";

/**
 * Esteira de Aprovação (SoD) — execução SEQUENCIAL de requisição-LOTE (US-06).
 *
 * Mesmo padrão do lote direto (batch.ts): a rota de decisão dispara o
 * processamento sem await e responde já — o token do APROVADOR (B2') vive só
 * no closure. A diferença: aqui TODO estado é persistido (itens no banco), e
 * o progresso é consultado por polling do detalhe — nada em memória além do
 * registro de execuções em andamento.
 *
 * Garantias por item:
 *  - reivindicação ATÔMICA `pendente → aprovada/executando` antes de qualquer
 *    chamada Sinqia (RN05: reexecução forçada nunca duplica);
 *  - executor do TIPO INDIVIDUAL do item (registro EXECUTORES da US-03/04) —
 *    nenhum segundo caminho de chamada Sinqia;
 *  - falha de um item NÃO interrompe os demais (RN04);
 *  - sessão expirada (401) ou erro inesperado INTERROMPE: o item corrente vira
 *    `falha` e os restantes caem em `falha` com a causa (Cenário 4);
 *  - ao fim, o estado do lote é DERIVADO do placar (RN01).
 */

/** Causa registrada nos itens que a interrupção deixou para trás. */
export const CAUSA_LOTE_INTERROMPIDO = "lote_interrompido";

/**
 * Causa da proposta cujo tomador vinculado não chegou a `executada`
 * (US-07, Cenário 3) — zero chamadas Sinqia para ela.
 */
export const CAUSA_TOMADOR_NAO_CRIADO = "tomador_nao_criado";

const MENSAGEM_INTERROMPIDO =
  "A execução do lote foi interrompida antes deste item — nada foi enviado à Sinqia para ele.";

/** Contexto do lote: sessão do aprovador + id da sessão BFF (para invalidá-la no 401). */
export interface ContextoExecucaoLote extends ContextoExecucao {
  sessionId?: string;
}

export interface DepsExecucaoLote {
  servico: SodServico;
  deps: ExecucaoDeps;
  /** Injetável nos testes; o runtime usa o destroySession real. */
  destroySessionFn?: typeof destroySession;
}

/**
 * Execuções em andamento NESTE processo — evita disparo duplo da mesma
 * requisição no mesmo backend e dá aos testes um ponto de espera. A garantia
 * forte de não-duplicidade é a reivindicação atômica por item, no banco.
 */
const emAndamento = new Map<string, Promise<void>>();

export function execucaoLoteEmAndamento(requisicaoId: string): Promise<void> | undefined {
  return emAndamento.get(requisicaoId);
}

/**
 * Dispara a execução sequencial do lote (sem await na rota). Reentrante:
 * chamada repetida para o mesmo lote devolve a promessa já em andamento.
 */
export function iniciarExecucaoLote(
  requisicao: RequisicaoSod,
  ctx: ContextoExecucaoLote,
  deps: DepsExecucaoLote,
): Promise<void> {
  const existente = emAndamento.get(requisicao.id);
  if (existente) return existente;
  const execucao = executarLote(requisicao, ctx, deps).finally(() => {
    emAndamento.delete(requisicao.id);
  });
  emAndamento.set(requisicao.id, execucao);
  return execucao;
}

/** Adapta um item ao contrato dos executores individuais (que leem só payload/tipo). */
function itemComoRequisicao(item: ItemLoteSod, lote: RequisicaoSod): RequisicaoSod {
  return { ...lote, id: item.id, tipo: item.tipo, payload: item.payload };
}

async function executarLote(
  requisicao: RequisicaoSod,
  ctx: ContextoExecucaoLote,
  { servico, deps, destroySessionFn = destroySession }: DepsExecucaoLote,
): Promise<void> {
  const inicio = Date.now();
  const duracoesMs: number[] = [];
  let interrupcao: { causa: string; mensagem: string; noItem: number } | null = null;

  for (const item of servico.itensDoLote(requisicao.id)) {
    if (interrupcao) break;
    if (item.estado !== "pendente") continue; // reprovado por exceção, ou já processado

    /*
     * ENCADEAMENTO do lote composto (US-07, RN03/Cenário 3): proposta
     * vinculada só executa depois de `executada` do seu tomador — os itens
     * são persistidos com os tomadores ANTES das propostas, então o estado
     * do tomador aqui já é final. Tomador em falha/reprovado (ou qualquer
     * estado ≠ executada) → a proposta cai em `falha` com a causa, SEM
     * reivindicar e SEM tocar a Sinqia. Elegibilidade de retry por vínculo
     * (RN05) é decidida sobre esta mesma coluna na US-10.
     */
    if (item.dependeDeItemId) {
      const tomador = servico.obterItem(item.dependeDeItemId);
      if (!tomador || tomador.estado !== "executada") {
        servico.falharItemPendente(
          item.id,
          ctx.ator,
          CAUSA_TOMADOR_NAO_CRIADO,
          `Tomador não criado — item ${tomador?.ordem ?? "?"}` +
            (tomador ? ` (${tomador.estado})` : "") +
            `: nada foi enviado à Sinqia para esta proposta.`,
          { itemTomador: tomador?.ordem ?? null, estadoTomador: tomador?.estado ?? null },
        );
        continue;
      }
    }

    // RN05: reivindicação atômica — se este item já saiu de `pendente`
    // (reexecução forçada, corrida), pula SEM tocar a Sinqia.
    const reivindicado = servico.iniciarItemExecucao(item.id, ctx.ator);
    if (!reivindicado) continue;

    try {
      const tipoIndividual = TIPO_ITEM_DO_LOTE[item.tipo as TipoAcaoSod] ?? (item.tipo as TipoAcaoSod);
      const executor = EXECUTORES[tipoIndividual];
      const t0 = Date.now();
      const execucao = executor
        ? await executor(itemComoRequisicao(reivindicado, requisicao), ctx, deps)
        : falhaExecucao(
            { causa: "tipo_sem_executor", tipo: item.tipo },
            { httpStatus: null, mensagens: `Tipo ${item.tipo} ainda não tem executor.` },
          );
      const duracaoMs = Date.now() - t0;
      duracoesMs.push(duracaoMs);

      servico.concluirItemExecucao(item.id, ctx.ator, execucao.desfecho, {
        ...execucao.resultado,
        publico: execucao.publico,
        duracaoMs,
      });

      // 401 no meio do lote: sem relogin automático (o backend não guarda a
      // senha) — interrompe, e o restante cai em `falha` com causa.
      if (execucao.sessaoExpirou) {
        destroySessionFn(ctx.sessionId);
        interrupcao = {
          causa: "sessao_expirada_durante_execucao",
          mensagem:
            "A sessão do aprovador expirou durante a execução do lote — os itens restantes não foram enviados.",
          noItem: item.ordem,
        };
      }
    } catch (e) {
      // Queda inesperada (erro de persistência etc.): melhor-esforço para o
      // item corrente e interrupção registrada — nunca exceção solta.
      try {
        servico.concluirItemExecucao(item.id, ctx.ator, "falha", {
          desfecho: "falha",
          causa: "erro_inesperado",
          mensagem: (e as Error).message,
          publico: { desfecho: "falha", httpStatus: null, mensagens: (e as Error).message },
        });
      } catch {
        /* o item pode ter ficado em aprovada/executando — o placar denuncia */
      }
      interrupcao = {
        causa: "erro_inesperado",
        mensagem: `Erro inesperado no item ${item.ordem}: ${(e as Error).message}`,
        noItem: item.ordem,
      };
    }
  }

  if (interrupcao) {
    servico.falharItensPendentesDoLote(
      requisicao.id,
      ctx.ator,
      CAUSA_LOTE_INTERROMPIDO,
      `${MENSAGEM_INTERROMPIDO} Causa: ${interrupcao.mensagem}`,
    );
  }

  // Reexecução forçada de um lote já concluído (RN05): nada foi reivindicado
  // e o lote não está mais em execução — não há o que concluir.
  const atual = servico.obterRequisicao(requisicao.id);
  if (!atual || atual.estado !== "aprovada/executando") return;

  // RN01: estado do lote DERIVADO do placar dos itens.
  const duracaoTotalMs = Date.now() - inicio;
  servico.concluirLote(requisicao.id, ctx.ator, {
    duracaoTotalMs,
    duracaoMediaItemMs:
      duracoesMs.length > 0
        ? Math.round(duracoesMs.reduce((a, b) => a + b, 0) / duracoesMs.length)
        : null,
    ...(interrupcao
      ? { causa: interrupcao.causa, interrompidoNoItem: interrupcao.noItem, mensagem: interrupcao.mensagem }
      : {}),
  });
}
