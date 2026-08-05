import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Download,
  FileSearch,
  ListChecks,
  Loader2,
  RefreshCw,
  Search,
  X,
  XCircle,
} from "lucide-react";
import { matchCliente, SITUACOES, situacaoLabel } from "@cadastro-lote/shared";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { IS_PROD } from "@/components/Topbar";
import { cn } from "@/lib/utils";
import {
  getDadosProposta,
  listarPropostasCliente,
  listarTodosClientes,
  startAlterarSituacao,
  streamSituacao,
  type ClienteResumo,
  type DadosProposta,
  type PropostaResumo,
  type SituacaoRowResult,
  type TodosClientesResponse,
} from "@/lib/api";
import { formatBRL, formatDataAAAAMMDD } from "@/lib/format";
import { exportSituacaoCsv } from "@/lib/export-csv";
import {
  MARGEM_CURTA_MS,
  SessaoExpiradaError,
  formatarRestante,
  useRestante,
  useSession,
} from "@/lib/session";

type Phase = "idle" | "carregando" | "carregado" | "alterando" | "done";

/** Teto de linhas renderizadas. Filtrar é barato; desenhar 20 mil <tr> não é. */
const MAX_LINHAS_VISIVEIS = 200;

export function SituacaoClientes({ ativa = true }: { ativa?: boolean }) {
  const [tipoPessoa, setTipoPessoa] = useState("");
  const [filtro, setFiltro] = useState("");

  /* ---------------------------------------------------------------- */
  /* Propostas do cliente (consulta por linha)                          */
  /* ---------------------------------------------------------------- */

  /** Cliente cujo diálogo de propostas está aberto. */
  const [propCliente, setPropCliente] = useState<ClienteResumo | null>(null);
  const [propostas, setPropostas] = useState<PropostaResumo[]>([]);
  const [propLoading, setPropLoading] = useState(false);
  const [propError, setPropError] = useState<string | null>(null);
  /** Detalhe aberto dentro do diálogo (null = mostrando a lista). */
  const [propDetalhe, setPropDetalhe] = useState<{ nrProsp: number; dados: DadosProposta } | null>(null);
  const [propDetalheLoading, setPropDetalheLoading] = useState(false);

  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [base, setBase] = useState<TodosClientesResponse | null>(null);

  /**
   * Seleção por `nrCliente`, guardando o cliente inteiro.
   *
   * Fica FORA da lista exibida de propósito: filtrar, recarregar ou trocar o
   * tipo de pessoa não desmarca nada. É o que permite ir juntando clientes de
   * buscas diferentes e alterar todos de uma vez.
   */
  const [selecionados, setSelecionados] = useState<Map<number, ClienteResumo>>(new Map());
  const [cdSituacao, setCdSituacao] = useState<number>(SITUACOES[0].codigo);

  const [progress, setProgress] = useState({
    processed: 0,
    total: 0,
    success: 0,
    error: 0,
    naoEnviado: 0,
  });
  const [results, setResults] = useState<SituacaoRowResult[]>([]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [verSelecionados, setVerSelecionados] = useState(false);

  const busy = phase === "carregando" || phase === "alterando";
  const totalSelecionados = selecionados.size;
  const podeAlterar = totalSelecionados > 0 && !busy;

  /** Rola até o progresso assim que a alteração em lote começa. */
  const progressoRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (phase === "alterando") {
      progressoRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [phase]);

  /** Sem renovação automática, uma alteração em lote pode ser interrompida. */
  const { session } = useSession();
  const restanteSessao = useRestante(session);
  const sessaoCurta = restanteSessao > 0 && restanteSessao < MARGEM_CURTA_MS;

  const carregar = useCallback(async () => {
    setError(null);
    setPhase("carregando");
    try {
      const res = await listarTodosClientes(tipoPessoa || undefined);
      setBase(res);
      setPhase("carregado");
    } catch (e) {
      // Sessão expirada já abre o modal de reautenticação — não vira erro na tela.
      if (!(e instanceof SessaoExpiradaError)) setError((e as Error).message);
      setPhase(base ? "carregado" : "idle");
    }
  }, [tipoPessoa, base]);

  /**
   * A função principal da aba é VER a base — carrega sozinha na primeira vez
   * que a aba fica ativa (as telas ficam montadas ocultas; sem o gate `ativa`,
   * a varredura dispararia no login para todo mundo).
   */
  useEffect(() => {
    if (ativa && !base && phase === "idle") void carregar();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- só na 1ª ativação
  }, [ativa]);

  /** Abre o diálogo de propostas de um cliente e busca a lista na Sinqia. */
  async function abrirPropostas(c: ClienteResumo) {
    setPropCliente(c);
    setPropostas([]);
    setPropDetalhe(null);
    setPropError(null);
    setPropLoading(true);
    try {
      const res = await listarPropostasCliente(c.documento);
      setPropostas(res.propostas);
    } catch (e) {
      if (e instanceof SessaoExpiradaError) setPropCliente(null);
      else setPropError((e as Error).message);
    } finally {
      setPropLoading(false);
    }
  }

  /** Carrega o detalhe (principal + parcelas) de uma proposta dentro do diálogo. */
  async function verDadosProposta(nrProsp: number) {
    setPropDetalheLoading(true);
    setPropError(null);
    try {
      const res = await getDadosProposta(nrProsp);
      setPropDetalhe({ nrProsp, dados: res.dados });
    } catch (e) {
      if (e instanceof SessaoExpiradaError) setPropCliente(null);
      else setPropError((e as Error).message);
    } finally {
      setPropDetalheLoading(false);
    }
  }

  /** Ação por linha: prepara a alteração de situação SÓ deste cliente. */
  const acaoCardRef = useRef<HTMLDivElement>(null);
  function alterarSituacaoDe(c: ClienteResumo) {
    if (c.nrCliente === null) return;
    setSelecionados(new Map([[c.nrCliente, c]]));
    acaoCardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  /* ---------------------------------------------------------------- */
  /* Filtro local: número do cliente, nome ou CPF/CNPJ                 */
  /* ---------------------------------------------------------------- */

  const filtrados = useMemo(() => {
    const itens = base?.items ?? [];
    if (!filtro.trim()) return itens;
    return itens.filter((c) => matchCliente(c, filtro));
  }, [base, filtro]);

  const visiveis = filtrados.slice(0, MAX_LINHAS_VISIVEIS);
  const ocultos = filtrados.length - visiveis.length;

  /** Só dá para alterar quem tem nrCliente — é a chave do POST. */
  const selecionaveis = useMemo(
    () => filtrados.filter((c) => c.nrCliente !== null),
    [filtrados],
  );
  const semChave = filtrados.length - selecionaveis.length;

  const todosFiltradosSelecionados =
    selecionaveis.length > 0 && selecionaveis.every((c) => selecionados.has(c.nrCliente!));

  const toggleUm = (c: ClienteResumo) => {
    if (c.nrCliente === null) return;
    setSelecionados((prev) => {
      const next = new Map(prev);
      if (next.has(c.nrCliente!)) next.delete(c.nrCliente!);
      else next.set(c.nrCliente!, c);
      return next;
    });
  };

  /** Marca/desmarca TODOS os que casam com o filtro, não só os visíveis. */
  const toggleFiltrados = () => {
    setSelecionados((prev) => {
      const next = new Map(prev);
      if (todosFiltradosSelecionados) {
        for (const c of selecionaveis) next.delete(c.nrCliente!);
      } else {
        for (const c of selecionaveis) next.set(c.nrCliente!, c);
      }
      return next;
    });
  };

  const removerSelecionado = (nr: number) =>
    setSelecionados((prev) => {
      const next = new Map(prev);
      next.delete(nr);
      return next;
    });

  const limparSelecao = () => setSelecionados(new Map());

  /* ---------------------------------------------------------------- */
  /* Alteração                                                         */
  /* ---------------------------------------------------------------- */

  function handleAlterarClick() {
    if (!podeAlterar) return;
    if (IS_PROD) setConfirmOpen(true);
    else void executarAlteracao();
  }

  async function executarAlteracao() {
    setConfirmOpen(false);
    setError(null);
    setResults([]);
    setProgress({ processed: 0, total: totalSelecionados, success: 0, error: 0, naoEnviado: 0 });
    setPhase("alterando");

    const alvos = [...selecionados.values()].map((c) => ({
      nrCliente: c.nrCliente!,
      nome: c.nome,
      documento: c.documento,
      situacaoAnterior: c.dsSituacao || situacaoLabel(c.cdSituacao),
    }));

    try {
      const { jobId, total } = await startAlterarSituacao(cdSituacao, alvos);
      setProgress((p) => ({ ...p, total }));
      streamSituacao(jobId, {
        onRow: (row) => setResults((prev) => [...prev, row]),
        onProgress: (p) => setProgress({ ...p, naoEnviado: p.naoEnviado ?? 0 }),
        onSessaoExpirada: (d) => {
          setError(
            `${d.message} Os concluídos estão no relatório; refaça apenas os marcados como NÃO ENVIADO.`,
          );
        },
        onFatal: (d) => {
          setError(`Erro na alteração: ${d.message}`);
          setPhase("done");
        },
        onDone: () => setPhase("done"),
        onError: () => setError("Conexão de progresso (SSE) caiu. Verifique o backend."),
      });
    } catch (e) {
      if (!(e instanceof SessaoExpiradaError)) setError((e as Error).message);
      setPhase("carregado");
    }
  }

  const pct = progress.total > 0 ? Math.round((progress.processed / progress.total) * 100) : 0;

  const toggleExpand = (nr: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(nr) ? next.delete(nr) : next.add(nr);
      return next;
    });

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-display font-semibold tracking-tight text-foreground">
          Base de Clientes
        </h1>
        <p className="mt-1 text-label text-muted-foreground">
          A base carrega automaticamente ao abrir a aba. Em cada cliente: consulte as{" "}
          propostas criadas (e os dados de cada uma) ou altere a situação — individual
          ou em lote.
        </p>
      </div>

      {IS_PROD && (
        <div className="flex items-center gap-2 rounded-lg border border-[var(--destructive)] bg-[var(--destructive)]/10 px-4 py-3 text-sm font-medium text-[var(--destructive)]">
          <AlertTriangle className="h-4 w-4" />
          Ambiente de PRODUÇÃO ativo — as alterações de situação são reais.
        </div>
      )}

      {sessaoCurta && (
        <div className="flex items-start gap-2 rounded-lg border border-[var(--warning)] bg-[var(--warning)]/15 px-4 py-3 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            A sessão expira em <strong>{formatarRestante(restanteSessao)}</strong> e não há
            renovação automática. Uma alteração em lote iniciada agora pode ser interrompida — os
            clientes restantes ficariam como <strong>NÃO ENVIADO</strong>. Saia e entre novamente
            antes de executar.
          </span>
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-[var(--destructive)] bg-[var(--destructive)]/10 px-4 py-3 text-sm text-[var(--destructive)]">
          <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Sem card de credenciais: a autenticação virou a sessão do login. */}
      {/* Carga e ação lado a lado — controles em linha, não em largura total. */}
      <div className="grid items-start gap-6 lg:grid-cols-2">
        {/* Carga */}
        <Card>
          <CardHeader>
            <CardTitle>Carregar clientes</CardTitle>
            <CardDescription>
              Traz a base inteira de uma vez (<code>GET /v1/cliente</code>, todas as páginas, um
              login só). Depois o filtro é local e instantâneo.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap items-end gap-3">
              <div className="w-40 space-y-1">
                <Label htmlFor="sit-tipo" className="text-caption">
                  Tipo de pessoa
                </Label>
                <Select
                  id="sit-tipo"
                  value={tipoPessoa}
                  onChange={(e) => setTipoPessoa(e.target.value)}
                  disabled={busy}
                >
                  <option value="">Todos</option>
                  <option value="F">PF</option>
                  <option value="J">PJ</option>
                </Select>
              </div>

              <Button variant="outline" onClick={() => void carregar()} disabled={busy}>
                {phase === "carregando" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4" />
                )}
                {base ? "Recarregar clientes" : "Carregar clientes"}
              </Button>

              {base && (
                <p className="pb-2 text-body">
                  <strong className="tabular-nums">{base.items.length}</strong> cliente(s) em{" "}
                  {base.paginas} página(s)
                  {base.totalElements !== null && base.totalElements !== base.items.length
                    ? ` — a Sinqia informa ${base.totalElements} no total`
                    : ""}
                  .
                </p>
              )}
            </div>

            {phase === "carregando" && (
              <p className="text-caption text-muted-foreground">
                Varrendo as páginas na Sinqia — numa base grande isso leva alguns segundos.
              </p>
            )}

            {base?.truncado && (
              <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-caption text-destructive">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  A carga bateu no teto de segurança do backend e <strong>pode estar
                  incompleta</strong>. Use o filtro de tipo de pessoa para reduzir o conjunto.
                </span>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Seleção + ação */}
        {base && (
        <Card ref={acaoCardRef} className="scroll-mt-40">
          <CardHeader>
            <CardTitle>Alterar situação</CardTitle>
            <CardDescription>
              A seleção <strong>não é perdida</strong> ao filtrar ou recarregar — vá juntando os
              clientes de várias buscas e altere todos de uma vez.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-64 flex-1 space-y-1">
                <Label htmlFor="sit-nova" className="text-caption">
                  Nova situação (<code>cdSituacao</code>)
                </Label>
                <Select
                  id="sit-nova"
                  value={String(cdSituacao)}
                  onChange={(e) => setCdSituacao(Number(e.target.value))}
                >
                  {SITUACOES.map((s) => (
                    <option key={s.codigo} value={s.codigo}>
                      {s.codigo} — {s.label}
                    </option>
                  ))}
                </Select>
              </div>
              <Button onClick={handleAlterarClick} disabled={!podeAlterar}>
                {phase === "alterando" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <ListChecks className="h-4 w-4" />
                )}
                Alterar {totalSelecionados > 0 ? `${totalSelecionados} cliente(s)` : "situação"}
              </Button>
            </div>

            {/* Painel de selecionados — deixa a seleção acumulada sempre visível. */}
            <div className="rounded-lg border border-[var(--border)]">
              <div className="flex items-center justify-between gap-3 px-3 py-2">
                <button
                  type="button"
                  onClick={() => setVerSelecionados((v) => !v)}
                  className="flex items-center gap-2 text-sm font-medium"
                  disabled={totalSelecionados === 0}
                >
                  {verSelecionados ? (
                    <ChevronDown className="h-4 w-4" />
                  ) : (
                    <ChevronRight className="h-4 w-4" />
                  )}
                  {totalSelecionados} selecionado(s)
                </button>
                {totalSelecionados > 0 && (
                  <Button variant="outline" onClick={limparSelecao} disabled={busy}>
                    Limpar seleção
                  </Button>
                )}
              </div>

              {verSelecionados && totalSelecionados > 0 && (
                <div className="max-h-56 overflow-auto border-t border-[var(--border)] px-3 py-2">
                  <div className="flex flex-wrap gap-2">
                    {[...selecionados.values()].map((c) => (
                      <span
                        key={c.nrCliente!}
                        className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--muted)]/40 px-2.5 py-1 text-xs"
                      >
                        <span className="tabular-nums font-medium">{c.nrCliente}</span>
                        <span className="max-w-[220px] truncate text-muted-foreground">
                          {c.nome || c.documento}
                        </span>
                        <button
                          type="button"
                          onClick={() => removerSelecionado(c.nrCliente!)}
                          disabled={busy}
                          aria-label={`Remover ${c.nome || c.nrCliente}`}
                          className="text-muted-foreground hover:text-[var(--destructive)]"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
        )}
      </div>

      {/* Progresso */}
      {(phase === "alterando" || phase === "done") && progress.total > 0 && (
        <Card ref={progressoRef} className="scroll-mt-40">
          <CardHeader>
            <CardTitle>Progresso</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Progress value={pct} />
            <div className="flex flex-wrap gap-4 text-sm">
              <span>
                {progress.processed}/{progress.total} ({pct}%)
              </span>
              <span className="text-[var(--success)]">{progress.success} OK</span>
              <span className="text-[var(--destructive)]">{progress.error} erro(s)</span>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Resultados */}
      {results.length > 0 && (
        <Card>
          <CardHeader className="flex-row items-center justify-between gap-4">
            <div>
              <CardTitle>Resultado da alteração</CardTitle>
              <CardDescription>
                O sucesso vem da análise do envelope da Sinqia, não só do HTTP 200.
              </CardDescription>
            </div>
            <Button variant="outline" onClick={() => exportSituacaoCsv(results)}>
              <Download className="h-4 w-4" />
              Exportar CSV
            </Button>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8" />
                  <TableHead>nrCliente</TableHead>
                  <TableHead>Nome</TableHead>
                  <TableHead>Documento</TableHead>
                  <TableHead>De</TableHead>
                  <TableHead>Para</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>HTTP</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {results.map((r) => (
                  <Fragment key={`res-${r.nrCliente}`}>
                    <TableRow>
                      <TableCell>
                        {(r.messages || r.detail || r.globalMessage) && (
                          <button
                            type="button"
                            onClick={() => toggleExpand(-r.nrCliente)}
                            className="text-muted-foreground hover:text-foreground"
                            aria-label="Ver mensagens"
                          >
                            {expanded.has(-r.nrCliente) ? (
                              <ChevronDown className="h-4 w-4" />
                            ) : (
                              <ChevronRight className="h-4 w-4" />
                            )}
                          </button>
                        )}
                      </TableCell>
                      <TableCell className="tabular-nums">{r.nrCliente}</TableCell>
                      <TableCell>{r.nome}</TableCell>
                      <TableCell className="tabular-nums">{r.documento}</TableCell>
                      <TableCell className="text-muted-foreground">{r.situacaoAnterior}</TableCell>
                      <TableCell>{r.situacaoNova}</TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            r.status === "OK"
                              ? "success"
                              : r.status === "NAO_ENVIADO"
                                ? "secondary"
                                : "destructive"
                          }
                        >
                          {r.status === "NAO_ENVIADO" ? "NÃO ENVIADO" : r.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="tabular-nums">{r.httpStatus ?? "—"}</TableCell>
                    </TableRow>
                    {expanded.has(-r.nrCliente) && (
                      <TableRow>
                        <TableCell colSpan={8} className="bg-[var(--muted)]/40 text-xs">
                          {r.globalMessage && (
                            <div>
                              <strong>globalMessage:</strong> {r.globalMessage}
                            </div>
                          )}
                          {r.messages && (
                            <div>
                              <strong>mensagens:</strong> {r.messages}
                            </div>
                          )}
                          {r.detail && (
                            <div>
                              <strong>detalhe:</strong> {r.detail}
                            </div>
                          )}
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Lista + filtro */}
      {base && (
        <Card>
          <CardHeader>
            <CardTitle>Clientes</CardTitle>
            <CardDescription>
              Filtro sobre os {base.items.length} carregados — encontra qualquer cliente, não só os
              da página.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="sit-filtro">Filtrar por número do cliente, nome ou CPF/CNPJ</Label>
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="sit-filtro"
                  value={filtro}
                  onChange={(e) => setFiltro(e.target.value)}
                  placeholder="ex.: 4154, Geraldo, 150.324.650-70"
                  className="pl-9"
                />
              </div>
              <p className="text-xs text-muted-foreground">
                {filtrados.length} resultado(s). O número do cliente casa exato; nome e documento
                casam por parte do texto (CPF/CNPJ pode ser digitado com ou sem máscara).
              </p>
            </div>

            {base.rawBody && (
              <div className="flex items-start gap-2 rounded-lg border border-[var(--destructive)] bg-[var(--destructive)]/10 px-3 py-2 text-xs text-[var(--destructive)]">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  A Sinqia respondeu algo que não era JSON. Corpo recebido:{" "}
                  <code className="break-all">{base.rawBody.slice(0, 300)}</code>
                </span>
              </div>
            )}

            {semChave > 0 && (
              <div className="flex items-start gap-2 rounded-lg border border-[var(--border)] px-3 py-2 text-xs text-muted-foreground">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  {semChave} registro(s) do filtro não trazem <code>nrCliente</code> e não podem ter
                  a situação alterada. Expanda a linha para ver os campos brutos.
                </span>
              </div>
            )}

            {filtrados.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                Nenhum cliente encontrado para este filtro.
              </p>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-3">
                  <Button
                    variant="outline"
                    onClick={toggleFiltrados}
                    disabled={selecionaveis.length === 0 || busy}
                  >
                    {todosFiltradosSelecionados
                      ? `Desmarcar os ${selecionaveis.length} filtrados`
                      : `Selecionar os ${selecionaveis.length} filtrados`}
                  </Button>
                  {ocultos > 0 && (
                    <span className="text-xs text-muted-foreground">
                      Mostrando {visiveis.length} de {filtrados.length} — o botão acima seleciona
                      todos os {selecionaveis.length}, inclusive os não exibidos.
                    </span>
                  )}
                </div>

                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-10">
                        <input
                          type="checkbox"
                          className="h-4 w-4 accent-[var(--primary)]"
                          checked={todosFiltradosSelecionados}
                          onChange={toggleFiltrados}
                          disabled={selecionaveis.length === 0 || busy}
                          aria-label="Selecionar todos os filtrados"
                        />
                      </TableHead>
                      <TableHead className="w-8" />
                      <TableHead>nrCliente</TableHead>
                      <TableHead>Nome</TableHead>
                      <TableHead>Documento</TableHead>
                      <TableHead>Tipo</TableHead>
                      <TableHead>Situação atual</TableHead>
                      <TableHead>Ações</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visiveis.map((c, i) => {
                      const chave = c.nrCliente ?? -(i + 1);
                      const marcado = c.nrCliente !== null && selecionados.has(c.nrCliente);
                      return (
                        <Fragment key={chave}>
                          <TableRow className={cn(marcado && "bg-[var(--accent)]/50")}>
                            <TableCell>
                              <input
                                type="checkbox"
                                className="h-4 w-4 accent-[var(--primary)]"
                                checked={marcado}
                                onChange={() => toggleUm(c)}
                                disabled={c.nrCliente === null || busy}
                                aria-label={`Selecionar ${c.nome || chave}`}
                              />
                            </TableCell>
                            <TableCell>
                              <button
                                type="button"
                                onClick={() => toggleExpand(chave)}
                                className="text-muted-foreground hover:text-foreground"
                                aria-label="Ver campos brutos"
                              >
                                {expanded.has(chave) ? (
                                  <ChevronDown className="h-4 w-4" />
                                ) : (
                                  <ChevronRight className="h-4 w-4" />
                                )}
                              </button>
                            </TableCell>
                            <TableCell className="tabular-nums">
                              {c.nrCliente ?? <span className="text-muted-foreground">—</span>}
                            </TableCell>
                            <TableCell>
                              {c.nome || <span className="text-muted-foreground">—</span>}
                            </TableCell>
                            <TableCell className="tabular-nums">{c.documento}</TableCell>
                            <TableCell>{c.tipoPessoa}</TableCell>
                            <TableCell>{c.dsSituacao}</TableCell>
                            <TableCell>
                              <div className="flex items-center gap-1">
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="h-7 px-2 text-caption"
                                  onClick={() => void abrirPropostas(c)}
                                  disabled={busy}
                                  title="Consultar as propostas deste cliente na Sinqia"
                                >
                                  <FileSearch className="h-3.5 w-3.5" />
                                  Propostas
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 px-2 text-caption"
                                  onClick={() => alterarSituacaoDe(c)}
                                  disabled={c.nrCliente === null || busy}
                                  title="Selecionar só este cliente para alterar a situação"
                                >
                                  <ListChecks className="h-3.5 w-3.5" />
                                  Situação
                                </Button>
                              </div>
                            </TableCell>
                          </TableRow>
                          {expanded.has(chave) && (
                            <TableRow>
                              <TableCell colSpan={8} className="bg-[var(--muted)]/40">
                                <pre className="max-h-64 overflow-auto text-xs">
                                  {JSON.stringify(c.raw, null, 2)}
                                </pre>
                              </TableCell>
                            </TableRow>
                          )}
                        </Fragment>
                      );
                    })}
                  </TableBody>
                </Table>

                {ocultos > 0 && (
                  <p className="text-center text-xs text-muted-foreground">
                    +{ocultos} resultado(s) não exibido(s). Refine o filtro para vê-los.
                  </p>
                )}
              </>
            )}
          </CardContent>
        </Card>
      )}

      {/* Confirmação de produção */}
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-[var(--destructive)]">
              <AlertTriangle className="h-5 w-5" />
              Confirmar alteração em PRODUÇÃO
            </DialogTitle>
            <DialogDescription>
              Você está prestes a alterar a situação de <strong>{totalSelecionados}</strong>{" "}
              cliente(s) para <strong>{situacaoLabel(cdSituacao)}</strong> em{" "}
              <strong>PRODUÇÃO</strong>. Esta ação é real e não pode ser desfeita pela ferramenta.
              Confirma?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              Cancelar
            </Button>
            <Button variant="destructive" onClick={() => void executarAlteracao()}>
              Confirmar e alterar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {phase === "done" && progress.error === 0 && progress.total > 0 && (
        <div className="flex items-center gap-2 rounded-lg border border-[var(--success)] bg-[var(--success)]/10 px-4 py-3 text-sm text-[var(--success)]">
          <CheckCircle2 className="h-4 w-4" />
          {progress.success} situação(ões) alterada(s) com sucesso. Recarregue a lista para ver as
          situações atualizadas.
        </div>
      )}

      {/* Propostas do cliente (lista → detalhe) */}
      <Dialog open={propCliente !== null} onOpenChange={(open) => !open && setPropCliente(null)}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileSearch className="h-5 w-5 text-[var(--primary)]" />
              {propDetalhe
                ? `Proposta ${propDetalhe.nrProsp}`
                : `Propostas de ${propCliente?.nome || propCliente?.documento || ""}`}
            </DialogTitle>
            <DialogDescription>
              {propDetalhe
                ? "Dados completos da proposta na Sinqia (principal + parcelas)."
                : `Documento ${propCliente?.documento ?? ""} · nrCliente ${propCliente?.nrCliente ?? "—"}. Consulta somente leitura.`}
            </DialogDescription>
          </DialogHeader>

          {propError && (
            <div className="flex items-start gap-2 rounded-lg border border-[var(--destructive)] bg-[var(--destructive)]/10 px-3 py-2 text-sm text-[var(--destructive)]">
              <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{propError}</span>
            </div>
          )}

          {propDetalhe ? (
            <DetalhePropostaView
              dados={propDetalhe.dados}
              onVoltar={() => setPropDetalhe(null)}
            />
          ) : propLoading ? (
            <div className="flex items-center justify-center gap-2 py-10 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
              Consultando as propostas na Sinqia…
            </div>
          ) : propostas.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              Este cliente ainda não tem nenhuma proposta na Sinqia.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-right">Nº proposta</TableHead>
                  <TableHead className="text-right">Data</TableHead>
                  <TableHead className="text-right">Produto</TableHead>
                  <TableHead className="text-right">Financiado</TableHead>
                  <TableHead className="text-right">Parcela</TableHead>
                  <TableHead className="text-right">Qtd.</TableHead>
                  <TableHead className="text-right">1º vcto.</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {propostas.map((p) => (
                  <TableRow key={p.nrProp}>
                    <TableCell className="text-right font-semibold tabular-nums">
                      {p.nrProp}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatDataAAAAMMDD(p.dtProp)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{p.cdProd ?? "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatBRL(p.vlFinan)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatBRL(p.vlPrest)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{p.qtPrest ?? "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatDataAAAAMMDD(p.dtVct1ap)}
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 px-2 text-caption"
                        onClick={() => void verDadosProposta(p.nrProp)}
                        disabled={propDetalheLoading}
                      >
                        {propDetalheLoading ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <FileSearch className="h-3.5 w-3.5" />
                        )}
                        Ver dados
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Detalhe da proposta: campos principais formatados + parcelas + JSON cru. */
function DetalhePropostaView({
  dados,
  onVoltar,
}: {
  dados: DadosProposta;
  onVoltar: () => void;
}) {
  const p = (dados.principal ?? {}) as Record<string, unknown>;
  const parcelas = dados.parcelas ?? [];
  const num = (v: unknown) => (typeof v === "number" ? v : null);

  const campos: Array<[string, string]> = [
    ["Produto", String(p.cdProdut ?? "—")],
    ["Contratação", formatDataAAAAMMDD(num(p.dtContra))],
    ["1º vencimento", formatDataAAAAMMDD(num(p.dtVct1ap))],
    ["Último vencimento", formatDataAAAAMMDD(num(p.dtVctult))],
    ["Financiado", formatBRL(num(p.vlContra))],
    ["Líquido", formatBRL(num(p.vlLiquid))],
    ["Parcela", formatBRL(num(p.vlPresta))],
    ["Total", formatBRL(num(p.vlTotal))],
    ["Juros", formatBRL(num(p.vlJuros))],
    ["IOF", formatBRL(num(p.vlIofCob))],
    ["Seguro", formatBRL(num(p.vlSeguro))],
    ["Outros", formatBRL(num(p.vlOutvlr))],
    ["Parcelas", String(p.qtPresta ?? parcelas.length ?? "—")],
  ];

  return (
    <div className="space-y-4">
      <Button variant="ghost" size="sm" onClick={onVoltar} className="-ml-2">
        <ArrowLeft className="h-4 w-4" />
        Voltar às propostas
      </Button>

      <div className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3">
        {campos.map(([label, valor]) => (
          <div key={label}>
            <p className="text-caption text-muted-foreground">{label}</p>
            <p className="text-body font-medium tabular-nums">{valor}</p>
          </div>
        ))}
      </div>

      {parcelas.length > 0 && (
        <div>
          <p className="mb-1 text-caption font-semibold text-muted-foreground">
            Plano de parcelas ({parcelas.length})
          </p>
          <div className="max-h-56 overflow-y-auto rounded-md border border-[var(--border)]">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-right">Nº</TableHead>
                  <TableHead className="text-right">Vencimento</TableHead>
                  <TableHead className="text-right">Principal</TableHead>
                  <TableHead className="text-right">Juros</TableHead>
                  <TableHead className="text-right">Parcela</TableHead>
                  <TableHead className="text-right">Saldo devedor</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {parcelas.map((par) => (
                  <TableRow key={par.nrPresta}>
                    <TableCell className="text-right tabular-nums">{par.nrPresta}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatDataAAAAMMDD(par.dtVctpre)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatBRL(par.vlPrinc)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatBRL(par.vlJuros)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatBRL(par.vlPresta)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatBRL(par.vlSaldoDevedor ?? null)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}

      <details>
        <summary className="cursor-pointer text-caption font-semibold text-[var(--primary)]">
          Ver resposta completa da Sinqia (JSON)
        </summary>
        <pre className="mt-2 max-h-64 overflow-auto rounded-md border border-[var(--border)] bg-[var(--muted)]/40 p-3 text-[11px] leading-4">
          {JSON.stringify(dados, null, 2)}
        </pre>
      </details>
    </div>
  );
}
