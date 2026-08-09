import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Ban,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Download,
  FilePlus2,
  FileSpreadsheet,
  Loader2,
  RefreshCw,
  Search,
  SearchX,
  SlidersHorizontal,
  XCircle,
} from "lucide-react";
import { normalizarLogin, ROTULO_TIPO_ACAO } from "@cadastro-lote/shared";
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
import { Badge } from "@/components/ui/badge";
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
import { RequisicaoDetalhe } from "@/components/RequisicaoDetalhe";
import { BadgeEstado } from "@/pages/MinhasRequisicoes";
import { IS_PROD } from "@/components/Topbar";
import { Breadcrumb } from "@/components/Breadcrumb";
import { CATEGORIAS, categoriaDaEtapa } from "@/lib/esteira";
import { Hint } from "@/components/onboarding/Hint";
import { cn } from "@/lib/utils";
import {
  cancelarRequisicao,
  detalharRequisicao,
  getEnv,
  getFilasPropostas,
  getHistoricoProposta,
  getMovimentacoesAtivas,
  getTransicoesProposta,
  painelPropostas,
  startTransferirLote,
  streamTransferenciaLote,
  transferirProposta,
  type DetalheRequisicao,
  type FilaWf,
  type HistoricoPropostaItem,
  type MovimentacaoAtiva,
  type PainelCursor,
  type PainelFiltros,
  type PropostaPainel,
  type TransferenciaRowResult,
  type TransicaoStatus,
} from "@/lib/api";
import { exportPainelCsv } from "@/lib/export-csv";
import { formatBRL, formatCpf, formatDataAAAAMMDD } from "@/lib/format";
import { SessaoExpiradaError, useSession } from "@/lib/session";

/** Filtros digitados (strings; convertidos no envio). */
interface FiltrosForm {
  nrPropos: string;
  cpf: string;
  nome: string;
  /** ISO yyyy-mm-dd (input date). */
  dtIni: string;
  dtFim: string;
  /** Código do convênio (cdConvProd). */
  convenio: string;
}

const FILTROS_INICIAIS: FiltrosForm = {
  nrPropos: "",
  cpf: "",
  nome: "",
  dtIni: "",
  dtFim: "",
  convenio: "",
};

const isoParaStr = (iso: string) => iso.replace(/-/g, "");

/** "1536" (HHMM) → "15:36". */
function formatHora(hr: number | null): string {
  if (hr === null) return "";
  const s = String(hr).padStart(4, "0");
  return `${s.slice(0, 2)}:${s.slice(2, 4)}`;
}

/** Pílula de status com a cor da CATEGORIA — a mesma do dashboard e da esteira. */
function StatusPill({ nrStatus, dsStatus }: { nrStatus: number | null; dsStatus: string }) {
  const cat = CATEGORIAS[categoriaDaEtapa(nrStatus, dsStatus)];
  return (
    <Badge
      className="border-transparent"
      style={{ backgroundColor: cat.cor, color: cat.corTexto }}
      title={`${cat.label} — status ${nrStatus ?? "—"}`}
    >
      {dsStatus || "—"}
    </Badge>
  );
}

/** Bolinha da categoria — legenda mínima usada em listas e no histórico. */
function PontoCategoria({ nrStatus, dsStatus }: { nrStatus: number | null; dsStatus: string }) {
  const cat = CATEGORIAS[categoriaDaEtapa(nrStatus, dsStatus)];
  return (
    <span
      aria-hidden
      title={cat.label}
      className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
      style={{ backgroundColor: cat.cor }}
    />
  );
}

/** Horas corridas desde a entrada no status atual (dtEntrad AAAAMMDD + hrEntrad HHMM). */
function horasNaEtapa(dtEntrad: number | null, hrEntrad: number | null): number | null {
  if (!dtEntrad) return null;
  const s = String(dtEntrad);
  if (s.length !== 8) return null;
  const hr = String(hrEntrad ?? 0).padStart(4, "0");
  const d = new Date(
    Number(s.slice(0, 4)),
    Number(s.slice(4, 6)) - 1,
    Number(s.slice(6, 8)),
    Number(hr.slice(0, 2)),
    Number(hr.slice(2, 4)),
  );
  if (Number.isNaN(d.getTime())) return null;
  return Math.max(0, (Date.now() - d.getTime()) / 3_600_000);
}

/**
 * Indicador de movimentação em aprovação (US-08, RN05): a proposta permanece
 * na etapa de ORIGEM; o chip mostra o estado da requisição — "pendente
 * (→ destino)", "executando" ou "falhou" — e clica para o detalhe.
 */
function IndicadorMovimentacao({
  mov,
  onAbrir,
}: {
  mov: MovimentacaoAtiva;
  onAbrir: (requisicaoId: string) => void;
}) {
  const destino = (mov.destino?.dsStatus ?? "").replace(/\s*\(.*\)\s*$/, "") || "destino";
  const chip =
    mov.estado === "pendente"
      ? { label: `pendente (→ ${destino})`, variant: "warning" as const }
      : mov.estado === "aprovada/executando"
        ? { label: "executando", variant: "default" as const }
        : { label: "falhou", variant: "destructive" as const };
  return (
    <button
      type="button"
      onClick={() => onAbrir(mov.requisicaoId)}
      className="focus-ring rounded-full"
      title={`Movimentação em aprovação (SoD) — criada por ${mov.requisitante}. Clique para o detalhe.`}
    >
      <Badge variant={chip.variant} className="cursor-pointer whitespace-nowrap">
        <ArrowRight className="mr-1 h-3 w-3" />
        {chip.label}
      </Badge>
    </button>
  );
}

/** Régua de SLA: acima disso na mesma etapa, a proposta entra em atenção. */
const SLA_HORAS_ATENCAO = 72;

/** Até a régua conta em horas ("36 h"); acima dela, em dias ("4 d"). */
function labelSla(horas: number): string {
  return horas <= SLA_HORAS_ATENCAO ? `${Math.floor(horas)} h` : `${Math.floor(horas / 24)} d`;
}

export function PainelPropostas({
  ativa,
  onNavegar,
  filaExterna = null,
  onFilaExternaConsumida,
}: {
  ativa: boolean;
  /** Navega para as sub-páginas do módulo (lote/proposta individual). */
  onNavegar?: (tela: "lote-propostas" | "proposta-individual") => void;
  /**
   * Fila pedida de fora (gargalo clicado no Início) — selecionada ao chegar,
   * carregando junto o convênio filtrado no dashboard (null = todos).
   */
  filaExterna?: { nrStatus: number; convenio: number | null } | null;
  onFilaExternaConsumida?: () => void;
}) {
  const [filas, setFilas] = useState<FilaWf[] | null>(null);
  const [carregandoFilas, setCarregandoFilas] = useState(false);
  /**
   * Etapa selecionada da esteira (nrStatus). O consultarPropostaPainel EXIGE
   * um status (sem ele a Sinqia devolve 400) — a navegação é sempre por fila.
   */
  const [filaSelecionada, setFilaSelecionada] = useState<number | null>(null);

  const [filtros, setFiltros] = useState<FiltrosForm>(FILTROS_INICIAIS);
  /** Filtros recolhidos por padrão — a tabela é a protagonista da página. */
  const [mostrarFiltros, setMostrarFiltros] = useState(false);
  const [propostas, setPropostas] = useState<PropostaPainel[]>([]);
  const [cursor, setCursor] = useState<PainelCursor | null>(null);
  const [carregando, setCarregando] = useState(false);
  const [carregouUmaVez, setCarregouUmaVez] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  /** Históricos por proposta: undefined = não pedido; null = carregando. */
  const [historicos, setHistoricos] = useState<Map<number, HistoricoPropostaItem[] | null>>(
    new Map(),
  );
  const [expandidas, setExpandidas] = useState<Set<number>>(new Set());

  /* --- Seleção para MOVER EM LOTE (mesma fila; agrupável por convênio) --- */
  const [selecionadas, setSelecionadas] = useState<Set<number>>(new Set());
  const [loteOpen, setLoteOpen] = useState(false);
  const [loteTransicoes, setLoteTransicoes] = useState<TransicaoStatus[] | null>(null);
  const [loteDestino, setLoteDestino] = useState<number | null>(null);
  const [loteObservacao, setLoteObservacao] = useState("");
  const [loteConfirmText, setLoteConfirmText] = useState("");
  const [loteMovendo, setLoteMovendo] = useState(false);
  const [loteErro, setLoteErro] = useState<string | null>(null);
  const [loteProgress, setLoteProgress] = useState({
    processed: 0,
    total: 0,
    success: 0,
    error: 0,
    naoEnviado: 0,
  });
  const [loteFalhas, setLoteFalhas] = useState<TransferenciaRowResult[]>([]);
  const [loteConcluido, setLoteConcluido] = useState(false);

  /** Mensagem de sucesso da última transferência. */
  const [info, setInfo] = useState<string | null>(null);

  /* --- Esteira de Aprovação (US-08): mover individual vira requisição --- */
  const { session } = useSession();
  /** Flag `aprovacao.movimentacao_proposta` — liga o gesto de mover por linha. */
  const [aprovacaoMovimentacao, setAprovacaoMovimentacao] = useState(false);
  /** Movimentações ATIVAS por nº de proposta — UMA chamada agregada (RN05). */
  const [movs, setMovs] = useState<Map<number, MovimentacaoAtiva>>(new Map());

  /** Modal "mover proposta" (individual, flag ON). */
  const [moverProposta, setMoverProposta] = useState<PropostaPainel | null>(null);
  const [moverTransicoes, setMoverTransicoes] = useState<TransicaoStatus[] | null>(null);
  const [moverDestino, setMoverDestino] = useState<number | null>(null);
  const [moverObservacao, setMoverObservacao] = useState("");
  const [moverEnviando, setMoverEnviando] = useState(false);
  const [moverErro, setMoverErro] = useState<string | null>(null);

  /** Drawer do detalhe da requisição de movimentação (indicador clicado). */
  const [movDetalheId, setMovDetalheId] = useState<string | null>(null);
  const [movDetalhe, setMovDetalhe] = useState<DetalheRequisicao | null>(null);
  const [movDetalheCarregando, setMovDetalheCarregando] = useState(false);
  const [movDetalheErro, setMovDetalheErro] = useState<string | null>(null);
  const [movCancelando, setMovCancelando] = useState(false);
  const [movConfirmCancelar, setMovConfirmCancelar] = useState(false);

  /** Recarrega o mapa de movimentações ativas — nunca derruba o painel. */
  async function carregarMovs() {
    try {
      const res = await getMovimentacoesAtivas();
      setMovs(
        new Map(
          res.movimentacoes
            .filter((m) => m.nrProsp !== null)
            .map((m) => [m.nrProsp as number, m]),
        ),
      );
    } catch {
      /* indicador é apoio: falha na consulta não pode esconder a fila */
    }
  }

  /** Abre o modal de mover UMA proposta e busca os destinos permitidos. */
  async function abrirMover(p: PropostaPainel) {
    const fila = filas?.find((f) => f.nrStatus === filaSelecionada);
    if (!fila) return;
    setMoverProposta(p);
    setMoverTransicoes(null);
    setMoverDestino(null);
    setMoverObservacao("");
    setMoverErro(null);
    try {
      const res = await getTransicoesProposta(fila.nrWf, fila.nrStatus);
      setMoverTransicoes(res.transicoes);
    } catch (e) {
      if (!(e instanceof SessaoExpiradaError)) setMoverErro((e as Error).message);
      setMoverTransicoes([]);
    }
  }

  const moverTransicao = moverTransicoes?.find((t) => t.proxStatus === moverDestino) ?? null;
  const moverObsOk = !moverTransicao?.exigeObservacao || moverObservacao.trim() !== "";
  const podeConfirmarMover = !!moverProposta && !!moverTransicao && moverObsOk && !moverEnviando;

  /**
   * Confirma o gesto: cria a REQUISIÇÃO de movimentação (zero Sinqia — a
   * execução acontece na aprovação). A proposta segue na etapa de origem com
   * o indicador "pendente (→ destino)".
   */
  async function confirmarMover() {
    const fila = filas?.find((f) => f.nrStatus === filaSelecionada);
    if (!fila || !moverProposta || !moverTransicao || !podeConfirmarMover) return;
    setMoverEnviando(true);
    setMoverErro(null);
    try {
      const res = await transferirProposta({
        nrProsp: moverProposta.nrProsp,
        nrWf: fila.nrWf,
        nrStatusAtual: fila.nrStatus,
        dsStatusAtual: fila.dsStatus,
        proxStatus: moverTransicao.proxStatus,
        dsObserv: moverObservacao.trim(),
        nrCpf: moverProposta.nrCpfCnpj,
        nmCliente: moverProposta.nmClient,
        cdProd: moverProposta.cdProd ?? 0,
        nrContra: moverProposta.nrContra,
      });
      setMoverProposta(null);
      if (res.aprovacao) {
        setInfo(
          `Requisição de movimentação da proposta nº ${moverProposta.nrProsp} criada — ` +
            `aguardando a decisão de um segundo operador. A proposta permanece nesta etapa até lá.`,
        );
      } else {
        // Flag desligada entre a abertura do modal e o envio: moveu direto.
        setInfo(`Proposta nº ${moverProposta.nrProsp} movida.`);
        void carregarFilas();
        void buscar(filaSelecionada);
      }
      void carregarMovs();
    } catch (e) {
      if (!(e instanceof SessaoExpiradaError)) setMoverErro((e as Error).message);
    } finally {
      setMoverEnviando(false);
    }
  }

  /** Abre o drawer com o detalhe da requisição de movimentação (RN05). */
  async function abrirMovDetalhe(requisicaoId: string) {
    setMovDetalheId(requisicaoId);
    setMovDetalhe(null);
    setMovDetalheErro(null);
    setMovConfirmCancelar(false);
    setMovDetalheCarregando(true);
    try {
      setMovDetalhe(await detalharRequisicao(requisicaoId));
    } catch (e) {
      if (e instanceof SessaoExpiradaError) setMovDetalheId(null);
      else setMovDetalheErro((e as Error).message);
    } finally {
      setMovDetalheCarregando(false);
    }
  }

  /** Cancela a requisição (RN06): remove o indicador e libera o bloqueio. */
  async function cancelarMovimentacao() {
    if (!movDetalheId) return;
    setMovCancelando(true);
    setMovConfirmCancelar(false);
    try {
      await cancelarRequisicao(movDetalheId);
      setInfo("Requisição de movimentação cancelada — a proposta está liberada para mover.");
      setMovDetalheId(null);
    } catch (e) {
      if (!(e instanceof SessaoExpiradaError)) setMovDetalheErro((e as Error).message);
      // Estado atual (ex.: já decidida) volta no refresh do detalhe.
      try {
        setMovDetalhe(await detalharRequisicao(movDetalheId));
      } catch {
        /* melhor-esforço */
      }
    } finally {
      setMovCancelando(false);
      void carregarMovs();
    }
  }

  const movReq = movDetalhe?.requisicao ?? null;
  const podeCancelarMov =
    !!movReq &&
    movReq.estado === "pendente" &&
    !!session &&
    normalizarLogin(session.username) === movReq.requisitante;

  /* --- Helpers da seleção em lote --- */
  const toggleSelecionada = (nrProsp: number) =>
    setSelecionadas((prev) => {
      const next = new Set(prev);
      next.has(nrProsp) ? next.delete(nrProsp) : next.add(nrProsp);
      return next;
    });

  const toggleGrupo = (itens: PropostaPainel[]) =>
    setSelecionadas((prev) => {
      const next = new Set(prev);
      const todos = itens.every((p) => next.has(p.nrProsp));
      for (const p of itens) {
        if (todos) next.delete(p.nrProsp);
        else next.add(p.nrProsp);
      }
      return next;
    });

  const todasSelecionadas =
    propostas.length > 0 && propostas.every((p) => selecionadas.has(p.nrProsp));

  /** Abre o modal de lote e busca os destinos permitidos da fila atual. */
  async function abrirMoverLote() {
    const fila = filas?.find((f) => f.nrStatus === filaSelecionada);
    if (!fila || selecionadas.size === 0) return;
    setLoteOpen(true);
    setLoteTransicoes(null);
    setLoteDestino(null);
    setLoteObservacao("");
    setLoteConfirmText("");
    setLoteErro(null);
    setLoteConcluido(false);
    setLoteFalhas([]);
    setLoteProgress({ processed: 0, total: 0, success: 0, error: 0, naoEnviado: 0 });
    try {
      const res = await getTransicoesProposta(fila.nrWf, fila.nrStatus);
      setLoteTransicoes(res.transicoes);
    } catch (e) {
      if (!(e instanceof SessaoExpiradaError)) setLoteErro((e as Error).message);
      setLoteTransicoes([]);
    }
  }

  const loteTransicao = loteTransicoes?.find((t) => t.proxStatus === loteDestino) ?? null;
  const loteObsOk = !loteTransicao?.exigeObservacao || loteObservacao.trim() !== "";
  const loteConfirmOk = !IS_PROD || loteConfirmText.trim().toUpperCase() === "MOVER";
  const podeMoverLote =
    !!loteTransicao && loteObsOk && loteConfirmOk && !loteMovendo && selecionadas.size > 0;

  /** Dispara o job de transferência em lote e acompanha pelo SSE no modal. */
  async function confirmarMoverLote() {
    const fila = filas?.find((f) => f.nrStatus === filaSelecionada);
    if (!fila || !loteTransicao || !podeMoverLote) return;
    const itens = propostas
      .filter((p) => selecionadas.has(p.nrProsp))
      .map((p) => ({
        nrProsp: p.nrProsp,
        nrCpf: p.nrCpfCnpj,
        nmCliente: p.nmClient,
        cdProd: p.cdProd ?? 0,
        nrContra: p.nrContra,
      }));
    setLoteMovendo(true);
    setLoteErro(null);
    setLoteFalhas([]);
    setLoteProgress({ processed: 0, total: itens.length, success: 0, error: 0, naoEnviado: 0 });
    try {
      const { jobId, total } = await startTransferirLote({
        nrWf: fila.nrWf,
        nrStatusAtual: fila.nrStatus,
        proxStatus: loteTransicao.proxStatus,
        dsObserv: loteObservacao.trim(),
        itens,
      });
      setLoteProgress((p) => ({ ...p, total }));
      streamTransferenciaLote(jobId, {
        onSnapshot: (d) => {
          setLoteProgress({
            processed: d.processed,
            total: d.total,
            success: d.success,
            error: d.error,
            naoEnviado: d.naoEnviado ?? 0,
          });
          setLoteFalhas(d.results.filter((r) => r.status !== "OK"));
          if (d.done) finalizarLote(d.success);
        },
        onRow: (row) => {
          if (row.status !== "OK") setLoteFalhas((prev) => [...prev, row]);
        },
        onProgress: (p) =>
          setLoteProgress((prev) => ({ ...prev, ...p, naoEnviado: p.naoEnviado ?? prev.naoEnviado })),
        onSessaoExpirada: () => setLoteMovendo(false),
        onDone: () => {
          setLoteMovendo(false);
          setLoteConcluido(true);
        },
      });
    } catch (e) {
      if (!(e instanceof SessaoExpiradaError)) setLoteErro((e as Error).message);
      setLoteMovendo(false);
    }
  }

  /** Pós-lote: banner, seleção limpa, esteira + fila + históricos atualizados. */
  function finalizarLote(movidas: number) {
    setInfo(`${movidas} proposta(s) movida(s) em lote.`);
    setHistoricos(new Map());
    setSelecionadas(new Set());
  }

  /** Aplica o pedido do Início: fila selecionada + convênio herdado do dashboard. */
  const aplicarFiltrosExternos = (convenio: number | null): FiltrosForm => {
    const novos: FiltrosForm = {
      ...FILTROS_INICIAIS,
      convenio: convenio !== null ? String(convenio) : "",
    };
    setFiltros(novos);
    if (convenio !== null) setMostrarFiltros(true); // o filtro herdado fica visível
    return novos;
  };

  const jaAtivou = useRef(false);
  useEffect(() => {
    if (!ativa || jaAtivou.current) return;
    jaAtivou.current = true;
    // Esteira de Aprovação (US-08): flag do gesto de mover + indicadores.
    void getEnv()
      .then((e) => setAprovacaoMovimentacao(e.aprovacao?.movimentacaoProposta === true))
      .catch(() => {
        /* sem env, o gesto fica oculto — o painel continua íntegro */
      });
    void carregarMovs();
    // Carrega as etapas e abre a fila pedida pelo Início — ou a primeira com propostas.
    void carregarFilas().then((lista) => {
      const pedida = filaExterna
        ? lista?.find((f) => f.nrStatus === filaExterna.nrStatus)
        : undefined;
      const primeira = pedida ?? lista?.find((f) => f.qtFilhos > 0) ?? lista?.[0];
      let filtrosBase: FiltrosForm | undefined;
      if (filaExterna) {
        filtrosBase = aplicarFiltrosExternos(filaExterna.convenio);
        onFilaExternaConsumida?.();
      }
      if (primeira) {
        setFilaSelecionada(primeira.nrStatus);
        void buscar(primeira.nrStatus, filtrosBase);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- só na 1ª ativação
  }, [ativa]);

  /** Painel já ativo e o Início pediu outra fila: troca na hora. */
  useEffect(() => {
    if (!filaExterna || !jaAtivou.current) return;
    const filtrosBase = aplicarFiltrosExternos(filaExterna.convenio);
    setFilaSelecionada(filaExterna.nrStatus);
    void buscar(filaExterna.nrStatus, filtrosBase);
    onFilaExternaConsumida?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reage só ao pedido externo
  }, [filaExterna]);

  async function carregarFilas(): Promise<FilaWf[] | null> {
    if (carregandoFilas) return filas;
    setCarregandoFilas(true);
    try {
      const res = await getFilasPropostas();
      // Ordem da esteira: os nrStatus crescem no sentido do fluxo.
      const ordenadas = [...res.filas].sort((a, b) => a.nrStatus - b.nrStatus);
      setFilas(ordenadas);
      return ordenadas;
    } catch (e) {
      if (!(e instanceof SessaoExpiradaError)) {
        setFilas([]);
        setErro(`Não foi possível carregar as filas da esteira: ${(e as Error).message}`);
      }
      return null;
    } finally {
      setCarregandoFilas(false);
    }
  }

  /** Monta os filtros efetivos a partir do formulário + fila selecionada. */
  function filtrosEfetivos(status: number | null, base?: FiltrosForm): PainelFiltros {
    const f = base ?? filtros;
    const convenio = Number(f.convenio.trim());
    return {
      nrPropos: f.nrPropos.trim() || undefined,
      nrCPFCNPJ: f.cpf.replace(/\D/g, "") || undefined,
      nmClient: f.nome.trim() || undefined,
      dtPerIni: f.dtIni ? isoParaStr(f.dtIni) : undefined,
      dtPerFim: f.dtFim ? isoParaStr(f.dtFim) : undefined,
      nrStatus: status ?? undefined,
      cdConvProd: f.convenio.trim() !== "" && Number.isFinite(convenio) ? convenio : undefined,
    };
  }

  /**
   * Busca do zero (nova consulta) com a etapa indicada — status é obrigatório.
   * `filtrosBase` cobre o caso de filtros recém-aplicados (state ainda velho).
   */
  async function buscar(status: number | null, filtrosBase?: FiltrosForm) {
    if (carregando || status === null) return;
    setCarregando(true);
    setErro(null);
    setPropostas([]);
    setCursor(null);
    setExpandidas(new Set());
    setSelecionadas(new Set());
    // Indicadores (US-08) atualizados junto com a fila — mesma chamada única.
    void carregarMovs();
    try {
      const res = await painelPropostas({ filtros: filtrosEfetivos(status, filtrosBase) });
      setPropostas(res.propostas);
      setCursor(res.proximoCursor);
    } catch (e) {
      if (!(e instanceof SessaoExpiradaError)) setErro((e as Error).message);
    } finally {
      setCarregando(false);
      setCarregouUmaVez(true);
    }
  }

  /** Próxima página do cursor — acumula sem duplicar nrProsp. */
  async function carregarMais() {
    if (!cursor || carregando) return;
    setCarregando(true);
    setErro(null);
    try {
      const res = await painelPropostas({ filtros: filtrosEfetivos(filaSelecionada), cursor });
      setPropostas((prev) => {
        const vistos = new Set(prev.map((p) => p.nrProsp));
        return [...prev, ...res.propostas.filter((p) => !vistos.has(p.nrProsp))];
      });
      setCursor(res.proximoCursor);
    } catch (e) {
      if (!(e instanceof SessaoExpiradaError)) setErro((e as Error).message);
    } finally {
      setCarregando(false);
    }
  }

  const selecionarFila = (nrStatus: number) => {
    if (nrStatus === filaSelecionada) return;
    setFilaSelecionada(nrStatus);
    void buscar(nrStatus);
  };

  async function toggleHistorico(nrProsp: number) {
    setExpandidas((prev) => {
      const next = new Set(prev);
      next.has(nrProsp) ? next.delete(nrProsp) : next.add(nrProsp);
      return next;
    });
    if (historicos.has(nrProsp)) return;
    setHistoricos((prev) => new Map(prev).set(nrProsp, null));
    try {
      const res = await getHistoricoProposta(nrProsp);
      setHistoricos((prev) => new Map(prev).set(nrProsp, res.historicos));
    } catch {
      setHistoricos((prev) => new Map(prev).set(nrProsp, []));
    }
  }

  const totalNasFilas = useMemo(
    () => (filas ?? []).reduce((acc, f) => acc + f.qtFilhos, 0),
    [filas],
  );

  const filaAtual = useMemo(
    () => filas?.find((f) => f.nrStatus === filaSelecionada) ?? null,
    [filas, filaSelecionada],
  );

  /**
   * Só etapas COM propostas — as de passagem (o motor transita sozinho) e as
   * vazias ficam de fora. A selecionada permanece mesmo que zere no refresh.
   */
  const filasVisiveis = useMemo(
    () => (filas ?? []).filter((f) => f.qtFilhos > 0 || f.nrStatus === filaSelecionada),
    [filas, filaSelecionada],
  );

  /** Nome da etapa sem o sufixo entre parênteses — ele vai para o title. */
  const nomeEtapa = (ds: string) => ds.replace(/\s*\(.*\)\s*$/, "");

  /** Quantos filtros estão preenchidos — visível mesmo com o painel recolhido. */
  const filtrosAtivos = useMemo(
    () => Object.values(filtros).filter((v) => v.trim() !== "").length,
    [filtros],
  );

  /**
   * A fila agrupada por CONVÊNIO — é ele que separa o "bolo" de propostas.
   * Grupos maiores primeiro; dentro do grupo, a ordem original (recentes).
   */
  const gruposPorConvenio = useMemo(() => {
    const mapa = new Map<
      string,
      { cdConv: number | null; nmConv: string; somaValor: number; itens: PropostaPainel[] }
    >();
    for (const p of propostas) {
      const chave = String(p.cdConv ?? "sem");
      if (!mapa.has(chave)) {
        mapa.set(chave, { cdConv: p.cdConv, nmConv: p.nmConv, somaValor: 0, itens: [] });
      }
      const g = mapa.get(chave)!;
      g.itens.push(p);
      g.somaValor += p.vlSolic ?? 0;
    }
    return [...mapa.values()].sort((a, b) => b.itens.length - a.itens.length);
  }, [propostas]);

  return (
    <div className="space-y-6">
      {/* Breadcrumb + título + CTAs de criação */}
      <div className="reveal flex flex-wrap items-end justify-between gap-4">
        <div>
          <Breadcrumb paginaPrincipal="Propostas" atual="Painel de propostas" />
          <h1 className="text-display text-foreground">Painel de propostas</h1>
          <p className="mt-1 text-body text-muted-foreground">
            As propostas do ambiente, etapa a etapa da esteira — acompanhe o histórico,
            mova de fila e crie novas propostas pelos botões ao lado.
          </p>
        </div>
        {onNavegar && (
          <div className="flex shrink-0 flex-wrap gap-2">
            <Button variant="outline" onClick={() => onNavegar("proposta-individual")}>
              <FilePlus2 className="h-4 w-4" />
              Proposta individual
            </Button>
            <Button onClick={() => onNavegar("lote-propostas")}>
              <FileSpreadsheet className="h-4 w-4" />
              Lote de propostas
            </Button>
          </div>
        )}
      </div>

      {erro && (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-body text-destructive">
          <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{erro}</span>
        </div>
      )}

      {info && (
        <div className="flex items-start justify-between gap-2 rounded-lg border border-success/40 bg-success/10 px-4 py-3 text-body text-success">
          <span className="flex items-start gap-2">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
            {info}
          </span>
          <button
            type="button"
            onClick={() => setInfo(null)}
            aria-label="Fechar aviso"
            className="focus-ring text-success/80 hover:text-success"
          >
            <XCircle className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Etapas da esteira — o fluxo inteiro, com contagem por etapa */}
      <Card className="reveal reveal-delay-1" data-tour="painel-esteira">
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle>Esteira</CardTitle>
              <CardDescription>
                {filas === null ? (
                  "Carregando as etapas da esteira…"
                ) : (
                  <>
                    <span className="font-medium text-foreground tabular-nums">
                      {totalNasFilas}
                    </span>{" "}
                    proposta(s) no fluxo — clique numa etapa para ver a fila dela. Etapas
                    vazias (incluindo as de passagem automática) ficam ocultas.
                  </>
                )}
              </CardDescription>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void carregarFilas()}
              disabled={carregandoFilas}
              title="Recarrega as contagens das etapas"
            >
              {carregandoFilas ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {filas === null ? (
            <div className="flex gap-2 overflow-x-auto pb-1">
              {Array.from({ length: 6 }, (_, i) => (
                <Skeleton key={i} className="h-20 w-40 shrink-0 rounded-lg" />
              ))}
            </div>
          ) : (
            <ol className="flex items-stretch gap-0 overflow-x-auto pb-1" aria-label="Etapas da esteira">
              {filasVisiveis.map((f, i) => {
                const ativa = filaSelecionada === f.nrStatus;
                const cat = CATEGORIAS[categoriaDaEtapa(f.nrStatus, f.dsStatus)];
                return (
                  <li key={f.nrStatus} className="flex shrink-0 items-center">
                    {i > 0 && <span aria-hidden className="mx-1 h-px w-4 shrink-0 bg-border" />}
                    <button
                      type="button"
                      onClick={() => selecionarFila(f.nrStatus)}
                      aria-current={ativa ? "true" : undefined}
                      title={`${f.dsStatus} — ${cat.label} (status ${f.nrStatus})`}
                      className={cn(
                        "focus-ring flex h-full w-40 flex-col justify-between gap-1 rounded-lg border px-3 py-2 text-left transition-colors duration-150",
                        ativa
                          ? "border-primary bg-accent"
                          : "border-border hover:border-primary/50",
                        f.qtFilhos === 0 && !ativa && "opacity-60",
                      )}
                    >
                      <span
                        className={cn(
                          "flex items-start gap-1.5 text-caption leading-tight",
                          ativa ? "font-semibold text-accent-foreground" : "text-muted-foreground",
                        )}
                      >
                        {/* Cor da categoria — a mesma do dashboard */}
                        <span
                          aria-hidden
                          className="mt-0.5 h-2.5 w-2.5 shrink-0 rounded-full"
                          style={{ backgroundColor: cat.cor }}
                        />
                        {nomeEtapa(f.dsStatus)}
                      </span>
                      <span
                        className="text-title tabular-nums"
                        style={{ color: f.qtFilhos > 0 ? cat.cor : undefined }}
                      >
                        {f.qtFilhos}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
          )}
        </CardContent>
      </Card>

      {/* Listagem — a tabela é a protagonista; filtros recolhíveis no header */}
      <Card className="reveal reveal-delay-2">
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle>
                {filaAtual ? `Fila: ${nomeEtapa(filaAtual.dsStatus)}` : "Propostas"}
              </CardTitle>
              <CardDescription>
                {propostas.length > 0 ? (
                  <span className="tabular-nums">
                    <span className="font-medium text-foreground">{propostas.length}</span>{" "}
                    proposta(s) nesta etapa, agrupadas por convênio
                    {gruposPorConvenio.length > 1 ? ` (${gruposPorConvenio.length})` : ""}
                    {cursor ? " — há mais para carregar" : ""}
                    {filtrosAtivos > 0 && (
                      <span className="text-warning-foreground">
                        {" "}
                        · {filtrosAtivos} filtro(s) aplicado(s)
                      </span>
                    )}
                  </span>
                ) : (
                  "Selecione uma etapa da esteira para ver a fila dela."
                )}
              </CardDescription>
            </div>
            <div className="flex shrink-0 flex-wrap gap-2">
              {selecionadas.size > 0 && (
                <Button
                  size="sm"
                  onClick={() => void abrirMoverLote()}
                  title="Move todas as selecionadas para a mesma etapa (uma chamada por proposta)"
                >
                  <ArrowRight className="h-4 w-4" />
                  Mover selecionadas ({selecionadas.size})
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={() => setMostrarFiltros((v) => !v)}
                aria-expanded={mostrarFiltros}
                title="Mostra/oculta os filtros da fila"
              >
                <SlidersHorizontal className="h-4 w-4" />
                Filtros{filtrosAtivos > 0 ? ` (${filtrosAtivos})` : ""}
                {mostrarFiltros ? (
                  <ChevronDown className="h-3 w-3" />
                ) : (
                  <ChevronRight className="h-3 w-3" />
                )}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  exportPainelCsv(propostas, filaAtual ? nomeEtapa(filaAtual.dsStatus) : "fila")
                }
                disabled={propostas.length === 0}
                title="Baixa a fila como está na tela (etapa + filtros aplicados)"
              >
                <Download className="h-4 w-4" />
                Exportar CSV ({propostas.length})
              </Button>
            </div>
          </div>

          {/* Painel de filtros — recolhido por padrão, aparece só quando necessário */}
          {mostrarFiltros && (
            <div className="mt-3 flex flex-wrap items-end gap-3 rounded-lg border border-border bg-muted/30 p-3">
              <div className="w-36 space-y-1">
                <Label htmlFor="pf-nr" className="text-caption">
                  Nº da proposta
                </Label>
                <Input
                  id="pf-nr"
                  value={filtros.nrPropos}
                  inputMode="numeric"
                  className="tabular-nums"
                  onChange={(e) => setFiltros((f) => ({ ...f, nrPropos: e.target.value }))}
                  onKeyDown={(e) => e.key === "Enter" && void buscar(filaSelecionada)}
                />
              </div>
              <div className="w-44 space-y-1">
                <Label htmlFor="pf-cpf" className="text-caption">
                  CPF/CNPJ
                </Label>
                <Input
                  id="pf-cpf"
                  value={filtros.cpf}
                  inputMode="numeric"
                  className="tabular-nums"
                  onChange={(e) => setFiltros((f) => ({ ...f, cpf: e.target.value }))}
                  onKeyDown={(e) => e.key === "Enter" && void buscar(filaSelecionada)}
                />
              </div>
              <div className="w-36 space-y-1">
                <Label htmlFor="pf-conv" className="text-caption">
                  Convênio (código)
                </Label>
                <Input
                  id="pf-conv"
                  value={filtros.convenio}
                  inputMode="numeric"
                  className="tabular-nums"
                  onChange={(e) => setFiltros((f) => ({ ...f, convenio: e.target.value }))}
                  onKeyDown={(e) => e.key === "Enter" && void buscar(filaSelecionada)}
                />
              </div>
              <div className="min-w-48 flex-1 space-y-1">
                <Label htmlFor="pf-nome" className="text-caption">
                  Nome do tomador
                </Label>
                <Input
                  id="pf-nome"
                  value={filtros.nome}
                  onChange={(e) => setFiltros((f) => ({ ...f, nome: e.target.value }))}
                  onKeyDown={(e) => e.key === "Enter" && void buscar(filaSelecionada)}
                />
              </div>
              <div className="w-40 space-y-1">
                <Label htmlFor="pf-ini" className="text-caption">
                  Período — de
                </Label>
                <Input
                  id="pf-ini"
                  type="date"
                  className="tabular-nums"
                  value={filtros.dtIni}
                  onChange={(e) => setFiltros((f) => ({ ...f, dtIni: e.target.value }))}
                />
              </div>
              <div className="w-40 space-y-1">
                <Label htmlFor="pf-fim" className="text-caption">
                  até
                </Label>
                <Input
                  id="pf-fim"
                  type="date"
                  className="tabular-nums"
                  value={filtros.dtFim}
                  onChange={(e) => setFiltros((f) => ({ ...f, dtFim: e.target.value }))}
                />
              </div>
              <Button size="sm" onClick={() => void buscar(filaSelecionada)} disabled={carregando}>
                {carregando ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Search className="h-4 w-4" />
                )}
                Buscar
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setFiltros(FILTROS_INICIAIS);
                  void buscar(filaSelecionada);
                }}
                disabled={carregando || filtrosAtivos === 0}
              >
                Limpar
              </Button>
            </div>
          )}
        </CardHeader>
        <CardContent className="space-y-3">
          {carregando && propostas.length === 0 ? (
            <div className="space-y-2 py-2" role="status" aria-label="Carregando propostas">
              <Skeleton className="h-9 w-full" />
              {Array.from({ length: 8 }, (_, i) => (
                <Skeleton key={i} className="h-8 w-full" />
              ))}
            </div>
          ) : propostas.length === 0 && carregouUmaVez ? (
            <div className="flex flex-col items-center gap-2 py-12 text-center">
              <SearchX className="h-8 w-8 text-muted-foreground/60" />
              <p className="text-body text-muted-foreground">
                Nenhuma proposta nesta etapa com estes filtros.
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setFiltros(FILTROS_INICIAIS);
                  void buscar(filaSelecionada);
                }}
              >
                Limpar filtros e recarregar a fila
              </Button>
            </div>
          ) : (
            <Table scroll>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <input
                      type="checkbox"
                      className="focus-ring h-4 w-4 accent-[var(--primary)]"
                      checked={todasSelecionadas}
                      onChange={() => toggleGrupo(propostas)}
                      aria-label="Selecionar todas as propostas carregadas"
                      disabled={propostas.length === 0}
                    />
                  </TableHead>
                  <TableHead className="w-20 text-right">Nº</TableHead>
                  <TableHead>Tomador</TableHead>
                  <TableHead>CPF/CNPJ</TableHead>
                  <TableHead>Produto</TableHead>
                  <TableHead className="text-right">Valor</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Entrada</TableHead>
                  <TableHead className="text-right">
                    <span className="inline-flex items-center gap-1">
                      SLA
                      <Hint id="painel_sla" />
                    </span>
                  </TableHead>
                  <TableHead className="text-right">Contrato</TableHead>
                  <TableHead>Histórico</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {gruposPorConvenio.map((g) => (
                  <Fragment key={`conv-${g.cdConv ?? "sem"}`}>
                    {/* Cabeçalho do grupo — o convênio separa o "bolo" de propostas */}
                    <TableRow className="bg-muted/60 hover:bg-muted/60">
                      <TableCell className="py-2">
                        <input
                          type="checkbox"
                          className="focus-ring h-4 w-4 accent-[var(--primary)]"
                          checked={g.itens.every((p) => selecionadas.has(p.nrProsp))}
                          onChange={() => toggleGrupo(g.itens)}
                          aria-label={`Selecionar todas do convênio ${g.cdConv ?? "—"}`}
                        />
                      </TableCell>
                      <TableCell colSpan={10} className="py-2">
                        <span className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                          <span className="text-caption font-medium uppercase tracking-label text-muted-foreground">
                            Convênio
                          </span>
                          <span className="text-body font-semibold">
                            <span className="tabular-nums">{g.cdConv ?? "—"}</span>
                            {g.nmConv ? ` — ${g.nmConv}` : ""}
                          </span>
                          <span className="text-caption text-muted-foreground tabular-nums">
                            {g.itens.length} proposta(s) · {formatBRL(g.somaValor)}
                          </span>
                        </span>
                      </TableCell>
                    </TableRow>
                    {g.itens.map((p) => {
                  const aberta = expandidas.has(p.nrProsp);
                  const hist = historicos.get(p.nrProsp);
                  return (
                    <Fragment key={p.nrProsp}>
                      <TableRow className={cn(selecionadas.has(p.nrProsp) && "bg-accent/50")}>
                        <TableCell>
                          <input
                            type="checkbox"
                            className="focus-ring h-4 w-4 accent-[var(--primary)]"
                            checked={selecionadas.has(p.nrProsp)}
                            onChange={() => toggleSelecionada(p.nrProsp)}
                            aria-label={`Selecionar proposta ${p.nrProsp}`}
                          />
                        </TableCell>
                        <TableCell className="text-right font-semibold tabular-nums">
                          {p.nrProsp}
                        </TableCell>
                        <TableCell className="max-w-52 truncate font-medium" title={p.nmClient}>
                          {p.nmClient || "—"}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-label tabular-nums">
                          {formatCpf(p.nrCpfCnpj)}
                        </TableCell>
                        <TableCell
                          className="max-w-40 truncate"
                          title={`${p.cdProd ?? "—"} — ${p.dsProd}`}
                        >
                          <span className="tabular-nums">{p.cdProd ?? "—"}</span>{" "}
                          <span className="text-muted-foreground">{p.dsProd}</span>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatBRL(p.vlSolic)}
                        </TableCell>
                        <TableCell>
                          <span className="inline-flex flex-wrap items-center gap-1.5">
                            <StatusPill nrStatus={p.nrStatus} dsStatus={p.dsStatus} />
                            {/* Movimentação em aprovação (US-08, RN05): a proposta
                                segue NESTA etapa; o chip mostra a requisição ativa */}
                            {movs.has(p.nrProsp) && (
                              <IndicadorMovimentacao
                                mov={movs.get(p.nrProsp)!}
                                onAbrir={(id) => void abrirMovDetalhe(id)}
                              />
                            )}
                          </span>
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-right tabular-nums">
                          {formatDataAAAAMMDD(p.dtEntrad)} {formatHora(p.hrEntrad)}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-right">
                          {(() => {
                            const horas = horasNaEtapa(p.dtEntrad, p.hrEntrad);
                            if (horas === null)
                              return <span className="text-muted-foreground">—</span>;
                            const acima = horas > SLA_HORAS_ATENCAO;
                            return (
                              <span
                                className={cn(
                                  "inline-flex items-center gap-1 tabular-nums",
                                  acima && "font-medium text-laranja",
                                )}
                                title={
                                  acima
                                    ? `Parada há ${Math.floor(horas)} h — acima do SLA de ${SLA_HORAS_ATENCAO} h`
                                    : `${Math.floor(horas)} h nesta etapa (régua: ${SLA_HORAS_ATENCAO} h)`
                                }
                              >
                                {labelSla(horas)}
                                {acima && <AlertTriangle className="h-3.5 w-3.5" />}
                              </span>
                            );
                          })()}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {p.nrContra ?? "—"}
                        </TableCell>
                        <TableCell>
                          <span className="flex items-center gap-2">
                            {/* Mover direto mora no lote (checkbox + CTA); com a
                                Esteira de Aprovação ativa, o gesto INDIVIDUAL
                                cria uma requisição (US-08). */}
                            <button
                              type="button"
                              onClick={() => void toggleHistorico(p.nrProsp)}
                              className="focus-ring flex items-center gap-1 text-caption text-primary hover:underline"
                            >
                              {aberta ? (
                                <ChevronDown className="h-3 w-3" />
                              ) : (
                                <ChevronRight className="h-3 w-3" />
                              )}
                              histórico
                            </button>
                            {aprovacaoMovimentacao &&
                              (movs.has(p.nrProsp) ? (
                                <span
                                  className="cursor-not-allowed text-caption text-muted-foreground"
                                  title="Já existe uma requisição de movimentação ativa para esta proposta — decida, cancele ou resolva a falha antes de mover de novo."
                                >
                                  mover
                                </span>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => void abrirMover(p)}
                                  className="focus-ring flex items-center gap-1 text-caption text-primary hover:underline"
                                  title="Cria uma requisição de movimentação para aprovação de um segundo operador"
                                >
                                  <ArrowRight className="h-3 w-3" />
                                  mover
                                </button>
                              ))}
                          </span>
                        </TableCell>
                      </TableRow>
                      {aberta && (
                        <TableRow>
                          <TableCell colSpan={11} className="bg-muted/40">
                            {hist === null || hist === undefined ? (
                              <div className="flex items-center gap-2 py-2 text-caption text-muted-foreground">
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                Carregando o histórico…
                              </div>
                            ) : hist.length === 0 ? (
                              <p className="py-2 text-caption text-muted-foreground">
                                Sem histórico disponível para esta proposta.
                              </p>
                            ) : (
                              <ol className="space-y-1 py-1 text-caption">
                                {hist.map((h) => (
                                  <li key={h.nrSeq} className="flex flex-wrap items-baseline gap-x-2">
                                    <span className="w-8 text-right tabular-nums text-muted-foreground">
                                      {h.nrSeq}.
                                    </span>
                                    <span className="tabular-nums text-muted-foreground">
                                      {h.dtIn}
                                    </span>
                                    <PontoCategoria nrStatus={h.nrStatus} dsStatus={h.dsStatus} />
                                    <span className="font-medium">{h.dsStatus}</span>
                                    <span className="text-muted-foreground">
                                      por {h.nmUsr || "—"}
                                    </span>
                                    {h.dsObserv && (
                                      <span className="text-muted-foreground">
                                        — “{h.dsObserv}”
                                      </span>
                                    )}
                                  </li>
                                ))}
                              </ol>
                            )}
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  );
                    })}
                  </Fragment>
                ))}
              </TableBody>
            </Table>
          )}

          {cursor && propostas.length > 0 && (
            <div className="flex justify-center">
              <Button variant="outline" onClick={() => void carregarMais()} disabled={carregando}>
                {carregando ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                Carregar mais
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Mover EM LOTE — job com progresso ao vivo; efeito real no workflow */}
      <Dialog
        open={loteOpen}
        onOpenChange={(o) => {
          if (o || loteMovendo) return; // não fecha no meio do lote
          setLoteOpen(false);
          if (loteConcluido) {
            void carregarFilas();
            void buscar(filaSelecionada);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className={cn("flex items-center gap-2", IS_PROD && "text-destructive")}>
              <AlertTriangle className={cn("h-5 w-5", IS_PROD ? "" : "text-warning")} />
              Mover {selecionadas.size} proposta(s) em lote
            </DialogTitle>
            <DialogDescription>
              Todas saem de{" "}
              <strong>{filaAtual ? nomeEtapa(filaAtual.dsStatus) : "—"}</strong> para o mesmo
              destino, em <strong>{IS_PROD ? "PRODUÇÃO" : "HOMOLOGAÇÃO"}</strong> — uma
              chamada por proposta na Sinqia, sem desfazer pela ferramenta.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            {loteErro && (
              <p className="flex items-start gap-1.5 text-caption text-destructive">
                <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {loteErro}
              </p>
            )}

            {loteMovendo || loteConcluido ? (
              <div className="space-y-2">
                <div className="h-2 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary transition-all duration-200"
                    style={{
                      width: `${loteProgress.total > 0 ? (loteProgress.processed / loteProgress.total) * 100 : 0}%`,
                    }}
                  />
                </div>
                <p className="text-body tabular-nums">
                  {loteProgress.processed}/{loteProgress.total} processadas ·{" "}
                  <span className="text-success">{loteProgress.success} movidas</span> ·{" "}
                  <span className="text-destructive">{loteProgress.error} erro(s)</span>
                  {loteProgress.naoEnviado > 0 && <> · {loteProgress.naoEnviado} não enviadas</>}
                </p>
                {loteFalhas.length > 0 && (
                  <ul className="max-h-32 space-y-1 overflow-y-auto text-caption text-destructive">
                    {loteFalhas.map((f) => (
                      <li key={f.nrProsp} className="tabular-nums">
                        nº {f.nrProsp} — {f.detalhe}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ) : loteTransicoes === null ? (
              <div className="space-y-2">
                <Skeleton className="h-9 w-full" />
                <Skeleton className="h-9 w-full" />
              </div>
            ) : loteTransicoes.length === 0 ? (
              <p className="text-body text-muted-foreground">
                O workflow não permite mover propostas a partir desta etapa.
              </p>
            ) : (
              <>
                <div className="space-y-1" role="radiogroup" aria-label="Etapa de destino do lote">
                  {loteTransicoes.map((t) => (
                    <label
                      key={t.proxStatus}
                      className={cn(
                        "flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-body transition-colors duration-150",
                        loteDestino === t.proxStatus
                          ? "border-primary bg-accent"
                          : "border-border hover:border-primary/50",
                      )}
                    >
                      <input
                        type="radio"
                        name="destino-lote"
                        className="focus-ring h-4 w-4 accent-[var(--primary)]"
                        checked={loteDestino === t.proxStatus}
                        onChange={() => setLoteDestino(t.proxStatus)}
                      />
                      <PontoCategoria nrStatus={t.proxStatus} dsStatus={t.dsStatus} />
                      <span className="flex-1 font-medium">{nomeEtapa(t.dsStatus)}</span>
                      {t.exigeObservacao && (
                        <span className="text-caption text-muted-foreground">
                          exige observação
                        </span>
                      )}
                    </label>
                  ))}
                </div>

                <div className="space-y-1">
                  <Label htmlFor="lote-obs" className="text-caption">
                    Observação
                    {loteTransicao?.exigeObservacao ? (
                      <span className="text-destructive"> (obrigatória)</span>
                    ) : (
                      " (opcional)"
                    )}
                  </Label>
                  <Input
                    id="lote-obs"
                    value={loteObservacao}
                    maxLength={500}
                    placeholder="Ex.: Contratos assinados"
                    onChange={(e) => setLoteObservacao(e.target.value)}
                  />
                  <p className="text-caption text-muted-foreground">
                    A mesma observação vai para o histórico de todas as propostas do lote.
                  </p>
                </div>

                {IS_PROD && (
                  <div className="space-y-1">
                    <Label htmlFor="lote-confirma" className="text-caption">
                      Digite <strong>MOVER</strong> para liberar:
                    </Label>
                    <Input
                      id="lote-confirma"
                      value={loteConfirmText}
                      onChange={(e) => setLoteConfirmText(e.target.value)}
                      placeholder="MOVER"
                    />
                  </div>
                )}
              </>
            )}
          </div>

          <DialogFooter>
            {loteConcluido ? (
              <Button
                onClick={() => {
                  setLoteOpen(false);
                  void carregarFilas();
                  void buscar(filaSelecionada);
                }}
              >
                Fechar e atualizar a fila
              </Button>
            ) : (
              <>
                <Button variant="outline" onClick={() => setLoteOpen(false)} disabled={loteMovendo}>
                  Cancelar
                </Button>
                <Button
                  variant={IS_PROD ? "destructive" : "default"}
                  onClick={() => void confirmarMoverLote()}
                  disabled={!podeMoverLote}
                >
                  {loteMovendo ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <ArrowRight className="h-4 w-4" />
                  )}
                  Mover {selecionadas.size} proposta(s)
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Mover INDIVIDUAL sob aprovação (US-08): confirmação → requisição
          pendente, ZERO Sinqia — a execução acontece na sessão do aprovador */}
      <Dialog
        open={moverProposta !== null}
        onOpenChange={(o) => {
          if (!o && !moverEnviando) setMoverProposta(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ArrowRight className="h-5 w-5 text-primary" />
              Mover proposta nº {moverProposta?.nrProsp}
            </DialogTitle>
            <DialogDescription>
              A movimentação está sob aprovação (SoD): confirmar cria uma{" "}
              <strong>requisição pendente</strong> para um segundo operador decidir. Nada é
              movido agora — a proposta permanece em{" "}
              <strong>{filaAtual ? nomeEtapa(filaAtual.dsStatus) : "—"}</strong> com um
              indicador até a decisão.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            {moverErro && (
              <p className="flex items-start gap-1.5 text-caption text-destructive">
                <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {moverErro}
              </p>
            )}

            {moverTransicoes === null ? (
              <div className="space-y-2">
                <Skeleton className="h-9 w-full" />
                <Skeleton className="h-9 w-full" />
              </div>
            ) : moverTransicoes.length === 0 ? (
              <p className="text-body text-muted-foreground">
                O workflow não permite mover propostas a partir desta etapa.
              </p>
            ) : (
              <>
                <div
                  className="space-y-1"
                  role="radiogroup"
                  aria-label="Etapa de destino da movimentação"
                >
                  {moverTransicoes.map((t) => (
                    <label
                      key={t.proxStatus}
                      className={cn(
                        "flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-body transition-colors duration-150",
                        moverDestino === t.proxStatus
                          ? "border-primary bg-accent"
                          : "border-border hover:border-primary/50",
                      )}
                    >
                      <input
                        type="radio"
                        name="destino-individual"
                        className="focus-ring h-4 w-4 accent-[var(--primary)]"
                        checked={moverDestino === t.proxStatus}
                        onChange={() => setMoverDestino(t.proxStatus)}
                      />
                      <PontoCategoria nrStatus={t.proxStatus} dsStatus={t.dsStatus} />
                      <span className="flex-1 font-medium">{nomeEtapa(t.dsStatus)}</span>
                      {t.exigeObservacao && (
                        <span className="text-caption text-muted-foreground">
                          exige observação
                        </span>
                      )}
                    </label>
                  ))}
                </div>

                <div className="space-y-1">
                  <Label htmlFor="mover-obs" className="text-caption">
                    Observação
                    {moverTransicao?.exigeObservacao ? (
                      <span className="text-destructive"> (obrigatória)</span>
                    ) : (
                      " (opcional)"
                    )}
                  </Label>
                  <Input
                    id="mover-obs"
                    value={moverObservacao}
                    maxLength={500}
                    placeholder="Ex.: Contrato assinado"
                    onChange={(e) => setMoverObservacao(e.target.value)}
                  />
                  <p className="text-caption text-muted-foreground">
                    Vai para o histórico da proposta quando a movimentação for aprovada e
                    executada.
                  </p>
                </div>
              </>
            )}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setMoverProposta(null)}
              disabled={moverEnviando}
            >
              Cancelar
            </Button>
            <Button onClick={() => void confirmarMover()} disabled={!podeConfirmarMover}>
              {moverEnviando ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ArrowRight className="h-4 w-4" />
              )}
              Criar requisição de movimentação
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Detalhe da requisição de movimentação (indicador clicado — RN05),
          com cancelamento pelo criador (RN06: libera o bloqueio) */}
      <Drawer open={movDetalheId !== null} onOpenChange={(o) => !o && setMovDetalheId(null)}>
        <DrawerContent>
          <DrawerHeader>
            <DrawerTitle className="flex flex-wrap items-center gap-2">
              {ROTULO_TIPO_ACAO["proposta.movimentar"]}
              {movReq && <BadgeEstado estado={movReq.estado} />}
            </DrawerTitle>
            <DrawerDescription className="break-all font-mono text-caption">
              {movDetalheId}
            </DrawerDescription>
          </DrawerHeader>

          {movDetalheCarregando && (
            <div className="space-y-2">
              <Skeleton className="h-6 w-2/3" />
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-24 w-full" />
            </div>
          )}

          {movDetalheErro && (
            <div className="flex items-start gap-2 rounded-lg border border-destructive bg-destructive/10 px-3 py-2 text-sm text-destructive">
              <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{movDetalheErro}</span>
            </div>
          )}

          {movReq && (
            <div className="space-y-5 text-sm">
              <RequisicaoDetalhe requisicao={movReq} historico={movDetalhe?.historico ?? []} />

              {/* Cancelar — só o criador, só pendente (RN06) */}
              {podeCancelarMov && (
                <div className="border-t border-border pt-4">
                  {movConfirmCancelar ? (
                    <div className="space-y-2">
                      <p className="text-body">
                        Cancelar a requisição? O indicador some do painel e a proposta fica
                        liberada para nova movimentação.
                      </p>
                      <div className="flex gap-2">
                        <Button
                          variant="destructive"
                          disabled={movCancelando}
                          onClick={() => void cancelarMovimentacao()}
                        >
                          {movCancelando ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Ban className="h-4 w-4" />
                          )}
                          Confirmar cancelamento
                        </Button>
                        <Button
                          variant="outline"
                          disabled={movCancelando}
                          onClick={() => setMovConfirmCancelar(false)}
                        >
                          Voltar
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <Button
                        variant="destructive"
                        disabled={movCancelando}
                        onClick={() => setMovConfirmCancelar(true)}
                      >
                        <Ban className="h-4 w-4" />
                        Cancelar requisição
                      </Button>
                      <p className="mt-1.5 text-caption text-muted-foreground">
                        Disponível porque a requisição é sua e ainda está pendente.
                      </p>
                    </>
                  )}
                </div>
              )}
            </div>
          )}
        </DrawerContent>
      </Drawer>

    </div>
  );
}
