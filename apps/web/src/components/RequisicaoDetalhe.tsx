import { Fragment, useEffect, useMemo, useState } from "react";
import {
  Calculator,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FileJson,
  History,
  Search,
  XCircle,
} from "lucide-react";
import {
  CAMPOS,
  ehTipoLote,
  situacaoLabel,
  type LoteSodPayload,
  type MovimentacaoLoteSodPayload,
  type MovimentacaoSodPayload,
  type PlacarLote,
  type PropostaSodPayload,
  type TipoAcaoSod,
} from "@cadastro-lote/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatBRL, formatCpf, formatDataAAAAMMDD } from "@/lib/format";
import {
  consultarImpactoSituacao,
  type EventoAuditoriaSod,
  type ImpactoSituacao,
  type ItemLoteResumo,
  type RequisicaoSod,
} from "@/lib/api";

/**
 * Esteira de Aprovação (SoD) — corpo do DETALHE de uma requisição, usado nos
 * drawers de "Minhas requisições" (US-02) e do Painel de pendências (US-03):
 * resumo, payload em campos nomeados POR TIPO DE AÇÃO (JSON cru em seção
 * expansível), resultado da execução e histórico de transições da auditoria.
 * Cada novo tipo (US-04+) acrescenta o seu renderer em RENDER_PAYLOAD.
 */

/** Rótulo legível de cada caminho do formulário de cadastro. */
const ROTULO_POR_PATH = new Map(CAMPOS.map((c) => [c.path, c.label]));

export function formatarTs(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Payload de proposta (US-04), tolerante a formato inesperado. */
function propostaDoPayload(payload: Record<string, unknown>): Partial<PropostaSodPayload> {
  return payload as unknown as Partial<PropostaSodPayload>;
}

/** Payload de lote (US-06), tolerante a formato inesperado. */
function loteDoPayload(payload: Record<string, unknown>): Partial<LoteSodPayload> {
  return payload as unknown as Partial<LoteSodPayload>;
}

/** Payload de movimentação (US-08), tolerante a formato inesperado. */
function movimentacaoDoPayload(
  payload: Record<string, unknown>,
): MovimentacaoSodPayload["movimentacao"] | undefined {
  return (payload as unknown as Partial<MovimentacaoSodPayload>).movimentacao;
}

/** Payload do lote de movimentação (US-09), tolerante a formato inesperado. */
function movimentacaoLoteDoPayload(
  payload: Record<string, unknown>,
): Partial<MovimentacaoLoteSodPayload> {
  return payload as unknown as Partial<MovimentacaoLoteSodPayload>;
}

/** Identificação principal (nome do tomador / arquivo) da requisição, por tipo. */
export function nomeDoPayload(
  tipo: TipoAcaoSod | string,
  payload: Record<string, unknown>,
): string {
  if (tipo === "proposta.movimentar_massa") {
    const lote = movimentacaoLoteDoPayload(payload);
    const origem = lote.fila?.origem?.dsStatus?.trim() || "origem";
    const destino = lote.destino?.dsStatus?.trim() || "destino";
    return `${lote.totalItens ?? "?"} proposta(s): ${origem} → ${destino}`;
  }
  if (ehTipoLote(tipo as TipoAcaoSod)) {
    const arquivo = loteDoPayload(payload).arquivo;
    return arquivo?.nome?.trim() ? arquivo.nome : "Lote";
  }
  if (tipo === "proposta.criar") {
    const proposta = propostaDoPayload(payload).proposta;
    if (proposta?.nome?.trim()) return proposta.nome;
    if (proposta?.cpf) return formatCpf(proposta.cpf);
    return "—";
  }
  if (tipo === "proposta.movimentar") {
    const mov = movimentacaoDoPayload(payload);
    if (!mov?.nrProsp) return "—";
    return `Proposta nº ${mov.nrProsp}${mov.nmCliente?.trim() ? ` — ${mov.nmCliente}` : ""}`;
  }
  if (tipo === "situacao_tomador") {
    const alvo = (payload.alvo as Record<string, unknown>) || {};
    return typeof alvo.nome === "string" && alvo.nome.trim() ? alvo.nome : String(alvo.documento || "—");
  }
  const campos = payload.campos;
  if (campos && typeof campos === "object" && !Array.isArray(campos)) {
    const nome = (campos as Record<string, unknown>).dsNome;
    if (typeof nome === "string" && nome.trim()) return nome;
  }
  return "—";
}

/** Contagem de itens de um LOTE, direto do payload (para as listagens). */
export function contagemDoPayload(
  tipo: TipoAcaoSod | string,
  payload: Record<string, unknown>,
): number | null {
  if (!ehTipoLote(tipo as TipoAcaoSod)) return null;
  // Lote de movimentação (US-09) não tem arquivo — a contagem é direta.
  if (tipo === "proposta.movimentar_massa") {
    const total = movimentacaoLoteDoPayload(payload).totalItens;
    return typeof total === "number" ? total : null;
  }
  const total = loteDoPayload(payload).arquivo?.totalItens;
  return typeof total === "number" ? total : null;
}

/**
 * Causa da falha registrada pela execução — a apresentação distingue erro de
 * cálculo/conferência, erro de negócio Sinqia e indisponibilidade (US-04).
 */
const ROTULO_CAUSA: Record<string, string> = {
  calculo_reprovado: "Cálculo oficial reprovado pela Sinqia — reveja os insumos da requisição",
  conferencia_reprovada:
    "Conferência automática reprovada — cálculo oficial divergiu da planilha (nada foi criado)",
  tomador_nao_criado: "Tomador vinculado não foi criado — nada foi enviado à Sinqia",
  duplicidade_sinqia: "Proposta idêntica já existia na Sinqia — nada foi criado",
  divergencia_externa:
    "A proposta mudou de etapa por fora da plataforma — nada foi movido (resolução na US-10)",
  movimentacao_rejeitada: "A Sinqia rejeitou a movimentação — nada foi movido",
  erro_negocio: "Erro de negócio na Sinqia",
  indisponibilidade_ou_timeout: "Sinqia indisponível ou timeout",
  sessao_expirada_durante_execucao: "A sessão do aprovador expirou durante a execução",
  payload_invalido: "Payload da requisição em formato inesperado",
  payload_sem_request: "Payload da requisição em formato inesperado",
  tipo_sem_executor: "Tipo de ação ainda sem executor",
  lote_interrompido: "A execução do lote foi interrompida antes deste item — nada foi enviado",
  erro_inesperado: "Erro inesperado durante a execução",
};

const ROTULO_DECISAO: Record<string, string> = {
  aprovar: "aprovação",
  reprovar: "reprovação",
  cancelar: "cancelamento",
  retry: "retry",
  descartar: "descarte",
  concluir_execucao: "conclusão da execução",
};

/** Linha legível do histórico de auditoria. */
function descreverEvento(ev: EventoAuditoriaSod): string {
  const d = ev.detalhe as { decisao?: string; de?: string; para?: string; mensagem?: string };
  if (ev.acao === "requisicao_criada") return "Requisição criada";
  if (ev.acao === "execucao_iniciada") return "Execução na Sinqia iniciada (sessão do aprovador)";
  if (ev.acao === "transicao_estado") {
    const decisao = d.decisao ? ROTULO_DECISAO[d.decisao] ?? d.decisao : "transição";
    return `${d.de ?? "?"} → ${d.para ?? "?"} (${decisao})`;
  }
  if (ev.acao === "tentativa_rejeitada") {
    return `Tentativa rejeitada — ${d.mensagem ?? ev.resultado}`;
  }
  return ev.acao;
}

export function LinhaDetalhe({ rotulo, valor }: { rotulo: string; valor: string }) {
  return (
    <div className="flex gap-2">
      <span className="min-w-44 shrink-0 text-muted-foreground">{rotulo}</span>
      <span className="break-all">{valor}</span>
    </div>
  );
}

/** Resumo legível do resultado anexado pela execução (RN05 da US-03). */
function resumoResultado(resultado: Record<string, unknown>): string {
  const mensagens = resultado.mensagens ?? resultado.mensagem;
  if (typeof mensagens === "string" && mensagens.trim()) return mensagens;
  const detalhe = resultado.detalhe;
  if (typeof detalhe === "string" && detalhe.trim()) return detalhe;
  return "";
}

/**
 * Marcação de EXCEÇÕES por item na decisão bidirecional de um lote (US-06):
 * o estado vive na página (PainelPendencias); aqui só a interação inline.
 */
export interface MarcacaoExcecoes {
  /** itemId → motivo digitado. */
  excecoes: Record<string, string>;
  /** motivo null = desmarcar o item. */
  onMarcar: (itemId: string, motivo: string | null) => void;
}

export function RequisicaoDetalhe({
  requisicao: req,
  historico,
  itens,
  placar,
  placarPorTipo,
  marcacao,
  acoesFalha,
}: {
  requisicao: RequisicaoSod;
  historico: EventoAuditoriaSod[];
  /** Itens do lote (US-06) — presentes só em requisições de lote. */
  itens?: ItemLoteResumo[];
  placar?: PlacarLote;
  /** Placar de DOIS NÍVEIS (US-07): por tipo de item, no lote composto. */
  placarPorTipo?: Partial<Record<TipoAcaoSod, PlacarLote>>;
  /** Habilita a marcação de exceções (aprovador, lote pendente). */
  marcacao?: MarcacaoExcecoes;
  /** Habilita ações de retry/descarte para itens em falha no lote. */
  acoesFalha?: {
    isMinhaRequisicao: boolean;
    onRetry: (itemId: string) => void;
    onDescarte: (itemId: string, motivo: string) => void;
  };
}) {
  const [verJson, setVerJson] = useState(false);
  const [verJsonResultado, setVerJsonResultado] = useState(false);

  const ehProposta = req.tipo === "proposta.criar";
  const ehMovimentacao = req.tipo === "proposta.movimentar";
  const ehLote = ehTipoLote(req.tipo);
  /** Etapas válidas capturadas na falha de movimentação (US-08, Cenário 4). */
  const etapasValidas = Array.isArray(req.resultado?.etapasValidas)
    ? (req.resultado.etapasValidas as Array<{ proxStatus?: number; dsStatus?: string }>)
    : null;
  const causaFalha =
    req.estado === "falha" && typeof req.resultado?.causa === "string"
      ? (ROTULO_CAUSA[req.resultado.causa] ?? req.resultado.causa)
      : null;

  return (
    <div className="space-y-5 text-sm">
      {/* Resumo */}
      <div className="grid gap-1">
        <LinhaDetalhe rotulo="Criada em" valor={formatarTs(req.criadoEm)} />
        <LinhaDetalhe rotulo="Criada por" valor={req.requisitante} />
        <LinhaDetalhe rotulo="Última atualização" valor={formatarTs(req.atualizadoEm)} />
        {req.decididoPor && <LinhaDetalhe rotulo="Decidida por" valor={req.decididoPor} />}
        {req.documento && (
          <LinhaDetalhe
            rotulo={ehProposta ? "Chave de duplicidade" : "Documento"}
            valor={req.documento}
          />
        )}
      </div>

      {/* Motivo de reprovação/descarte */}
      {req.motivo && (
        <div className="rounded-lg border border-[var(--destructive)] bg-[var(--destructive)]/10 px-3 py-2 text-[var(--destructive)]">
          <p className="font-medium">
            Motivo {req.estado === "descartada" ? "do descarte" : "da reprovação"}:
          </p>
          <p className="mt-0.5">{req.motivo}</p>
        </div>
      )}

      {/* Resultado da execução na Sinqia (US-03): sucesso ou falha, legível */}
      {req.resultado && (req.estado === "executada" || req.estado === "falha") && (
        <div
          className={
            req.estado === "executada"
              ? "rounded-lg border border-[var(--success)] bg-[var(--success)]/10 px-3 py-2"
              : "rounded-lg border border-[var(--destructive)] bg-[var(--destructive)]/10 px-3 py-2 text-[var(--destructive)]"
          }
        >
          <p className="flex items-center gap-1.5 font-medium">
            {req.estado === "executada" ? (
              <>
                <CheckCircle2 className="h-4 w-4 shrink-0" />
                Executada na Sinqia
              </>
            ) : (
              <>
                <XCircle className="h-4 w-4 shrink-0" />
                Falha na execução
              </>
            )}
          </p>
          {causaFalha && <p className="mt-0.5 font-medium">{causaFalha}</p>}
          {resumoResultado(req.resultado) && (
            <p className="mt-0.5 break-all">{resumoResultado(req.resultado)}</p>
          )}
          {/* Etapas que o workflow permite HOJE — devolvidas na falha (US-08) */}
          {req.estado === "falha" && etapasValidas && etapasValidas.length > 0 && (
            <p className="mt-0.5">
              Etapas válidas a partir da etapa atual:{" "}
              {etapasValidas
                .map((t) => t.dsStatus || `status ${t.proxStatus ?? "?"}`)
                .join(", ")}
              .
            </p>
          )}
          <Button
            variant="outline"
            size="sm"
            className="mt-2"
            onClick={() => setVerJsonResultado((v) => !v)}
          >
            <FileJson className="h-4 w-4" />
            {verJsonResultado ? "Ocultar" : "Ver"} resposta integral
          </Button>
          {verJsonResultado && (
            <pre className="mt-2 max-h-60 overflow-auto rounded-lg bg-[var(--muted)]/40 p-3 text-xs text-foreground">
              {JSON.stringify(req.resultado, null, 2)}
            </pre>
          )}
        </div>
      )}

      {/* Payload em campos nomeados — renderer por tipo de ação */}
      {ehLote ? (
        <>
          {req.tipo === "proposta.movimentar_massa" ? (
            <PayloadLoteMovimentacao payload={req.payload} />
          ) : (
            <PayloadLote tipo={req.tipo} payload={req.payload} />
          )}
          <LoteItens
            requisicao={req}
            itens={itens ?? []}
            placar={placar}
            placarPorTipo={placarPorTipo}
            marcacao={req.estado === "pendente" ? marcacao : undefined}
            acoesFalha={acoesFalha}
          />
        </>
      ) : ehProposta ? (
        <PayloadProposta payload={req.payload} />
      ) : ehMovimentacao ? (
        <PayloadMovimentacao payload={req.payload} />
      ) : req.tipo === "situacao_tomador" ? (
        <PayloadSituacaoTomador payload={req.payload} resultado={req.resultado} estado={req.estado} />
      ) : (
        <PayloadTomador payload={req.payload} />
      )}

      {/*
        Aviso de impacto ANTES da decisão (US-12): inativar tomador com proposta
        em andamento é a situação que a RN manda avisar. Vale para a individual e
        para o lote, por isso vive aqui e não dentro de um renderer de payload.
      */}
      {(req.tipo === "situacao_tomador" || req.tipo === "situacao_tomador_lote") &&
        req.estado === "pendente" && <ImpactoSituacaoAviso requisicaoId={req.id} />}

      {/* JSON integral — seção secundária, expansível */}
      <section>
        <Button variant="outline" size="sm" onClick={() => setVerJson((v) => !v)}>
          <FileJson className="h-4 w-4" />
          {verJson ? "Ocultar" : "Ver"} JSON integral
        </Button>
        {verJson && (
          <pre className="mt-3 max-h-80 overflow-auto rounded-lg bg-[var(--muted)]/40 p-3 text-xs">
            {JSON.stringify(req.payload, null, 2)}
          </pre>
        )}
      </section>

      {/* Histórico de transições (trilha de auditoria) */}
      <section>
        {(() => {
          let numTentativa = 1;
          const historicoAnotado = historico.map((ev) => {
            const isTentativa =
              ev.acao === "tentativa_rejeitada" ||
              (ev.acao === "transicao_estado" && (ev.detalhe as any).para === "aprovada/executando");
            return { ev, numTentativa: isTentativa ? numTentativa++ : null };
          });
          const totalTentativas = numTentativa - 1;

          return (
            <>
              <h3 className="mb-2 flex items-center gap-1.5 text-subheading text-foreground">
                <History className="h-4 w-4" />
                Histórico {totalTentativas > 0 && <span className="text-muted-foreground font-normal text-sm">({totalTentativas} {totalTentativas === 1 ? 'tentativa' : 'tentativas'})</span>}
              </h3>
              <ol className="space-y-2">
                {historicoAnotado.map(({ ev, numTentativa }) => (
                  <li key={ev.id} className="rounded-lg border border-border px-3 py-2">
                    <div className="flex items-center gap-2">
                      {numTentativa && <Badge variant="outline" className="text-[10px]">Tentativa {numTentativa}</Badge>}
                      <p>{descreverEvento(ev)}</p>
                    </div>
                    <p className="mt-0.5 text-caption text-muted-foreground">
                      {formatarTs(ev.ts)} · {ev.ator}
                      {typeof ev.detalhe.motivo === "string" && <> · motivo: {ev.detalhe.motivo}</>}
                    </p>
                  </li>
                ))}
              </ol>
            </>
          );
        })()}
      </section>
    </div>
  );
}

/** Payload de `tomador.cadastrar` (US-02): campos do formulário + controles. */
function PayloadTomador({ payload }: { payload: Record<string, unknown> }) {
  const camposDoPayload = useMemo(() => {
    const campos = payload.campos;
    if (!campos || typeof campos !== "object" || Array.isArray(campos)) return [];
    return Object.entries(campos as Record<string, unknown>).map(([path, valor]) => ({
      path,
      rotulo: ROTULO_POR_PATH.get(path) ?? path,
      valor: String(valor ?? ""),
    }));
  }, [payload]);

  const controlDoPayload = useMemo(() => {
    const control = payload.control;
    if (!control || typeof control !== "object" || Array.isArray(control)) return [];
    return Object.entries(control as Record<string, unknown>).map(([chave, valor]) => ({
      chave,
      valor: String(valor ?? ""),
    }));
  }, [payload]);

  return (
    <>
      {/* Dados do tomador em campos nomeados */}
      <section>
        <h3 className="mb-2 text-subheading text-foreground">Dados do tomador</h3>
        {camposDoPayload.length === 0 ? (
          <p className="text-muted-foreground">
            O payload desta requisição não está no formato do formulário de cadastro — consulte
            o JSON integral abaixo.
          </p>
        ) : (
          <div className="grid gap-1 rounded-lg border border-border p-3">
            {camposDoPayload.map((c) => (
              <div key={c.path} className="flex gap-2">
                <span className="min-w-44 shrink-0 text-muted-foreground" title={c.path}>
                  {c.rotulo}
                </span>
                <span className="break-all">{c.valor}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Controles do cadastro */}
      {controlDoPayload.length > 0 && (
        <section>
          <h3 className="mb-2 text-subheading text-foreground">Controles do cadastro</h3>
          <div className="grid gap-1 rounded-lg border border-border p-3">
            {controlDoPayload.map((c) => (
              <div key={c.chave} className="flex gap-2">
                <span className="min-w-44 shrink-0 font-mono text-caption text-muted-foreground">
                  {c.chave}
                </span>
                <span className="break-all">{c.valor}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </>
  );
}

/**
 * Payload de `proposta.criar` (US-04): dados da proposta + tomador em campos
 * nomeados e os valores do requisitante SEMPRE rotulados como referência —
 * o cálculo oficial acontece na execução (RN06).
 */
function PayloadProposta({ payload }: { payload: Record<string, unknown> }) {
  const p = propostaDoPayload(payload);
  const proposta = p.proposta;
  const referencia = p.referencia;

  if (!proposta) {
    return (
      <section>
        <h3 className="mb-2 text-subheading text-foreground">Dados da proposta</h3>
        <p className="text-muted-foreground">
          O payload desta requisição não está no formato canônico de proposta — consulte o
          JSON integral abaixo.
        </p>
      </section>
    );
  }

  const dinheiroOpcional = (v: number | undefined) =>
    v !== undefined && v > 0 ? formatBRL(v) : "—";

  return (
    <>
      {/* Tomador da proposta */}
      <section>
        <h3 className="mb-2 text-subheading text-foreground">Tomador</h3>
        <div className="grid gap-1 rounded-lg border border-border p-3">
          <LinhaDetalhe rotulo="Nome" valor={proposta.nome || "—"} />
          <LinhaDetalhe rotulo="CPF" valor={formatCpf(proposta.cpf)} />
        </div>
      </section>

      {/* Dados da operação + parâmetros, como digitados pelo requisitante */}
      <section>
        <h3 className="mb-2 text-subheading text-foreground">Dados da proposta</h3>
        <div className="grid gap-1 rounded-lg border border-border p-3">
          <LinhaDetalhe rotulo="Valor líquido" valor={formatBRL(proposta.dados?.vlLiquido ?? null)} />
          <LinhaDetalhe rotulo="Qtd. de parcelas" valor={String(proposta.dados?.qtParcelas ?? "—")} />
          <LinhaDetalhe
            rotulo="1º vencimento"
            valor={formatDataAAAAMMDD(proposta.dados?.dtVct1Ap ?? null)}
          />
          <LinhaDetalhe rotulo="TAC" valor={dinheiroOpcional(proposta.dados?.vlTac)} />
          <LinhaDetalhe rotulo="Seguro" valor={dinheiroOpcional(proposta.dados?.vlSeguro)} />
          <LinhaDetalhe rotulo="Outros" valor={dinheiroOpcional(proposta.dados?.vlOutros)} />
          <LinhaDetalhe rotulo="Taxa de juros (a.m.)" valor={`${proposta.params?.txJuros ?? "—"}%`} />
          <LinhaDetalhe rotulo="Produto" valor={String(proposta.params?.cdProd ?? "—")} />
          <LinhaDetalhe rotulo="Característica" valor={String(proposta.params?.idCarCtr ?? "—")} />
          <LinhaDetalhe rotulo="Convênio" valor={String(proposta.params?.cdConven ?? "—")} />
          <LinhaDetalhe
            rotulo="Loja"
            valor={proposta.params?.cdLoja !== undefined ? String(proposta.params.cdLoja) : "—"}
          />
          <LinhaDetalhe
            rotulo="Data do contrato"
            valor={formatDataAAAAMMDD(proposta.params?.dtContra ?? null)}
          />
          <LinhaDetalhe
            rotulo="Forçar duplicada"
            valor={proposta.forcarDuplicada ? "sim (reemissão consciente)" : "não"}
          />
        </div>
      </section>

      {/* Valores do cálculo do requisitante — SEMPRE rotulados (RN06) */}
      {referencia?.resumo && (
        <section>
          <h3 className="mb-2 flex items-center gap-1.5 text-subheading text-foreground">
            <Calculator className="h-4 w-4" />
            Valores de referência
          </h3>
          <div className="rounded-lg border border-warning/50 bg-warning/10 p-3">
            <p className="mb-2 text-caption font-semibold uppercase tracking-wide text-warning-foreground">
              {referencia.rotulo || "referência — cálculo oficial na execução"}
            </p>
            <div className="grid gap-1">
              <LinhaDetalhe rotulo="Parcela" valor={formatBRL(referencia.resumo.vlPresta)} />
              <LinhaDetalhe rotulo="Financiado" valor={formatBRL(referencia.resumo.vlFinanciado)} />
              <LinhaDetalhe rotulo="Líquido" valor={formatBRL(referencia.resumo.vlLiquid)} />
              <LinhaDetalhe rotulo="IOF" valor={formatBRL(referencia.resumo.vlIof)} />
              <LinhaDetalhe rotulo="Total" valor={formatBRL(referencia.resumo.vlTotal)} />
              <LinhaDetalhe
                rotulo="CET a.m."
                valor={
                  referencia.resumo.txCetAm !== null
                    ? `${referencia.resumo.txCetAm.toFixed(4)}%`
                    : "—"
                }
              />
              <LinhaDetalhe
                rotulo="Último vencimento"
                valor={formatDataAAAAMMDD(referencia.resumo.dtVctult)}
              />
            </div>
            {referencia.calculadoEm && (
              <p className="mt-2 text-caption text-muted-foreground">
                Calculado pelo requisitante em {formatarTs(referencia.calculadoEm)}. Os valores
                oficiais (parcelas, CET, IOF) são calculados na aprovação, na sessão do
                aprovador.
              </p>
            )}
          </div>
        </section>
      )}
    </>
  );
}

/**
 * Payload de `proposta.movimentar` (US-08): identificação da proposta e a
 * transição pedida (origem → destino), com a observação que irá para o
 * histórico do workflow — tudo que o aprovador precisa para conferir mérito.
 */
function PayloadMovimentacao({ payload }: { payload: Record<string, unknown> }) {
  const mov = movimentacaoDoPayload(payload);

  if (!mov?.nrProsp) {
    return (
      <section>
        <h3 className="mb-2 text-subheading text-foreground">Dados da movimentação</h3>
        <p className="text-muted-foreground">
          O payload desta requisição não está no formato canônico de movimentação — consulte
          o JSON integral abaixo.
        </p>
      </section>
    );
  }

  return (
    <section>
      <h3 className="mb-2 text-subheading text-foreground">Dados da movimentação</h3>
      <div className="grid gap-1 rounded-lg border border-border p-3">
        <LinhaDetalhe rotulo="Proposta" valor={`nº ${mov.nrProsp}`} />
        <LinhaDetalhe rotulo="Tomador" valor={mov.nmCliente?.trim() || "—"} />
        <LinhaDetalhe rotulo="CPF/CNPJ" valor={formatCpf(mov.nrCpf ?? "")} />
        <LinhaDetalhe
          rotulo="Etapa de origem"
          valor={
            mov.origem
              ? `${mov.origem.dsStatus || "—"} (status ${mov.origem.nrStatus})`
              : "—"
          }
        />
        <LinhaDetalhe
          rotulo="Etapa de destino"
          valor={
            mov.destino
              ? `${mov.destino.dsStatus || "—"} (status ${mov.destino.proxStatus})`
              : "—"
          }
        />
        <LinhaDetalhe rotulo="Observação" valor={mov.dsObserv?.trim() || "—"} />
        <LinhaDetalhe rotulo="Workflow" valor={String(mov.nrWf ?? "—")} />
        <LinhaDetalhe rotulo="Produto" valor={String(mov.cdProd ?? "—")} />
        {mov.nrContra !== null && mov.nrContra !== undefined && (
          <LinhaDetalhe rotulo="Contrato" valor={String(mov.nrContra)} />
        )}
      </div>
      <p className="mt-2 text-caption text-muted-foreground">
        A proposta permanece na etapa de origem até a aprovação. A execução confere na
        Sinqia se ela ainda está lá — mudança por fora da plataforma vira falha registrada,
        sem mover nada.
      </p>
    </section>
  );
}

/**
 * Payload do LOTE de movimentação (US-09): a transição única do lote com
 * origem → destino EM DESTAQUE — é a primeira coisa que o aprovador precisa
 * conferir na tela de decisão. As propostas vivem nos itens, logo abaixo.
 */
function PayloadLoteMovimentacao({ payload }: { payload: Record<string, unknown> }) {
  const lote = movimentacaoLoteDoPayload(payload);
  const origem = lote.fila?.origem;
  const destino = lote.destino;
  return (
    <section>
      <h3 className="mb-2 text-subheading text-foreground">Movimentação em massa</h3>
      {/* Origem → destino em destaque (US-09) */}
      <div className="mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-[var(--primary)] bg-[var(--accent)]/60 px-3 py-2.5">
        <span className="text-body font-semibold">
          {origem ? `${origem.dsStatus || "—"} (status ${origem.nrStatus})` : "—"}
        </span>
        <span aria-hidden className="text-lg font-semibold text-[var(--primary)]">
          →
        </span>
        <span className="text-body font-semibold">
          {destino ? `${destino.dsStatus || "—"} (status ${destino.proxStatus})` : "—"}
        </span>
        <Badge variant="outline" className="ml-auto tabular-nums">
          {lote.totalItens ?? "?"} proposta(s)
        </Badge>
      </div>
      <div className="grid gap-1 rounded-lg border border-border p-3">
        <LinhaDetalhe rotulo="Workflow" valor={String(lote.fila?.nrWf ?? "—")} />
        <LinhaDetalhe rotulo="Observação" valor={lote.dsObserv?.trim() || "—"} />
        {typeof lote.inelegiveisRemovidas === "number" && lote.inelegiveisRemovidas > 0 && (
          <LinhaDetalhe
            rotulo="Fora do lote"
            valor={`${lote.inelegiveisRemovidas} proposta(s) da seleção ficaram de fora por bloqueio ativo (confirmado pelo requisitante)`}
          />
        )}
      </div>
      <p className="mt-2 text-caption text-muted-foreground">
        Todas as propostas permanecem na etapa de origem até a aprovação. A execução move
        uma a uma, na sessão do aprovador, conferindo antes se cada proposta ainda está na
        etapa de origem — mudança por fora vira falha registrada daquele item, sem
        interromper os demais.
      </p>
    </section>
  );
}

/**
 * Payload de lote: arquivo + controles — os dados vivem nos ITENS.
 * US-06 (tomadores): arquivo único. US-07 (propostas): possivelmente COMPOSTO —
 * planilha de propostas + arquivo de tomadores, com vínculos por CPF.
 */
function PayloadLote({
  tipo,
  payload,
}: {
  tipo: TipoAcaoSod | string;
  payload: Record<string, unknown>;
}) {
  const lote = loteDoPayload(payload);
  const composto = payload.composto === true;
  const arquivoTomadores = payload.arquivoTomadores as
    | { nome?: string; totalItens?: number }
    | undefined;
  const vinculos = typeof payload.vinculos === "number" ? payload.vinculos : null;
  const params = payload.params;
  const paramsDoPayload = useMemo(() => {
    if (!params || typeof params !== "object" || Array.isArray(params)) return [];
    return Object.entries(params as Record<string, unknown>).map(([chave, valor]) => ({
      chave,
      valor: String(valor ?? ""),
    }));
  }, [params]);
  const controlDoPayload = useMemo(() => {
    const control = payload.control;
    if (!control || typeof control !== "object" || Array.isArray(control)) return [];
    return Object.entries(control as Record<string, unknown>).map(([chave, valor]) => ({
      chave,
      valor: String(valor ?? ""),
    }));
  }, [payload]);

  const ehLotePropostas = tipo === "proposta.criar_lote";
  /*
   * Lote de situação (US-12) não nasce de arquivo: o que o aprovador precisa ver
   * é a situação de DESTINO. Antes, este renderer mostrava apenas "Arquivo: —" e
   * a situação a ser aplicada não aparecia em lugar nenhum da tela de decisão.
   */
  const cdSituacaoLote =
    typeof payload.cdSituacao === "number" ? (payload.cdSituacao as number) : null;
  return (
    <section>
      <h3 className="mb-2 text-subheading text-foreground">Dados do lote</h3>
      <div className="grid gap-1 rounded-lg border border-border p-3">
        {cdSituacaoLote !== null && (
          <LinhaDetalhe rotulo="Nova situação" valor={situacaoLabel(cdSituacaoLote) || "—"} />
        )}
        {(lote.arquivo?.nome || cdSituacaoLote === null) && (
          <LinhaDetalhe
            rotulo={ehLotePropostas ? "Planilha de propostas" : "Arquivo"}
            valor={lote.arquivo?.nome || "—"}
          />
        )}
        {composto && (
          <LinhaDetalhe
            rotulo="Arquivo de tomadores"
            valor={
              arquivoTomadores?.nome
                ? `${arquivoTomadores.nome} (${arquivoTomadores.totalItens ?? "?"} tomador(es))`
                : "—"
            }
          />
        )}
        <LinhaDetalhe
          rotulo={ehLotePropostas ? "Total de itens" : "Total de tomadores"}
          // Lote de arquivo guarda o total em `arquivo.totalItens`; o de situação
          // (sem arquivo) guarda na raiz do payload.
          valor={String(
            lote.arquivo?.totalItens ??
              (typeof payload.totalItens === "number" ? payload.totalItens : "—"),
          )}
        />
        {composto && vinculos !== null && (
          <LinhaDetalhe
            rotulo="Vínculos tomador→proposta"
            valor={`${vinculos} proposta(s) dependem do cadastro do tomador neste lote`}
          />
        )}
        {paramsDoPayload.map((c) => (
          <div key={c.chave} className="flex gap-2">
            <span className="min-w-44 shrink-0 font-mono text-caption text-muted-foreground">
              {c.chave}
            </span>
            <span className="break-all">{c.valor}</span>
          </div>
        ))}
        {controlDoPayload.map((c) => (
          <div key={c.chave} className="flex gap-2">
            <span className="min-w-44 shrink-0 font-mono text-caption text-muted-foreground">
              {c.chave}
            </span>
            <span className="break-all">{c.valor}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * Payload de `situacao_tomador` (US-12): exibe os dados do cliente a ser alterado,
 * a situação nova e, se executado, o impacto (propostas afetadas).
 */
/**
 * Consulta e exibe o impacto da alteração de situação enquanto a requisição
 * está PENDENTE — o dado que faltava a quem decide. Silencioso quando não há
 * impacto (ativação, ou nenhuma proposta em andamento): aviso só onde importa.
 */
function ImpactoSituacaoAviso({ requisicaoId }: { requisicaoId: string }) {
  const [impacto, setImpacto] = useState<ImpactoSituacao | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    let vivo = true;
    setCarregando(true);
    setErro(null);
    consultarImpactoSituacao(requisicaoId)
      .then((r) => vivo && setImpacto(r))
      .catch((e) => vivo && setErro((e as Error).message))
      .finally(() => vivo && setCarregando(false));
    return () => {
      vivo = false;
    };
  }, [requisicaoId]);

  if (carregando) {
    return (
      <p className="text-caption text-muted-foreground">Consultando o impacto na Sinqia…</p>
    );
  }
  if (erro) {
    return (
      <p className="text-caption text-muted-foreground">
        Não foi possível consultar o impacto ({erro}). Confira as propostas do tomador antes de
        aprovar.
      </p>
    );
  }
  if (!impacto?.aplicavel) return null;

  const total = impacto.totalEmAndamento ?? 0;
  const comPropostas = (impacto.tomadores ?? []).filter((t) => t.emAndamento > 0);
  const comErro = (impacto.tomadores ?? []).filter((t) => t.erro);

  if (total === 0 && comErro.length === 0) {
    return (
      <p className="text-caption text-muted-foreground">
        Impacto conferido: nenhuma proposta em andamento para {impacto.total === 1 ? "este tomador" : "os tomadores deste lote"}.
      </p>
    );
  }

  return (
    <section>
      <h3 className="mb-2 text-subheading text-foreground">Impacto desta inativação</h3>
      <div className="space-y-2 rounded-lg border border-warning/50 bg-warning/10 p-3">
        <p className="text-body">
          <strong>
            {total === 1 ? "1 proposta em andamento" : `${total} propostas em andamento`}
          </strong>{" "}
          {comPropostas.length === 1
            ? "deste tomador"
            : `de ${comPropostas.length} tomadores deste lote`}{" "}
          {total === 1 ? "segue" : "seguem"} na esteira. Inativar o cadastro agora afeta o
          andamento {total === 1 ? "dela" : "delas"}.
        </p>
        <ul className="space-y-1 text-caption text-muted-foreground">
          {comPropostas.map((t) => (
            <li key={t.documento}>
              <span className="text-foreground">{t.nome || t.documento}</span>:{" "}
              {t.propostas.map((p) => `nº ${p.nrProsp} (${p.dsStatus})`).join(" · ")}
              {t.emAndamento > t.propostas.length && ` … +${t.emAndamento - t.propostas.length}`}
            </li>
          ))}
        </ul>
        {impacto.parcial && (
          <p className="text-caption text-muted-foreground">
            Amostra dos primeiros {impacto.consultados} de {impacto.total} tomadores do lote.
          </p>
        )}
        {comErro.length > 0 && (
          <p className="text-caption text-muted-foreground">
            {comErro.length} tomador(es) não puderam ser consultados — o impacto pode ser maior.
          </p>
        )}
      </div>
    </section>
  );
}

function PayloadSituacaoTomador({
  payload,
  resultado,
  estado,
}: {
  payload: Record<string, unknown>;
  resultado?: Record<string, unknown> | null;
  estado: string;
}) {
  const alvo = (payload.alvo as Record<string, unknown>) || {};
  const cdSituacao = payload.cdSituacao as number;

  /*
   * O rótulo vem de `situacaoLabel` (shared) — fonte ÚNICA da tabela de
   * situações, no formato "2 — INATIVO" usado no resto da UI. O mapa manual que
   * existia aqui invertia os códigos (1→"Inativo", 2→"Ativo"), então uma
   * requisição de INATIVAÇÃO aparecia como "Ativo" para quem ia decidir.
   */
  const rotuloSituacao = situacaoLabel(cdSituacao) || "—";

  const propostasAfetadas = typeof resultado?.propostasAfetadas === "number" ? resultado.propostasAfetadas : null;

  return (
    <>
      <section>
        <h3 className="mb-2 text-subheading text-foreground">Alteração de Situação</h3>
        <div className="grid gap-1 rounded-lg border border-border p-3">
          <LinhaDetalhe rotulo="Tomador" valor={String(alvo.nome || "—")} />
          <LinhaDetalhe rotulo="CPF/CNPJ" valor={alvo.documento ? formatCpf(String(alvo.documento)) : "—"} />
          <LinhaDetalhe rotulo="Situação Anterior" valor={String(alvo.situacaoAnterior || "—")} />
          <LinhaDetalhe rotulo="Nova Situação" valor={rotuloSituacao} />
        </div>
      </section>

      {/* Impacto da alteração de situação (propostas afetadas) */}
      {(estado === "executada" || estado === "falha") && propostasAfetadas !== null && (
        <section className="mt-4">
          <h3 className="mb-2 text-subheading text-foreground">Impacto da alteração</h3>
          <div className="rounded-lg border border-warning/50 bg-warning/10 p-3">
            <LinhaDetalhe 
              rotulo="Propostas afetadas" 
              valor={`${propostasAfetadas} proposta(s) ativa(s) pertencente(s) a este tomador sofreram impacto.`}
            />
          </div>
        </section>
      )}
    </>
  );
}

/** Cor e rótulo de cada estado de ITEM — semântica de fila de execução. */
const BADGE_ITEM: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" | "success" | "warning" }> = {
  pendente: { label: "Pendente", variant: "warning" },
  "aprovada/executando": { label: "Executando", variant: "default" },
  executada: { label: "Executada", variant: "success" },
  falha: { label: "Falha", variant: "destructive" },
  reprovada: { label: "Reprovada", variant: "destructive" },
  cancelada: { label: "Cancelada", variant: "secondary" },
  descartada: { label: "Descartada", variant: "outline" },
};

/**
 * Uma linha do placar de DOIS NÍVEIS (US-07): o placar de um tipo de item,
 * com as falhas de proposta separadas por natureza (conferência automática ×
 * tomador não criado × Sinqia).
 */
function PlacarTipoLinha({
  rotulo,
  placar,
  falhasDetalhadas,
}: {
  rotulo: string;
  placar: PlacarLote;
  falhasDetalhadas?: { conferencia: number; tomador: number; sinqia: number };
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="min-w-24 text-caption font-semibold uppercase tracking-wide text-muted-foreground">
        {rotulo} ({placar.total})
      </span>
      {placar.pendentes > 0 && <Badge variant="warning">{placar.pendentes} pendente(s)</Badge>}
      {placar.executando > 0 && <Badge>{placar.executando} executando</Badge>}
      {placar.executadas > 0 && <Badge variant="success">{placar.executadas} executada(s)</Badge>}
      {falhasDetalhadas ? (
        <>
          {falhasDetalhadas.conferencia > 0 && (
            <Badge variant="destructive">
              {falhasDetalhadas.conferencia} falha(s) de conferência
            </Badge>
          )}
          {falhasDetalhadas.tomador > 0 && (
            <Badge variant="destructive">
              {falhasDetalhadas.tomador} sem tomador criado
            </Badge>
          )}
          {falhasDetalhadas.sinqia > 0 && (
            <Badge variant="destructive">{falhasDetalhadas.sinqia} falha(s) Sinqia</Badge>
          )}
        </>
      ) : (
        placar.falhas > 0 && <Badge variant="destructive">{placar.falhas} falha(s)</Badge>
      )}
      {placar.reprovadas > 0 && (
        <Badge variant="destructive">{placar.reprovadas} reprovada(s)</Badge>
      )}
      {placar.canceladas > 0 && <Badge variant="secondary">{placar.canceladas} cancelada(s)</Badge>}
    </div>
  );
}

const FILTROS_ITEM = [
  { chave: "todos", label: "Todos" },
  { chave: "pendente", label: "Pendentes" },
  { chave: "executada", label: "Executadas" },
  { chave: "falha", label: "Falhas" },
  { chave: "reprovada", label: "Reprovadas" },
] as const;

type FiltroItem = (typeof FILTROS_ITEM)[number]["chave"];

/**
 * Itens do lote (US-06): placar, progresso da execução (o detalhe é
 * consultado em polling pela página), busca, marcação de exceção inline
 * (aprovador) e resultado final com falhas destacadas e erro legível por item.
 */
function LoteItens({
  requisicao,
  itens,
  placar,
  placarPorTipo,
  marcacao,
  acoesFalha,
}: {
  requisicao: RequisicaoSod;
  itens: ItemLoteResumo[];
  placar?: PlacarLote;
  placarPorTipo?: Partial<Record<TipoAcaoSod, PlacarLote>>;
  marcacao?: MarcacaoExcecoes;
  acoesFalha?: {
    isMinhaRequisicao: boolean;
    onRetry: (itemId: string) => void;
    onDescarte: (itemId: string, motivo: string) => void;
  };
}) {
  const [busca, setBusca] = useState("");
  const [filtro, setFiltro] = useState<FiltroItem>("todos");
  const [abertos, setAbertos] = useState<Set<string>>(new Set());

  const executando = requisicao.estado === "aprovada/executando";
  const total = placar?.total ?? itens.length;
  // Alvo da execução: itens que a decisão mandou executar.
  const alvo = placar ? placar.total - placar.reprovadas - placar.canceladas : itens.length;
  const processados = placar ? placar.executadas + placar.falhas : 0;
  const pct = alvo > 0 ? Math.round((processados / alvo) * 100) : 0;

  // Lote COMPOSTO (US-07): itens de dois tipos com vínculo tomador→proposta.
  const misto = useMemo(() => new Set(itens.map((i) => i.tipo)).size > 1, [itens]);
  const colunas = (misto ? 6 : 5) + (marcacao || acoesFalha ? 1 : 0);
  const ordemPorId = useMemo(() => new Map(itens.map((i) => [i.id, i.ordem])), [itens]);
  /** Propostas vinculadas por item de tomador — alimenta o aviso de impacto. */
  const dependentesPorId = useMemo(() => {
    const m = new Map<string, number>();
    for (const i of itens) {
      if (!i.dependeDeItemId) continue;
      m.set(i.dependeDeItemId, (m.get(i.dependeDeItemId) ?? 0) + 1);
    }
    return m;
  }, [itens]);
  /** Falhas de proposta por natureza: conferência × tomador não criado × Sinqia. */
  const falhasProposta = useMemo(() => {
    const f = { conferencia: 0, tomador: 0, sinqia: 0 };
    for (const i of itens) {
      if (i.tipo !== "proposta.criar" || i.estado !== "falha") continue;
      if (i.resultado?.causa === "conferencia_reprovada") f.conferencia++;
      else if (i.resultado?.causa === "tomador_nao_criado") f.tomador++;
      else f.sinqia++;
    }
    return f;
  }, [itens]);

  const filtrados = useMemo(() => {
    const q = busca.trim().toLowerCase();
    return itens.filter((i) => {
      if (filtro !== "todos" && i.estado !== filtro) return false;
      if (!q) return true;
      return (
        String(i.ordem).includes(q) ||
        (i.resumo.nome ?? "").toLowerCase().includes(q) ||
        (i.resumo.documento ?? "").toLowerCase().includes(q) ||
        (i.documento ?? "").toLowerCase().includes(q)
      );
    });
  }, [itens, busca, filtro]);

  const toggleAberto = (id: string) =>
    setAbertos((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const [motivoDescarte, setMotivoDescarte] = useState<Record<string, string>>({});

  return (
    <section>
      <h3 className="mb-2 text-subheading text-foreground">
        Itens do lote{placar ? ` (${total})` : ""}
      </h3>

      {/* Placar (RN01) — sempre visível; é o resumo vivo do lote */}
      {placar && (
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          {placar.pendentes > 0 && <Badge variant="warning">{placar.pendentes} pendente(s)</Badge>}
          {placar.executando > 0 && <Badge>{placar.executando} executando</Badge>}
          {placar.executadas > 0 && (
            <Badge variant="success">{placar.executadas} executada(s)</Badge>
          )}
          {placar.falhas > 0 && <Badge variant="destructive">{placar.falhas} falha(s)</Badge>}
          {placar.reprovadas > 0 && (
            <Badge variant="destructive">{placar.reprovadas} reprovada(s)</Badge>
          )}
          {placar.canceladas > 0 && (
            <Badge variant="secondary">{placar.canceladas} cancelada(s)</Badge>
          )}
        </div>
      )}

      {/* Placar de DOIS NÍVEIS (US-07): tomadores × propostas, com a natureza
          das falhas de proposta (conferência × tomador não criado × Sinqia) */}
      {misto && placarPorTipo && (
        <div className="mb-3 grid gap-1.5 rounded-lg border border-border p-3">
          {placarPorTipo["tomador.cadastrar"] && (
            <PlacarTipoLinha rotulo="Tomadores" placar={placarPorTipo["tomador.cadastrar"]} />
          )}
          {placarPorTipo["proposta.criar"] && (
            <PlacarTipoLinha
              rotulo="Propostas"
              placar={placarPorTipo["proposta.criar"]}
              falhasDetalhadas={falhasProposta}
            />
          )}
        </div>
      )}

      {/* Progresso da execução sequencial — atualizado pelo polling da página */}
      {executando && (
        <div className="mb-3 rounded-lg border border-border bg-[var(--muted)]/40 p-3">
          <p className="mb-2 text-sm tabular-nums">
            Executando na Sinqia com a sessão do aprovador… {processados}/{alvo} item(ns)
            concluído(s).
          </p>
          <Progress value={pct} />
        </div>
      )}

      {/* Busca + filtro por estado */}
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            placeholder="Buscar por nome, documento ou linha"
            className="h-8 w-64 pl-8"
          />
        </div>
        {FILTROS_ITEM.map((f) => (
          <Button
            key={f.chave}
            variant={filtro === f.chave ? "default" : "outline"}
            size="sm"
            onClick={() => setFiltro(f.chave)}
          >
            {f.label}
          </Button>
        ))}
      </div>

      <div className="max-h-96 overflow-y-auto rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-14">Linha</TableHead>
              {misto && <TableHead>Tipo</TableHead>}
              <TableHead>Nome</TableHead>
              <TableHead>Documento</TableHead>
              <TableHead>Estado</TableHead>
              <TableHead>Desfecho</TableHead>
              {(marcacao || acoesFalha) && <TableHead className="text-right">Ações</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtrados.map((item) => {
              const badge = BADGE_ITEM[item.estado] ?? {
                label: item.estado,
                variant: "secondary" as const,
              };
              const causaItem =
                item.estado === "falha" && item.resultado?.causa
                  ? (ROTULO_CAUSA[item.resultado.causa] ?? item.resultado.causa)
                  : null;
              const mensagem = item.resultado?.mensagens || item.resultado?.detalhe || "";
              const temDetalhe = !!(causaItem || mensagem || item.motivo);
              const aberto = abertos.has(item.id);
              const marcado = marcacao ? item.id in marcacao.excecoes : false;
              const dependentes = dependentesPorId.get(item.id) ?? 0;
              return (
                <Fragment key={item.id}>
                  <TableRow
                    className={
                      item.estado === "falha"
                        ? "bg-[var(--destructive)]/5"
                        : marcado
                          ? "bg-[var(--warning)]/10"
                          : undefined
                    }
                  >
                    <TableCell className="tabular-nums text-muted-foreground">
                      {item.ordem}
                    </TableCell>
                    {misto && (
                      <TableCell>
                        <span className="inline-flex items-center gap-1 whitespace-nowrap">
                          <Badge variant="outline">
                            {item.tipo === "tomador.cadastrar" ? "Tomador" : "Proposta"}
                          </Badge>
                          {item.dependeDeItemId && (
                            <span
                              className="text-caption text-muted-foreground"
                              title="Só executa após o cadastro do tomador vinculado"
                            >
                              → item {ordemPorId.get(item.dependeDeItemId) ?? "?"}
                            </span>
                          )}
                        </span>
                      </TableCell>
                    )}
                    <TableCell className="max-w-48 truncate font-medium">
                      {item.resumo.nome || "—"}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {item.resumo.documento || item.documento || "—"}
                    </TableCell>
                    <TableCell>
                      <span className="inline-flex items-center gap-1.5">
                        <Badge variant={badge.variant}>{badge.label}</Badge>
                        {marcado && <Badge variant="warning">exceção</Badge>}
                      </span>
                    </TableCell>
                    <TableCell>
                      {temDetalhe ? (
                        <button
                          onClick={() => toggleAberto(item.id)}
                          className="focus-ring flex items-center gap-1 text-caption text-primary hover:underline"
                        >
                          {aberto ? (
                            <ChevronDown className="h-3 w-3" />
                          ) : (
                            <ChevronRight className="h-3 w-3" />
                          )}
                          {aberto ? "ocultar" : "ver"}
                        </button>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    {(marcacao || acoesFalha) && (
                      <TableCell className="text-right">
                        {item.estado === "pendente" && marcacao ? (
                          <Button
                            variant={marcado ? "destructive" : "outline"}
                            size="sm"
                            onClick={() => marcacao.onMarcar(item.id, marcado ? null : "")}
                          >
                            {marcado ? "Desmarcar" : "Marcar exceção"}
                          </Button>
                        ) : item.estado === "falha" && acoesFalha && acoesFalha.isMinhaRequisicao ? (
                          <span className="text-caption text-muted-foreground" title="Apenas outro operador pode decidir a falha">Sem permissão</span>
                        ) : item.estado === "falha" && acoesFalha && !acoesFalha.isMinhaRequisicao ? (
                          <div className="flex justify-end gap-2 items-center">
                            {(() => {
                              const pai = item.dependeDeItemId ? itens.find(i => i.id === item.dependeDeItemId) : null;
                              const bloqueadoPeloPai = pai && pai.estado !== "executada";
                              return (
                                <>
                                  {bloqueadoPeloPai && (
                                    <span className="text-[10px] text-[var(--destructive)] max-w-32 text-right leading-tight" title={`Bloqueado pelo item ${pai.ordem}`}>
                                      Tomador pendente/falha
                                    </span>
                                  )}
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    disabled={!!bloqueadoPeloPai}
                                    title={bloqueadoPeloPai ? `Bloqueado pelo item ${pai.ordem} que não está executado` : "Reprocessar item em falha"}
                                    onClick={() => acoesFalha.onRetry(item.id)}
                                  >
                                    Reprocessar
                                  </Button>
                                </>
                              );
                            })()}
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => {
                                const m = motivoDescarte[item.id];
                                if (!m?.trim()) {
                                  alert("Preencha o motivo do descarte no detalhe expandido do item antes de descartá-lo.");
                                  if (!abertos.has(item.id)) toggleAberto(item.id);
                                  return;
                                }
                                acoesFalha.onDescarte(item.id, m.trim());
                              }}
                            >
                              Descartar
                            </Button>
                          </div>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                    )}
                  </TableRow>

                  {/* Motivo da exceção — obrigatório, inline (RN03) */}
                  {marcacao && marcado && (
                    <TableRow>
                      <TableCell colSpan={colunas} className="bg-[var(--warning)]/10">
                        <div className="space-y-1 py-1">
                          <label
                            htmlFor={`motivo-excecao-${item.id}`}
                            className="text-caption font-medium"
                          >
                            Motivo da exceção (obrigatório)
                          </label>
                          <Input
                            id={`motivo-excecao-${item.id}`}
                            value={marcacao.excecoes[item.id] ?? ""}
                            onChange={(e) => marcacao.onMarcar(item.id, e.target.value)}
                            placeholder="Ex.: documentação divergente para este tomador"
                          />
                          {/* Aviso de IMPACTO (US-07, Cenário 4): exceção em tomador
                              com propostas vinculadas as reprova junto */}
                          {dependentes > 0 && (
                            <p className="text-caption font-medium text-[var(--destructive)]">
                              Impacto: {dependentes} proposta(s) vinculada(s) a este tomador
                              serão REPROVADAS junto, com este motivo propagado.
                            </p>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  )}

                  {/* Desfecho/erro legível por item */}
                  {aberto && temDetalhe && (
                    <TableRow>
                      <TableCell colSpan={colunas} className="bg-muted/40">
                        <div className="space-y-1 text-caption">
                          {item.motivo && (
                            <div>
                              <span className="font-semibold">motivo:</span> {item.motivo}
                            </div>
                          )}
                          {causaItem && (
                            <div>
                              <span className="font-semibold">causa:</span> {causaItem}
                            </div>
                          )}
                          {mensagem && (
                            <div>
                              <span className="font-semibold">Sinqia:</span> {mensagem}
                            </div>
                          )}
                          {typeof item.resultado?.duracaoMs === "number" && (
                            <div className="text-muted-foreground">
                              executado em {item.resultado.duracaoMs} ms
                            </div>
                          )}
                          {item.estado === "falha" && acoesFalha && !acoesFalha.isMinhaRequisicao && (
                            <div className="mt-2 space-y-1.5 pt-2 border-t border-border/50">
                              <label
                                htmlFor={`motivo-descarte-${item.id}`}
                                className="text-caption font-medium"
                              >
                                Motivo do descarte (obrigatório para descartar)
                              </label>
                              <Input
                                id={`motivo-descarte-${item.id}`}
                                value={motivoDescarte[item.id] ?? ""}
                                onChange={(e) => setMotivoDescarte(p => ({ ...p, [item.id]: e.target.value }))}
                                placeholder="Ex.: erro no arquivo enviado"
                                className="max-w-sm h-8 text-xs"
                              />
                            </div>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              );
            })}
            {filtrados.length === 0 && (
              <TableRow>
                <TableCell colSpan={colunas} className="py-6 text-center text-muted-foreground">
                  Nenhum item para esta busca/filtro.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}
