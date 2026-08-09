import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Ban,
  ChevronLeft,
  ChevronRight,
  FileJson,
  History,
  Inbox,
  Loader2,
  RefreshCw,
  XCircle,
} from "lucide-react";
import {
  CAMPOS,
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
  type EventoAuditoriaSod,
  type RequisicaoSod,
} from "@/lib/api";
import { SessaoExpiradaError, useSession } from "@/lib/session";

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

/** Rótulo legível de cada caminho do formulário de cadastro (RN07). */
const ROTULO_POR_PATH = new Map(CAMPOS.map((c) => [c.path, c.label]));

function formatarTs(iso: string): string {
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

/** Nome do tomador dentro do payload canônico `{ campos: { dsNome } }`. */
function nomeDoPayload(payload: Record<string, unknown>): string {
  const campos = payload.campos;
  if (campos && typeof campos === "object" && !Array.isArray(campos)) {
    const nome = (campos as Record<string, unknown>).dsNome;
    if (typeof nome === "string" && nome.trim()) return nome;
  }
  return "—";
}

const ROTULO_DECISAO: Record<string, string> = {
  aprovar: "aprovação",
  reprovar: "reprovação",
  cancelar: "cancelamento",
  retry: "retry",
  descartar: "descarte",
};

/** Linha legível do histórico de auditoria. */
function descreverEvento(ev: EventoAuditoriaSod): string {
  const d = ev.detalhe as { decisao?: string; de?: string; para?: string; mensagem?: string };
  if (ev.acao === "requisicao_criada") return "Requisição criada";
  if (ev.acao === "transicao_estado") {
    const decisao = d.decisao ? ROTULO_DECISAO[d.decisao] ?? d.decisao : "transição";
    return `${d.de ?? "?"} → ${d.para ?? "?"} (${decisao})`;
  }
  if (ev.acao === "tentativa_rejeitada") {
    return `Tentativa rejeitada — ${d.mensagem ?? ev.resultado}`;
  }
  return ev.acao;
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
  const [detalhe, setDetalhe] = useState<{
    requisicao: RequisicaoSod;
    historico: EventoAuditoriaSod[];
  } | null>(null);
  const [detalheCarregando, setDetalheCarregando] = useState(false);
  const [detalheErro, setDetalheErro] = useState<string | null>(null);
  const [verJson, setVerJson] = useState(false);

  async function abrirDetalhe(id: string) {
    setDetalheId(id);
    setDetalhe(null);
    setDetalheErro(null);
    setVerJson(false);
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

  const camposDoPayload = useMemo(() => {
    const campos = req?.payload.campos;
    if (!campos || typeof campos !== "object" || Array.isArray(campos)) return [];
    return Object.entries(campos as Record<string, unknown>).map(([path, valor]) => ({
      path,
      rotulo: ROTULO_POR_PATH.get(path) ?? path,
      valor: String(valor ?? ""),
    }));
  }, [req]);

  const controlDoPayload = useMemo(() => {
    const control = req?.payload.control;
    if (!control || typeof control !== "object" || Array.isArray(control)) return [];
    return Object.entries(control as Record<string, unknown>).map(([chave, valor]) => ({
      chave,
      valor: String(valor ?? ""),
    }));
  }, [req]);

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
                        {nomeDoPayload(r.payload)}
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
              {/* Resumo */}
              <div className="grid gap-1">
                <LinhaDetalhe rotulo="Criada em" valor={formatarTs(req.criadoEm)} />
                <LinhaDetalhe rotulo="Criada por" valor={req.requisitante} />
                <LinhaDetalhe rotulo="Última atualização" valor={formatarTs(req.atualizadoEm)} />
                {req.decididoPor && <LinhaDetalhe rotulo="Decidida por" valor={req.decididoPor} />}
                {req.documento && <LinhaDetalhe rotulo="Documento" valor={req.documento} />}
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

              {/* Dados do tomador em campos nomeados (RN07) */}
              <section>
                <h3 className="mb-2 text-subheading text-foreground">Dados do tomador</h3>
                {camposDoPayload.length === 0 ? (
                  <p className="text-muted-foreground">
                    O payload desta requisição não está no formato do formulário de cadastro —
                    consulte o JSON integral abaixo.
                  </p>
                ) : (
                  <div className="grid gap-1 rounded-lg border border-border p-3">
                    {camposDoPayload.map((c) => (
                      <div key={c.path} className="flex gap-2">
                        <span
                          className="min-w-44 shrink-0 text-muted-foreground"
                          title={c.path}
                        >
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
                <h3 className="mb-2 flex items-center gap-1.5 text-subheading text-foreground">
                  <History className="h-4 w-4" />
                  Histórico
                </h3>
                <ol className="space-y-2">
                  {(detalhe?.historico ?? []).map((ev) => (
                    <li key={ev.id} className="rounded-lg border border-border px-3 py-2">
                      <p>{descreverEvento(ev)}</p>
                      <p className="mt-0.5 text-caption text-muted-foreground">
                        {formatarTs(ev.ts)} · {ev.ator}
                        {typeof ev.detalhe.motivo === "string" && (
                          <> · motivo: {ev.detalhe.motivo}</>
                        )}
                      </p>
                    </li>
                  ))}
                </ol>
              </section>

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

function LinhaDetalhe({ rotulo, valor }: { rotulo: string; valor: string }) {
  return (
    <div className="flex gap-2">
      <span className="min-w-44 shrink-0 text-muted-foreground">{rotulo}</span>
      <span className="break-all">{valor}</span>
    </div>
  );
}
