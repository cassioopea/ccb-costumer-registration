import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Ban,
  ChevronLeft,
  ChevronRight,
  Inbox,
  Loader2,
  RefreshCw,
  XCircle,
} from "lucide-react";
import {
  ESTADOS_REQUISICAO,
  ROTULO_TIPO_ACAO,
  TIPOS_ACAO_SOD,
  normalizarLogin,
  type EstadoRequisicao,
} from "@cadastro-lote/shared";
import { Badge, type BadgeProps } from "@/components/ui/badge";
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
  cancelarRequisicao,
  detalharRequisicao,
  listarMinhasRequisicoes,
  type DetalheRequisicao,
  type RequisicaoSod,
} from "@/lib/api";
import { SessaoExpiradaError, useSession } from "@/lib/session";
import {
  RequisicaoDetalhe,
  contagemDoPayload,
  formatarTs,
  nomeDoPayload,
} from "@/components/RequisicaoDetalhe";

/**
 * Esteira de Aprovação (SoD) — "Minhas requisições" (US-02, lado do
 * REQUISITANTE): o operador acompanha o que criou, abre o detalhe e cancela
 * pendentes. Aprovar/reprovar (lado do aprovador) chega na US-03.
 */

const PAGE_SIZE = 20;

/** Cor e rótulo de cada estado — consistente com as variantes do tema. */
const BADGE_ESTADO: Record<EstadoRequisicao, { label: string; variant: BadgeProps["variant"] }> = {
  pendente: { label: "Pendente", variant: "warning" },
  "aprovada/executando": { label: "Aprovada — executando", variant: "default" },
  executada: { label: "Executada", variant: "success" },
  falha: { label: "Falha", variant: "destructive" },
  reprovada: { label: "Reprovada", variant: "destructive" },
  cancelada: { label: "Cancelada", variant: "secondary" },
  descartada: { label: "Descartada", variant: "outline" },
};

export function BadgeEstado({ estado }: { estado: EstadoRequisicao }) {
  const cfg = BADGE_ESTADO[estado] ?? { label: estado, variant: "secondary" as const };
  return <Badge variant={cfg.variant}>{cfg.label}</Badge>;
}

export function MinhasRequisicoes({ ativa }: { ativa: boolean }) {
  const { session } = useSession();
  const meuLogin = session ? normalizarLogin(session.username) : "";

  /* --------------------------- listagem --------------------------- */
  const [filtroEstado, setFiltroEstado] = useState("");
  const [filtroTipo, setFiltroTipo] = useState("");
  const [pagina, setPagina] = useState(0);
  const [dados, setDados] = useState<{ itens: RequisicaoSod[]; total: number } | null>(null);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    setErro(null);
    setCarregando(true);
    try {
      setDados(
        await listarMinhasRequisicoes({
          estado: filtroEstado || undefined,
          tipo: filtroTipo || undefined,
          limit: PAGE_SIZE,
          offset: pagina * PAGE_SIZE,
        }),
      );
    } catch (e) {
      if (!(e instanceof SessaoExpiradaError)) setErro((e as Error).message);
    } finally {
      setCarregando(false);
    }
  }, [filtroEstado, filtroTipo, pagina]);

  // Recarrega ao entrar na página e a cada mudança de filtro/página.
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

  /**
   * Progresso do LOTE (US-06): enquanto a requisição aberta está
   * `aprovada/executando`, o detalhe é reconsultado (polling) — os estados
   * dos itens são persistidos, então o placar avança em tempo quase real.
   */
  const emExecucao = detalhe?.requisicao.estado === "aprovada/executando";
  useEffect(() => {
    if (!detalheId || !emExecucao) return;
    const timer = setInterval(async () => {
      try {
        const atual = await detalharRequisicao(detalheId);
        setDetalhe(atual);
        // Execução terminou: recarrega a lista uma vez (badge de estado).
        if (atual.requisicao.estado !== "aprovada/executando") void carregar();
      } catch {
        /* melhor-esforço: o próximo tick tenta de novo */
      }
    }, 1500);
    return () => clearInterval(timer);
  }, [detalheId, emExecucao, carregar]);

  async function abrirDetalhe(id: string) {
    setDetalheId(id);
    setDetalhe(null);
    setDetalheErro(null);
    setAvisoCancelamento(null);
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
    setAvisoCancelamento(null);
  }

  /* ------------------------- cancelamento -------------------------- */
  const [confirmCancelar, setConfirmCancelar] = useState(false);
  const [cancelando, setCancelando] = useState(false);
  /** Rejeição por concorrência (já decidida) — mostrada dentro do drawer. */
  const [avisoCancelamento, setAvisoCancelamento] = useState<string | null>(null);

  const req = detalhe?.requisicao ?? null;
  const podeCancelar = !!req && req.estado === "pendente" && req.requisitante === meuLogin;

  async function executarCancelamento() {
    if (!req) return;
    setConfirmCancelar(false);
    setAvisoCancelamento(null);
    setCancelando(true);
    try {
      await cancelarRequisicao(req.id);
    } catch (e) {
      if (e instanceof SessaoExpiradaError) {
        setCancelando(false);
        return;
      }
      // Concorrência (já decidida) ou negação — mostra o motivo e segue para
      // recarregar o estado ATUAL, sem nenhum efeito colateral.
      setAvisoCancelamento((e as Error).message);
    }
    try {
      setDetalhe(await detalharRequisicao(req.id));
    } catch {
      /* o refresh do detalhe é melhor-esforço; a lista abaixo recarrega */
    }
    setCancelando(false);
    void carregar();
  }

  /* ---------------------------- render ----------------------------- */

  const opcoesEstado = useMemo(
    () => [
      { value: "", label: "Todos os estados" },
      ...ESTADOS_REQUISICAO.map((e) => ({ value: e, label: BADGE_ESTADO[e].label })),
    ],
    [],
  );
  const opcoesTipo = useMemo(
    () => [
      { value: "", label: "Todos os tipos" },
      ...TIPOS_ACAO_SOD.map((t) => ({ value: t, label: ROTULO_TIPO_ACAO[t] })),
    ],
    [],
  );

  return (
    <div className="space-y-6">
      <div className="reveal">
        <h1 className="text-display text-foreground">Minhas requisições</h1>
        <p className="mt-1 text-body text-muted-foreground">
          Ações sensíveis enviadas para aprovação. Um segundo operador decide; enquanto a
          requisição estiver pendente, você pode cancelá-la.
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
              <CardTitle>Requisições criadas por você</CardTitle>
              <CardDescription>
                {dados ? `${dados.total} requisição(ões)` : "Carregando…"} · da mais recente
                para a mais antiga
              </CardDescription>
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <div className="w-52 space-y-1.5">
                <Label htmlFor="filtro-estado">Estado</Label>
                <Combobox
                  id="filtro-estado"
                  value={filtroEstado}
                  onChange={(v) => {
                    setFiltroEstado(v);
                    setPagina(0);
                  }}
                  options={opcoesEstado}
                />
              </div>
              <div className="w-64 space-y-1.5">
                <Label htmlFor="filtro-tipo">Tipo de ação</Label>
                <Combobox
                  id="filtro-tipo"
                  value={filtroTipo}
                  onChange={(v) => {
                    setFiltroTipo(v);
                    setPagina(0);
                  }}
                  options={opcoesTipo}
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
                {filtroEstado || filtroTipo
                  ? "Nenhuma requisição sua com esses filtros."
                  : "Você ainda não criou nenhuma requisição."}
              </p>
            </div>
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Criada em</TableHead>
                    <TableHead>Tipo</TableHead>
                    <TableHead>Tomador</TableHead>
                    <TableHead>Documento</TableHead>
                    <TableHead>Estado</TableHead>
                    <TableHead className="text-right">Ações</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {dados.itens.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="whitespace-nowrap tabular-nums">
                        {formatarTs(r.criadoEm)}
                      </TableCell>
                      <TableCell>{ROTULO_TIPO_ACAO[r.tipo] ?? r.tipo}</TableCell>
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
                      <TableCell>
                        <BadgeEstado estado={r.estado} />
                      </TableCell>
                      <TableCell className="text-right">
                        <Button variant="outline" size="sm" onClick={() => void abrirDetalhe(r.id)}>
                          Detalhes
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
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

      {/* Detalhe em drawer lateral */}
      <Drawer open={detalheId !== null} onOpenChange={(aberto) => !aberto && fecharDetalhe()}>
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

          {avisoCancelamento && (
            <div className="flex items-start gap-2 rounded-lg border border-[var(--warning)] bg-[var(--warning)]/15 px-3 py-2 text-sm">
              <Ban className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{avisoCancelamento}</span>
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
              />

              {/* Cancelar — só o criador, só pendente */}
              {podeCancelar && (
                <div className="border-t border-border pt-4">
                  <Button
                    variant="destructive"
                    disabled={cancelando}
                    onClick={() => setConfirmCancelar(true)}
                  >
                    {cancelando ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Ban className="h-4 w-4" />
                    )}
                    Cancelar requisição
                  </Button>
                  <p className="mt-1.5 text-caption text-muted-foreground">
                    Disponível porque a requisição é sua e ainda está pendente.
                  </p>
                </div>
              )}
            </div>
          )}
        </DrawerContent>
      </Drawer>

      {/* Confirmação do cancelamento */}
      <Dialog open={confirmCancelar} onOpenChange={setConfirmCancelar}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancelar esta requisição?</DialogTitle>
            <DialogDescription>
              O cancelamento é definitivo: a requisição sai da fila de aprovação e nada será
              executado na Sinqia. Para retomar, será preciso criar uma nova requisição.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmCancelar(false)}>
              Voltar
            </Button>
            <Button variant="destructive" onClick={() => void executarCancelamento()}>
              <Ban className="h-4 w-4" />
              Cancelar requisição
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
