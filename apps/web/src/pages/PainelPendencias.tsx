import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Ban,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Inbox,
  Loader2,
  RefreshCw,
  ShieldAlert,
  ThumbsDown,
  ThumbsUp,
  XCircle,
} from "lucide-react";
  ROTULO_TIPO_ACAO,
  TIPOS_ACAO_SOD,
  ehTipoLote,
  normalizarLogin,
  requisicaoDecidivelPor,
} from "@cadastro-lote/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Combobox } from "@/components/ui/combobox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  decidirLote,
  decidirRequisicao,
  detalharRequisicao,
  listarPendencias,
  listarRequisitantesPendentes,
  reprocessarFalha,
  descartarFalha,
  reprocessarFalhasLote,
  reprocessarItemLote,
  descartarItemLote,
  type DetalheRequisicao,
  type ExecucaoResumo,
  type RequisicaoSod,
} from "@/lib/api";
import { SessaoExpiradaError, useSession } from "@/lib/session";
import { BadgeEstado } from "@/pages/MinhasRequisicoes";
import {
  RequisicaoDetalhe,
  contagemDoPayload,
  formatarTs,
  nomeDoPayload,
} from "@/components/RequisicaoDetalhe";

/**
 * Esteira de Aprovação (SoD) — Painel de pendências (US-03, lado do
 * APROVADOR): todas as requisições pendentes, da mais antiga para a mais nova
 * (RN01), com decisão individual. Aprovar EXECUTA na Sinqia NA SESSÃO DO
 * APROVADOR (B2'); reprovar exige motivo e nunca chama a Sinqia. Requisições
 * criadas pelo próprio usuário aparecem, mas outro operador precisa decidi-las
 * (maker-checker — o domínio também bloqueia).
 */

const PAGE_SIZE = 20;

/** Fase da decisão em andamento — dirige a UI de progresso do drawer. */
type FaseDecisao = "aprovando" | "reprovando" | "reprocessando" | "descartando" | null;

export function PainelPendencias({ ativa }: { ativa: boolean }) {
  const { session } = useSession();
  const meuLogin = session ? normalizarLogin(session.username) : "";

  /* --------------------------- listagem --------------------------- */
  const [estadoFiltro, setEstadoFiltro] = useState<"pendente" | "falha">("pendente");
  const [filtroTipo, setFiltroTipo] = useState("");
  const [filtroCriador, setFiltroCriador] = useState("");
  const [criadores, setCriadores] = useState<string[]>([]);
  const [pagina, setPagina] = useState(0);
  const [dados, setDados] = useState<{ itens: RequisicaoSod[]; total: number } | null>(null);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    setErro(null);
    setCarregando(true);
    try {
      const [lista, reqs] = await Promise.all([
        listarPendencias({
          tipo: filtroTipo || undefined,
          requisitante: filtroCriador || undefined,
          estado: estadoFiltro,
          limit: PAGE_SIZE,
          offset: pagina * PAGE_SIZE,
        }),
        listarRequisitantesPendentes(estadoFiltro),
      ]);
      setDados(lista);
      setCriadores(reqs);
    } catch (e) {
      if (!(e instanceof SessaoExpiradaError)) setErro((e as Error).message);
    } finally {
      setCarregando(false);
    }
  }, [filtroTipo, filtroCriador, estadoFiltro, pagina]);

  useEffect(() => {
    if (!ativa) return;
    void carregar();
  }, [ativa, carregar]);

  const totalPaginas = dados ? Math.max(1, Math.ceil(dados.total / PAGE_SIZE)) : 1;

  /* ---------------------------- detalhe ---------------------------- */
  const [detalheId, setDetalheId] = useState<string | null>(null);
  const [detalhe, setDetalhe] = useState<DetalheRequisicao | null>(null);
  const [detalheCarregando, setDetalheCarregando] = useState(false);
  const [detalheErro, setDetalheErro] = useState<string | null>(null);

  async function abrirDetalhe(id: string) {
    setDetalheId(id);
    setDetalhe(null);
    setDetalheErro(null);
    setAvisoDecisao(null);
    setDesfecho(null);
    setExcecoes({});
    setDetalheCarregando(true);
    try {
      setDetalhe(await detalharRequisicao(id));
    } catch (e) {
      if (e instanceof SessaoExpiradaError) setDetalheId(null);
      else setDetalheErro((e as Error).message);
    } finally {
      setDetalheCarregando(false);
    }
  }

  function fecharDetalhe() {
    setDetalheId(null);
    setDetalhe(null);
    setDetalheErro(null);
    setAvisoDecisao(null);
    setDesfecho(null);
    setExcecoes({});
  }

  /**
   * Progresso do LOTE (US-06): com a requisição aberta em
   * `aprovada/executando`, o detalhe é reconsultado (polling) — os itens são
   * persistidos, então o placar avança em tempo quase real.
   */
  const emExecucaoLote = detalhe?.requisicao.estado === "aprovada/executando";
  useEffect(() => {
    if (!detalheId || !emExecucaoLote) return;
    const timer = setInterval(async () => {
      try {
        const atual = await detalharRequisicao(detalheId);
        setDetalhe(atual);
        if (atual.requisicao.estado !== "aprovada/executando") void carregar();
      } catch {
        /* melhor-esforço: o próximo tick tenta de novo */
      }
    }, 1500);
    return () => clearInterval(timer);
  }, [detalheId, emExecucaoLote, carregar]);

  /* ---------------------------- decisão ---------------------------- */
  const [confirmAprovar, setConfirmAprovar] = useState(false);
  const [reprovarAberto, setReprovarAberto] = useState(false);
  const [motivo, setMotivo] = useState("");
  const [fase, setFase] = useState<FaseDecisao>(null);
  /** Rejeição (concorrência/SoD) — mostrada dentro do drawer, sem efeito colateral. */
  const [avisoDecisao, setAvisoDecisao] = useState<string | null>(null);
  /** Desfecho da execução da aprovação (sucesso/falha), claro e legível. */
  const [desfecho, setDesfecho] = useState<ExecucaoResumo | null>(null);
  /** Exceções por item da decisão bidirecional do LOTE (US-06): itemId → motivo. */
  const [excecoes, setExcecoes] = useState<Record<string, string>>({});

  const req = detalhe?.requisicao ?? null;
  const decidivelPorMim = req ? requisicaoDecidivelPor(req.estado, req.requisitante, meuLogin) : false;
  const minhaRequisicao = !!req && normalizarLogin(req.requisitante) === meuLogin;
  const ehLote = !!req && ehTipoLote(req.tipo);

  const totalExcecoes = Object.keys(excecoes).length;
  const excecoesSemMotivo = Object.values(excecoes).some((m) => !m.trim());
  const pendentesLote = detalhe?.placar?.pendentes ?? 0;

  /**
   * IMPACTO da propagação (US-07, Cenário 4): na direção APROVAR, exceção em
   * tomador reprova junto as propostas vinculadas a ele — o aviso aparece
   * ANTES da confirmação, e o domínio garante a propagação na decisão.
   */
  const propostasImpactadas = useMemo(() => {
    const its = detalhe?.itens ?? [];
    return its.filter(
      (i) =>
        i.estado === "pendente" &&
        i.dependeDeItemId &&
        i.dependeDeItemId in excecoes &&
        !(i.id in excecoes),
    ).length;
  }, [detalhe, excecoes]);

  function marcarExcecao(itemId: string, motivoItem: string | null) {
    setExcecoes((prev) => {
      const next = { ...prev };
      if (motivoItem === null) delete next[itemId];
      else next[itemId] = motivoItem;
      return next;
    });
  }

  async function recarregarDetalhe(id: string) {
    try {
      setDetalhe(await detalharRequisicao(id));
    } catch {
      /* melhor-esforço; a lista abaixo recarrega */
    }
  }

  async function executarDecisao(decisao: "aprovar" | "reprovar") {
    if (!req) return;
    setConfirmAprovar(false);
    setReprovarAberto(false);
    setAvisoDecisao(null);
    setDesfecho(null);
    setFase(decisao === "aprovar" ? "aprovando" : "reprovando");
    try {
      if (ehLote) {
        // Decisão bidirecional (US-06): direção-base + exceções com motivo.
        // A resposta volta já; a execução segue em background e o polling do
        // detalhe mostra o progresso item a item.
        await decidirLote(req.id, decisao, {
          motivo: decisao === "reprovar" ? motivo.trim() : motivo.trim() || undefined,
          excecoes: Object.entries(excecoes).map(([itemId, m]) => ({
            itemId,
            motivo: m.trim(),
          })),
        });
        setExcecoes({});
      } else {
        const r = await decidirRequisicao(
          req.id,
          decisao,
          decisao === "reprovar" ? motivo.trim() : undefined,
        );
        if (r.execucao) setDesfecho(r.execucao);
      }
    } catch (e) {
      if (e instanceof SessaoExpiradaError) {
        // RN03 / sessão morta no meio: o modal global orienta a reautenticação;
        // o drawer permanece — ao voltar, o operador vê o estado atual.
        setFase(null);
        void recarregarDetalhe(req.id);
        void carregar();
        return;
      }
      // Concorrência (já decidida), violação de SoD ou indisponibilidade da
      // sonda — mostra o motivo e recarrega o estado ATUAL.
      setAvisoDecisao((e as Error).message);
    }
    await recarregarDetalhe(req.id);
    setFase(null);
    setMotivo("");
    window.dispatchEvent(new Event("sod:decisao"));
    void carregar();
  }

  async function executarRetry() {
    if (!req) return;
    setFase("reprocessando");
    setAvisoDecisao(null);
    setDesfecho(null);
    try {
      if (ehLote) {
        await reprocessarFalhasLote(req.id);
      } else {
        const r = await reprocessarFalha(req.id);
        if (r.execucao) setDesfecho(r.execucao);
      }
    } catch (e) {
      if (e instanceof SessaoExpiradaError) {
        setFase(null);
        void recarregarDetalhe(req.id);
        void carregar();
        return;
      }
      setAvisoDecisao((e as Error).message);
    }
    await recarregarDetalhe(req.id);
    setFase(null);
    window.dispatchEvent(new Event("sod:decisao"));
    void carregar();
  }

  async function executarDescarte() {
    if (!req) return;
    setReprovarAberto(false);
    setFase("descartando");
    setAvisoDecisao(null);
    setDesfecho(null);
    try {
      await descartarFalha(req.id, motivo.trim());
    } catch (e) {
      if (e instanceof SessaoExpiradaError) {
        setFase(null);
        void recarregarDetalhe(req.id);
        void carregar();
        return;
      }
      setAvisoDecisao((e as Error).message);
    }
    await recarregarDetalhe(req.id);
    setFase(null);
    setMotivo("");
    window.dispatchEvent(new Event("sod:decisao"));
    void carregar();
  }

  /* ---------------------------- render ----------------------------- */

  const opcoesTipo = useMemo(
    () => [
      { value: "", label: "Todos os tipos" },
      ...TIPOS_ACAO_SOD.map((t) => ({ value: t, label: ROTULO_TIPO_ACAO[t] })),
    ],
    [],
  );
  const opcoesCriador = useMemo(
    () => [
      { value: "", label: "Todos os criadores" },
      ...criadores.map((c) => ({ value: c, label: c === meuLogin ? `${c} (você)` : c })),
    ],
    [criadores, meuLogin],
  );

  return (
    <div className="space-y-6">
      <div className="reveal">
        <h1 className="text-display text-foreground">Pendências e Falhas</h1>
        <p className="mt-1 text-body text-muted-foreground">
          Requisições aguardando decisão de um segundo operador, ou requisições que falharam na Sinqia e podem ser reprocessadas.
        </p>
      </div>

      {erro && (
        <div className="flex items-start gap-2 rounded-lg border border-[var(--destructive)] bg-[var(--destructive)]/10 px-4 py-3 text-sm text-[var(--destructive)]">
          <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{erro}</span>
        </div>
      )}

      <Card className="reveal reveal-delay-1">
        <CardHeader>
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <CardTitle>Fila de pendências</CardTitle>
              <CardDescription>
                {dados ? `${dados.total} pendência(s)` : "Carregando…"} · da mais antiga para a
                mais nova
              </CardDescription>
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <div className="w-48 space-y-1.5">
                <Label htmlFor="filtro-estado-pend">Estado</Label>
                <Combobox
                  id="filtro-estado-pend"
                  value={estadoFiltro}
                  onChange={(v) => {
                    setEstadoFiltro((v || "pendente") as "pendente" | "falha");
                    setFiltroCriador(""); // Limpa criador ao mudar estado
                    setPagina(0);
                  }}
                  options={[
                    { value: "pendente", label: "Pendentes" },
                    { value: "falha", label: "Falhas (Retry)" },
                  ]}
                />
              </div>
              <div className="w-56 space-y-1.5">
                <Label htmlFor="filtro-tipo-pend">Tipo de ação</Label>
                <Combobox
                  id="filtro-tipo-pend"
                  value={filtroTipo}
                  onChange={(v) => {
                    setFiltroTipo(v);
                    setPagina(0);
                  }}
                  options={opcoesTipo}
                />
              </div>
              <div className="w-56 space-y-1.5">
                <Label htmlFor="filtro-criador-pend">Criador</Label>
                <Combobox
                  id="filtro-criador-pend"
                  value={filtroCriador}
                  onChange={(v) => {
                    setFiltroCriador(v);
                    setPagina(0);
                  }}
                  options={opcoesCriador}
                />
              </div>
              <Button variant="outline" onClick={() => void carregar()} disabled={carregando}>
                {carregando ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4" />
                )}
                Atualizar
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {carregando && !dados ? (
            <div className="space-y-2">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
            </div>
          ) : !dados || dados.itens.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-10 text-center text-muted-foreground">
              <Inbox className="h-8 w-8" />
              <p className="text-body">
                {filtroTipo || filtroCriador
                  ? "Nenhuma pendência com esses filtros."
                  : "Nenhuma requisição aguardando decisão. Tudo em dia!"}
              </p>
            </div>
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Criada em</TableHead>
                    <TableHead>Tipo</TableHead>
                    <TableHead>Criador</TableHead>
                    <TableHead>Tomador</TableHead>
                    <TableHead>Documento</TableHead>
                    <TableHead className="text-right">Ações</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {dados.itens.map((r) => {
                    const minha = r.requisitante === meuLogin;
                    return (
                      <TableRow key={r.id}>
                        <TableCell className="whitespace-nowrap tabular-nums">
                          {formatarTs(r.criadoEm)}
                        </TableCell>
                        <TableCell>{ROTULO_TIPO_ACAO[r.tipo] ?? r.tipo}</TableCell>
                        <TableCell>
                          <span className="inline-flex items-center gap-1.5">
                            {r.requisitante}
                            {minha && <Badge variant="secondary">você</Badge>}
                          </span>
                        </TableCell>
                        <TableCell className="max-w-56 truncate">
                          <span className="inline-flex max-w-full items-center gap-1.5">
                            <span className="truncate">{nomeDoPayload(r.tipo, r.payload)}</span>
                            {contagemDoPayload(r.tipo, r.payload) !== null && (
                              <Badge variant="secondary">
                                {contagemDoPayload(r.tipo, r.payload)} itens
                              </Badge>
                            )}
                          </span>
                        </TableCell>
                        <TableCell className="tabular-nums">{r.documento ?? "—"}</TableCell>
                        <TableCell className="text-right">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => void abrirDetalhe(r.id)}
                          >
                            {minha ? "Detalhes" : estadoFiltro === "falha" ? "Analisar Falha" : "Revisar e decidir"}
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>

              {/* Paginação */}
              <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
                <span>
                  Mostrando {pagina * PAGE_SIZE + 1}–
                  {Math.min((pagina + 1) * PAGE_SIZE, dados.total)} de {dados.total}
                </span>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={pagina === 0 || carregando}
                    onClick={() => setPagina((p) => Math.max(0, p - 1))}
                  >
                    <ChevronLeft className="h-4 w-4" />
                    Anterior
                  </Button>
                  <span className="tabular-nums">
                    {pagina + 1} / {totalPaginas}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={pagina + 1 >= totalPaginas || carregando}
                    onClick={() => setPagina((p) => p + 1)}
                  >
                    Próxima
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Detalhe + decisão em drawer lateral */}
      <Drawer
        open={detalheId !== null}
        onOpenChange={(aberto) => {
          // Durante a execução não fecha: o operador acompanha o desfecho.
          if (!aberto && fase === null) fecharDetalhe();
        }}
      >
        <DrawerContent>
          <DrawerHeader>
            <DrawerTitle className="flex flex-wrap items-center gap-2">
              {req ? ROTULO_TIPO_ACAO[req.tipo] ?? req.tipo : "Requisição"}
              {req && <BadgeEstado estado={req.estado} />}
            </DrawerTitle>
            <DrawerDescription className="font-mono text-caption break-all">
              {detalheId}
            </DrawerDescription>
          </DrawerHeader>

          {detalheCarregando && (
            <div className="space-y-2">
              <Skeleton className="h-6 w-2/3" />
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-24 w-full" />
            </div>
          )}

          {detalheErro && (
            <div className="flex items-start gap-2 rounded-lg border border-[var(--destructive)] bg-[var(--destructive)]/10 px-3 py-2 text-sm text-[var(--destructive)]">
              <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{detalheErro}</span>
            </div>
          )}

          {/* Progresso: estado `executando` visível durante a aprovação */}
          {fase === "aprovando" && (
            <div className="flex items-start gap-2 rounded-lg border border-border bg-[var(--muted)]/40 px-3 py-2 text-sm">
              <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin" />
              <span>
                {ehLote
                  ? "Registrando a decisão do lote…"
                  : "Aprovada — executando o cadastro na Sinqia com a sua sessão… não feche esta janela."}
              </span>
            </div>
          )}
          {fase === "reprovando" && (
            <div className="flex items-start gap-2 rounded-lg border border-border bg-[var(--muted)]/40 px-3 py-2 text-sm">
              <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin" />
              <span>Registrando a reprovação…</span>
            </div>
          )}

          {/* Desfecho claro da execução */}
          {desfecho && desfecho.desfecho === "executada" && (
            <div className="flex items-start gap-2 rounded-lg border border-[var(--success)] bg-[var(--success)]/10 px-3 py-2 text-sm">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                <strong>Tomador cadastrado na Sinqia.</strong>
                {desfecho.mensagens ? <> {desfecho.mensagens}</> : null}
              </span>
            </div>
          )}
          {desfecho && desfecho.desfecho === "falha" && (
            <div className="flex items-start gap-2 rounded-lg border border-[var(--destructive)] bg-[var(--destructive)]/10 px-3 py-2 text-sm text-[var(--destructive)]">
              <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                <strong>A execução na Sinqia falhou.</strong>{" "}
                {desfecho.mensagens || desfecho.detalhe || "Erro não detalhado."} A requisição
                ficou como <em>falha</em> — nenhuma nova tentativa automática será feita.
              </span>
            </div>
          )}

          {avisoDecisao && (
            <div className="flex items-start gap-2 rounded-lg border border-[var(--warning)] bg-[var(--warning)]/15 px-3 py-2 text-sm">
              <Ban className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{avisoDecisao}</span>
            </div>
          )}

          {req && (
            <div className="space-y-5 text-sm">
              <RequisicaoDetalhe
                requisicao={req}
                historico={detalhe?.historico ?? []}
                itens={detalhe?.itens}
                placar={detalhe?.placar}
                placarPorTipo={detalhe?.placarPorTipo}
                marcacao={
                  ehLote && req.estado === "pendente" && decidivelPorMim
                    ? { excecoes, onMarcar: marcarExcecao }
                    : undefined
                }
                acoesFalha={
                  ehLote && req.estado === "falha"
                    ? {
                        isMinhaRequisicao: !decidivelPorMim,
                        onRetry: async (itemId) => {
                          setFase("reprocessando");
                          try {
                            await reprocessarItemLote(req.id, itemId);
                            await recarregarDetalhe(req.id);
                            window.dispatchEvent(new Event("sod:decisao"));
                            void carregar();
                          } catch (e) {
                            if (e instanceof SessaoExpiradaError) {
                              void carregar();
                              return;
                            }
                            alert((e as Error).message);
                          } finally {
                            setFase(null);
                          }
                        },
                        onDescarte: async (itemId, motivo) => {
                          setFase("descartando");
                          try {
                            await descartarItemLote(req.id, itemId, motivo);
                            await recarregarDetalhe(req.id);
                            window.dispatchEvent(new Event("sod:decisao"));
                            void carregar();
                          } catch (e) {
                            if (e instanceof SessaoExpiradaError) {
                              void carregar();
                              return;
                            }
                            alert((e as Error).message);
                          } finally {
                            setFase(null);
                          }
                        },
                      }
                    : undefined
                }
              />

              {/* Decisão — só requisição pendente de OUTRO operador */}
              {req.estado === "pendente" && (
                <div className="border-t border-border pt-4">
                  {!decidivelPorMim ? (
                    <>
                      <div className="flex gap-2">
                        <Button disabled>
                          <ThumbsUp className="h-4 w-4" />
                          Aprovar
                        </Button>
                        <Button variant="destructive" disabled>
                          <ThumbsDown className="h-4 w-4" />
                          Reprovar
                        </Button>
                      </div>
                      <p className="mt-2 flex items-start gap-1.5 text-caption text-muted-foreground">
                        <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        Você criou esta requisição — outro operador precisa decidi-la
                        (segregação de funções).
                      </p>
                    </>
                  ) : (
                    <>
                      {ehLote && totalExcecoes > 0 && (
                        <p className="mb-2 text-caption">
                          <strong>{totalExcecoes}</strong> exceção(ões) marcada(s) — receberão a
                          direção CONTRÁRIA à decisão do lote.
                          {propostasImpactadas > 0 && (
                            <span className="text-[var(--destructive)]">
                              {" "}
                              Impacto na aprovação: {propostasImpactadas} proposta(s) vinculada(s)
                              a tomadores em exceção serão REPROVADAS junto (motivo propagado).
                            </span>
                          )}
                          {excecoesSemMotivo && (
                            <span className="text-[var(--destructive)]">
                              {" "}
                              Preencha o motivo de todas para decidir.
                            </span>
                          )}
                        </p>
                      )}
                      <div className="flex gap-2">
                        <Button
                          disabled={
                            fase !== null ||
                            (ehLote && (excecoesSemMotivo || totalExcecoes >= pendentesLote))
                          }
                          onClick={() => setConfirmAprovar(true)}
                        >
                          {fase === "aprovando" ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <ThumbsUp className="h-4 w-4" />
                          )}
                          {ehLote
                            ? totalExcecoes > 0
                              ? `Aprovar lote (exceto ${totalExcecoes})`
                              : "Aprovar lote"
                            : "Aprovar"}
                        </Button>
                        <Button
                          variant="destructive"
                          disabled={fase !== null || (ehLote && excecoesSemMotivo)}
                          onClick={() => {
                            setMotivo("");
                            setReprovarAberto(true);
                          }}
                        >
                          <ThumbsDown className="h-4 w-4" />
                          {ehLote
                            ? totalExcecoes > 0
                              ? `Reprovar lote (exceto ${totalExcecoes})`
                              : "Reprovar lote"
                            : "Reprovar"}
                        </Button>
                      </div>
                      <p className="mt-2 text-caption text-muted-foreground">
                        {ehLote ? (
                          <>
                            Aprovar executa os itens SEQUENCIALMENTE na Sinqia com a sua sessão
                            (exceções são reprovadas com motivo). Reprovar exige motivo do lote
                            — e as exceções marcadas serão EXECUTADAS. Falha de um item não
                            interrompe os demais.
                            {totalExcecoes >= pendentesLote && totalExcecoes > 0 && (
                              <span className="text-[var(--destructive)]">
                                {" "}
                                Todas as linhas estão marcadas como exceção — para não executar
                                nada, use a reprovação do lote.
                              </span>
                            )}
                          </>
                        ) : (
                          <>
                            Aprovar executa o cadastro na Sinqia imediatamente, com a sua
                            sessão. Reprovar exige um motivo, visível ao requisitante.
                          </>
                        )}
                      </p>
                    </>
                  )}
                </div>
              )}

              {/* Retry / Descarte — requisição em falha de OUTRO operador */}
              {req.estado === "falha" && (
                <div className="border-t border-border pt-4">
                  {!decidivelPorMim ? (
                    <>
                      <div className="flex gap-2">
                        <Button disabled>
                          <RefreshCw className="h-4 w-4" />
                          Reprocessar
                        </Button>
                        <Button variant="outline" disabled>
                          <Ban className="h-4 w-4" />
                          Descartar
                        </Button>
                      </div>
                      <p className="mt-2 flex items-start gap-1.5 text-caption text-muted-foreground">
                        <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        Você criou esta requisição — outro operador precisa avaliar a falha e decidir o reprocessamento.
                      </p>
                    </>
                  ) : (
                    <>
                      <div className="flex gap-2">
                        <Button
                          disabled={fase !== null}
                          onClick={() => void executarRetry()}
                        >
                          {fase === "reprocessando" ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <RefreshCw className="h-4 w-4" />
                          )}
                          {ehLote ? "Reprocessar falhas elegíveis" : "Reprocessar"}
                        </Button>
                        <Button
                          variant="outline"
                          disabled={fase !== null || ehLote} // TODO: Descarte de lote todo ainda não suportado, apenas item
                          onClick={() => {
                            setMotivo("");
                            setReprovarAberto(true); // Reusa o modal de reprovação para descarte
                          }}
                        >
                          <Ban className="h-4 w-4" />
                          Descartar
                        </Button>
                      </div>
                      <p className="mt-2 text-caption text-muted-foreground">
                        {ehLote ? (
                          "O reprocessamento de lote tentará executar novamente todas as falhas elegíveis na Sinqia, usando a sua sessão."
                        ) : (
                          "O reprocessamento tentará executar o cadastro novamente na Sinqia, usando a sua sessão. Descartar encerra a requisição permanentemente e exige um motivo."
                        )}
                      </p>
                    </>
                  )}
                </div>
              )}
            </div>
          )}
        </DrawerContent>
      </Drawer>

      {/* Confirmação da aprovação */}
      <Dialog open={confirmAprovar} onOpenChange={setConfirmAprovar}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {ehLote ? "Aprovar o lote e executar na Sinqia?" : "Aprovar e executar na Sinqia?"}
            </DialogTitle>
            <DialogDescription>
              {ehLote ? (
                <>
                  A aprovação executa{" "}
                  <strong>{Math.max(0, pendentesLote - totalExcecoes - propostasImpactadas)}</strong>{" "}
                  item(ns) SEQUENCIALMENTE na Sinqia agora, usando a SUA sessão — a Sinqia
                  registrará você como executor.
                  {totalExcecoes > 0 && (
                    <>
                      {" "}
                      As <strong>{totalExcecoes}</strong> exceção(ões) marcada(s) serão
                      REPROVADAS com o motivo informado.
                    </>
                  )}
                  {propostasImpactadas > 0 && (
                    <>
                      {" "}
                      <strong className="text-[var(--destructive)]">
                        Impacto: {propostasImpactadas} proposta(s) vinculada(s) a tomadores em
                        exceção serão REPROVADAS junto, com o motivo do tomador propagado.
                      </strong>
                    </>
                  )}{" "}
                  Falha de um item não interrompe os demais; itens com falha ficam registrados
                  para tratamento posterior.
                </>
              ) : (
                <>
                  A aprovação dispara o cadastro do tomador na Sinqia agora, usando a SUA sessão
                  — a Sinqia registrará você como executor. Se a execução falhar, a requisição
                  fica como <em>falha</em>, sem nova tentativa automática.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmAprovar(false)}>
              Voltar
            </Button>
            <Button onClick={() => void executarDecisao("aprovar")}>
              <ThumbsUp className="h-4 w-4" />
              Aprovar e executar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reprovação com motivo obrigatório (validação também no domínio) */}
      <Dialog open={reprovarAberto} onOpenChange={setReprovarAberto}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {req?.estado === "falha"
                ? "Descartar esta falha?"
                : ehLote
                  ? "Reprovar este lote?"
                  : "Reprovar esta requisição?"}
            </DialogTitle>
            <DialogDescription>
              {req?.estado === "falha" ? (
                <>
                  A requisição será encerrada como <em>descartada</em> e nenhuma nova tentativa será feita. O motivo é obrigatório e ficará visível ao requisitante.
                </>
              ) : ehLote ? (
                totalExcecoes > 0 ? (
                  <>
                    <strong>{Math.max(0, pendentesLote - totalExcecoes)}</strong> item(ns) serão
                    reprovados com o motivo abaixo — e as <strong>{totalExcecoes}</strong>{" "}
                    exceção(ões) marcada(s) serão APROVADAS e executadas na Sinqia com a sua
                    sessão, sequencialmente.
                  </>
                ) : (
                  <>
                    Todos os itens serão reprovados e nada será executado na Sinqia. O motivo é
                    obrigatório e ficará visível ao requisitante.
                  </>
                )
              ) : (
                <>
                  Nada será executado na Sinqia. O motivo é obrigatório e ficará visível ao
                  requisitante no detalhe da requisição.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="motivo-reprovacao">
              {req?.estado === "falha" ? "Motivo do descarte" : "Motivo da reprovação"}
            </Label>
            <textarea
              id="motivo-reprovacao"
              value={motivo}
              onChange={(e) => setMotivo(e.target.value)}
              rows={3}
              placeholder="Ex.: documentação divergente do cadastro"
              className="focus-ring w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground"
            />
            {!motivo.trim() && (
              <p className="text-caption text-muted-foreground">
                Informe o motivo para habilitar a ação.
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReprovarAberto(false)}>
              Voltar
            </Button>
            <Button
              variant={req?.estado === "falha" ? "outline" : "destructive"}
              disabled={!motivo.trim()}
              onClick={() => void (req?.estado === "falha" ? executarDescarte() : executarDecisao("reprovar"))}
            >
              {req?.estado === "falha" ? <Ban className="h-4 w-4" /> : <ThumbsDown className="h-4 w-4" />}
              {req?.estado === "falha" ? "Descartar" : "Reprovar"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
