import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Download,
  FileSearch,
  Hourglass,
  ListChecks,
  Loader2,
  Pencil,
  RefreshCw,
  Search,
  Upload,
  UserPlus,
  X,
  XCircle,
} from "lucide-react";
import { matchCliente, SITUACOES, situacaoLabel } from "@cadastro-lote/shared";
import { Breadcrumb } from "@/components/Breadcrumb";
import { Hint } from "@/components/onboarding/Hint";
import { Skeleton } from "@/components/ui/skeleton";
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
import { Combobox } from "@/components/ui/combobox";
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
  getEnv,
  getPersonas,
  listarPropostasCliente,
  listarTodosClientes,
  salvarPersona,
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

type Phase = "idle" | "carregando" | "carregado" | "alterando" | "done" | "requisitada";

/** Teto de linhas renderizadas. Filtrar é barato; desenhar 20 mil <tr> não é. */
const MAX_LINHAS_VISIVEIS = 200;

export function SituacaoClientes({
  ativa = true,
  onNavegar,
  onEditar,
}: {
  ativa?: boolean;
  /** Navega para as sub-páginas do módulo (cadastro individual/em lote). */
  onNavegar?: (tela: "individual" | "cadastro") => void;
  /** Abre o Cadastro Individual pré-preenchido para EDITAR este tomador. */
  onEditar?: (cliente: ClienteResumo) => void;
}) {
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
  /**
   * Esteira de Aprovação (SoD, US-12): com a flag do tipo ativa, a submissão
   * cria uma requisição pendente em vez de alterar na Sinqia. O backend é a
   * fonte da verdade; isto adapta aviso e desfecho na tela.
   */
  const [aprovacaoOn, setAprovacaoOn] = useState(false);
  const [requisicaoCriada, setRequisicaoCriada] = useState<{ id: string; total: number } | null>(
    null,
  );
  useEffect(() => {
    getEnv()
      .then((e) => setAprovacaoOn(!!e.aprovacao?.situacaoTomador || !!e.aprovacao?.situacaoTomadorLote))
      .catch(() => {
        /* sem resposta, assume fluxo direto — o backend decide de verdade */
      });
  }, []);
  /** Modal de alteração de situação (a ação saiu dos cards e virou CTA). */
  const [alterarOpen, setAlterarOpen] = useState(false);
  const [alterarConfirmText, setAlterarConfirmText] = useState("");
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

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

  const carregar = useCallback(
    async (tipo?: string) => {
      setError(null);
      setPhase("carregando");
      try {
        const res = await listarTodosClientes((tipo ?? tipoPessoa) || undefined);
        setBase(res);
        setPhase("carregado");
      } catch (e) {
        // Sessão expirada já abre o modal de reautenticação — não vira erro na tela.
        if (!(e instanceof SessaoExpiradaError)) setError((e as Error).message);
        setPhase(base ? "carregado" : "idle");
      }
    },
    [tipoPessoa, base],
  );

  /** Chips PF/PJ: trocar o tipo recarrega a base direto (sem botão de carga). */
  const trocarTipo = (tipo: string) => {
    if (busy || tipo === tipoPessoa) return;
    setTipoPessoa(tipo);
    void carregar(tipo);
  };

  /* ---------------------------------------------------------------- */
  /* Personas — regra: PF = tomador; a base local guarda só as exceções */
  /* ---------------------------------------------------------------- */

  /** Exceções de persona (documento → tomador). Regra implícita cobre o resto. */
  const [personas, setPersonas] = useState<Map<string, boolean>>(new Map());
  const [salvandoPersona, setSalvandoPersona] = useState<string | null>(null);

  useEffect(() => {
    if (!ativa) return;
    void getPersonas()
      .then((r) => setPersonas(new Map(r.overrides.map((o) => [o.documento, o.tomador]))))
      .catch(() => setPersonas(new Map()));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 1x por ativação
  }, [ativa]);

  const ehTomador = (c: ClienteResumo): boolean => {
    const doc = c.documento.replace(/\D/g, "");
    return personas.get(doc) ?? c.tipoPessoa.toUpperCase().startsWith("F");
  };

  /** Alterna a persona do cliente (grava a exceção na base local). */
  async function alternarPersona(c: ClienteResumo) {
    const doc = c.documento.replace(/\D/g, "");
    if (!doc || salvandoPersona) return;
    const tp = c.tipoPessoa.toUpperCase().startsWith("F") ? "F" : "J";
    const novo = !ehTomador(c);
    setSalvandoPersona(doc);
    try {
      await salvarPersona({ documento: doc, tpPessoa: tp, tomador: novo });
      setPersonas((prev) => {
        const next = new Map(prev);
        // Voltou ao padrão da regra? A exceção some.
        if (novo === (tp === "F")) next.delete(doc);
        else next.set(doc, novo);
        return next;
      });
    } catch (e) {
      if (!(e instanceof SessaoExpiradaError)) setError((e as Error).message);
    } finally {
      setSalvandoPersona(null);
    }
  }

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

  /** Em produção o botão da modal só libera com "ALTERAR" digitado. */
  const confirmacaoAlterarOk = !IS_PROD || alterarConfirmText.trim().toUpperCase() === "ALTERAR";

  async function executarAlteracao() {
    setAlterarOpen(false);
    setAlterarConfirmText("");
    setError(null);
    setRequisicaoCriada(null);
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
      const r = await startAlterarSituacao(cdSituacao, alvos);

      /*
       * Esteira de Aprovação ativa (US-12): a resposta traz a requisição
       * pendente e NÃO traz jobId — não há job para acompanhar, porque nada foi
       * enviado à Sinqia. Abrir o SSE aqui pedia
       * `/api/situacao/stream/undefined` (404) e o operador via "Conexão de
       * progresso (SSE) caiu" como se tivesse falhado, embora a requisição
       * estivesse criada.
       */
      if (r.aprovacao && r.requisicao) {
        setRequisicaoCriada({ id: r.requisicao.id, total: alvos.length });
        setPhase("requisitada");
        limparSelecao();
        return;
      }
      if (!r.jobId) {
        setError(
          "A alteração não retornou um identificador de progresso. Confira em “Requisições” se uma requisição foi criada antes de tentar de novo.",
        );
        setPhase("carregado");
        return;
      }

      const { jobId, total } = r;
      setProgress((p) => ({ ...p, total: total ?? alvos.length }));
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
      <div className="reveal flex flex-wrap items-end justify-between gap-4">
        <div>
          <Breadcrumb paginaPrincipal="Tomadores" atual="Base de tomadores" />
          <h1 className="text-display text-foreground">Base de tomadores</h1>
          <p className="mt-1 text-body text-muted-foreground">
            A base carrega automaticamente. Em cada tomador: consulte as propostas,
            edite ou complete o cadastro, altere a situação — e cadastre novos pelos
            botões ao lado.
          </p>
        </div>
        {onNavegar && (
          <div className="flex shrink-0 flex-wrap gap-2">
            <Button variant="outline" onClick={() => onNavegar("individual")}>
              <UserPlus className="h-4 w-4" />
              Cadastro individual
            </Button>
            <Button onClick={() => onNavegar("cadastro")}>
              <Upload className="h-4 w-4" />
              Cadastro em lote
            </Button>
          </div>
        )}
      </div>

      {sessaoCurta && (
        <div className="flex items-start gap-2 rounded-lg border border-[var(--warning)] bg-[var(--warning)]/15 px-4 py-3 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            A sessão expira em <strong>{formatarRestante(restanteSessao)}</strong> e não há
            renovação automática. Uma alteração em lote iniciada agora pode ser interrompida — os
            tomadores restantes ficariam como <strong>NÃO ENVIADO</strong>. Saia e entre novamente
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

      {/* Esteira de Aprovação ativa para este tipo de ação (US-12) */}
      {aprovacaoOn && (
        <div className="flex items-start gap-2 rounded-lg border border-primary/30 bg-accent px-4 py-3 text-body text-accent-foreground">
          <Hourglass className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            <strong>Sob aprovação (SoD):</strong> a alteração de situação não é enviada direto à
            Sinqia — a submissão cria uma requisição pendente, que um segundo operador precisa
            aprovar. Acompanhe em "Requisições".
          </span>
        </div>
      )}

      {/* Requisição criada (nada foi alterado na Sinqia) */}
      {phase === "requisitada" && requisicaoCriada && (
        <div className="flex items-start gap-2 rounded-lg border border-[var(--success)] bg-[var(--success)]/10 px-4 py-3 text-sm">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[var(--success)]" />
          <span>
            Requisição <strong>pendente</strong> criada para{" "}
            {requisicaoCriada.total === 1
              ? "1 tomador"
              : `${requisicaoCriada.total} tomadores`}{" "}
            — nada foi alterado na Sinqia ainda. Um segundo operador precisa aprovar.
            <br />
            <span className="text-muted-foreground">Requisição {requisicaoCriada.id}</span>
          </span>
        </div>
      )}

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

      {/* Lista + filtro — o card é o hub da página */}
      <Card className="reveal reveal-delay-1" data-tour="tomadores-tabela">
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle>Tomadores</CardTitle>
              <CardDescription>
                {base ? (
                  <span className="tabular-nums">
                    <span className="font-medium text-foreground">{base.items.length}</span>{" "}
                    tomador(es) carregado(s)
                    {base.totalElements !== null && base.totalElements !== base.items.length
                      ? ` — a Sinqia informa ${base.totalElements} no total`
                      : ""}{" "}
                    · o filtro abaixo é local e instantâneo
                  </span>
                ) : (
                  "Carregando a base na Sinqia — numa base grande isso leva alguns segundos."
                )}
              </CardDescription>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <Hint id="tipo_pessoa" />
              {/* Tipo de pessoa: trocar recarrega a base já filtrada no servidor */}
              <div
                className="flex items-center gap-0.5 rounded-lg border border-border p-0.5"
                role="group"
                aria-label="Tipo de pessoa"
              >
                {(
                  [
                    ["", "Todos"],
                    ["F", "PF"],
                    ["J", "PJ"],
                  ] as const
                ).map(([valor, rotulo]) => (
                  <button
                    key={valor}
                    type="button"
                    onClick={() => trocarTipo(valor)}
                    disabled={busy}
                    aria-pressed={tipoPessoa === valor}
                    className={cn(
                      "focus-ring rounded-md px-3 py-1 text-caption font-medium transition-colors duration-150",
                      tipoPessoa === valor
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {rotulo}
                  </button>
                ))}
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void carregar()}
                disabled={busy}
                title="Recarrega a base na Sinqia"
              >
                {phase === "carregando" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4" />
                )}
              </Button>
              <Button
                onClick={() => {
                  setAlterarConfirmText("");
                  setAlterarOpen(true);
                }}
                disabled={!podeAlterar}
                title={
                  totalSelecionados === 0
                    ? "Selecione tomadores na tabela para habilitar"
                    : "Altera a situação dos tomadores selecionados"
                }
              >
                {phase === "alterando" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <ListChecks className="h-4 w-4" />
                )}
                Alterar situação{totalSelecionados > 0 ? ` (${totalSelecionados})` : ""}
              </Button>
            </div>
          </div>

          {base?.truncado && (
            <div className="mt-2 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-caption text-destructive">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                A carga bateu no teto de segurança do backend e <strong>pode estar
                incompleta</strong>. Use o filtro PF/PJ para reduzir o conjunto.
              </span>
            </div>
          )}
        </CardHeader>
        {!base ? (
          <CardContent>
            <div className="space-y-2 py-2" role="status" aria-label="Carregando a base de tomadores">
              <Skeleton className="h-9 w-full" />
              {Array.from({ length: 8 }, (_, i) => (
                <Skeleton key={i} className="h-8 w-full" />
              ))}
            </div>
          </CardContent>
        ) : (
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="sit-filtro">Filtrar por número do tomador, nome ou CPF/CNPJ</Label>
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
                {filtrados.length} resultado(s). O número do tomador casa exato; nome e documento
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
                Nenhum tomador encontrado para este filtro.
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
                      <TableHead>nrCliente</TableHead>
                      <TableHead>Nome</TableHead>
                      <TableHead>Documento</TableHead>
                      <TableHead>Tipo</TableHead>
                      <TableHead>Situação atual</TableHead>
                      <TableHead>
                        <span className="inline-flex items-center gap-1">
                          Persona
                          <Hint id="persona_tomador" />
                        </span>
                      </TableHead>
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
                              {/* Regra: PF nasce tomadora; PJ só se promovida.
                                  Clicar alterna e grava a exceção na base local. */}
                              <button
                                type="button"
                                onClick={() => void alternarPersona(c)}
                                disabled={busy || salvandoPersona !== null}
                                title={
                                  ehTomador(c)
                                    ? "Persona tomadora — clique para remover"
                                    : "Sem persona tomadora — clique para tornar tomador"
                                }
                                className="focus-ring rounded-md"
                              >
                                {ehTomador(c) ? (
                                  <Badge>Tomador</Badge>
                                ) : (
                                  <Badge variant="outline" className="text-muted-foreground">
                                    —
                                  </Badge>
                                )}
                              </button>
                            </TableCell>
                            <TableCell>
                              <div className="flex items-center gap-1">
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="h-7 px-2 text-caption"
                                  onClick={() => void abrirPropostas(c)}
                                  disabled={busy}
                                  title="Consultar as propostas deste tomador na Sinqia"
                                >
                                  <FileSearch className="h-3.5 w-3.5" />
                                  Propostas
                                </Button>
                                {onEditar && (
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-7 px-2 text-caption"
                                    onClick={() => onEditar(c)}
                                    disabled={busy || !c.documento}
                                    title="Editar o cadastro — completa os campos faltantes (ação AL)"
                                  >
                                    <Pencil className="h-3.5 w-3.5" />
                                    Editar
                                  </Button>
                                )}
                              </div>
                            </TableCell>
                          </TableRow>
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
        )}
      </Card>

      {/* Alterar situação — a ação virou modal, com a seleção sempre à vista */}
      <Dialog open={alterarOpen} onOpenChange={setAlterarOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className={cn("flex items-center gap-2", IS_PROD && "text-destructive")}>
              <ListChecks className="h-5 w-5" />
              Alterar situação de {totalSelecionados} tomador(es)
            </DialogTitle>
            <DialogDescription>
              Em <strong>{IS_PROD ? "PRODUÇÃO" : "HOMOLOGAÇÃO"}</strong> — a alteração é real e
              não pode ser desfeita pela ferramenta. A seleção não se perde ao filtrar ou
              recarregar a base.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="sit-nova" className="text-caption">
                Nova situação
              </Label>
              <Combobox
                id="sit-nova"
                value={String(cdSituacao)}
                onChange={(v) => setCdSituacao(Number(v))}
                options={SITUACOES.map((s) => ({
                  value: String(s.codigo),
                  label: `${s.codigo} — ${s.label}`,
                }))}
              />
            </div>

            <div className="max-h-48 overflow-y-auto rounded-lg border border-border p-2">
              <div className="flex flex-wrap gap-2">
                {[...selecionados.values()].map((c) => (
                  <span
                    key={c.nrCliente!}
                    className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/40 px-2.5 py-1 text-caption"
                  >
                    <span className="tabular-nums font-medium">{c.nrCliente}</span>
                    <span className="max-w-52 truncate text-muted-foreground">
                      {c.nome || c.documento}
                    </span>
                    <button
                      type="button"
                      onClick={() => removerSelecionado(c.nrCliente!)}
                      disabled={busy}
                      aria-label={`Remover ${c.nome || c.nrCliente}`}
                      className="focus-ring text-muted-foreground hover:text-destructive"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
              </div>
            </div>

            {IS_PROD && (
              <div className="space-y-1">
                <Label htmlFor="confirma-alterar" className="text-caption">
                  Digite <strong>ALTERAR</strong> para liberar:
                </Label>
                <Input
                  id="confirma-alterar"
                  value={alterarConfirmText}
                  onChange={(e) => setAlterarConfirmText(e.target.value)}
                  placeholder="ALTERAR"
                />
              </div>
            )}
          </div>

          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => {
                limparSelecao();
                setAlterarOpen(false);
              }}
              disabled={busy}
            >
              Limpar seleção
            </Button>
            <Button variant="outline" onClick={() => setAlterarOpen(false)}>
              Cancelar
            </Button>
            <Button
              variant={IS_PROD ? "destructive" : "default"}
              onClick={() => void executarAlteracao()}
              disabled={!podeAlterar || !confirmacaoAlterarOk}
            >
              Alterar {totalSelecionados} tomador(es) para {situacaoLabel(cdSituacao)}
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
              Este tomador ainda não tem nenhuma proposta na Sinqia.
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
