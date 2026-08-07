import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
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
import { IS_PROD } from "@/components/Topbar";
import { Breadcrumb } from "@/components/Breadcrumb";
import { CATEGORIAS, categoriaDaEtapa } from "@/lib/esteira";
import { cn } from "@/lib/utils";
import {
  getFilasPropostas,
  getHistoricoProposta,
  getTransicoesProposta,
  painelPropostas,
  transferirProposta,
  type FilaWf,
  type HistoricoPropostaItem,
  type PainelCursor,
  type PainelFiltros,
  type PropostaPainel,
  type TransicaoStatus,
} from "@/lib/api";
import { exportPainelCsv } from "@/lib/export-csv";
import { formatBRL, formatCpf, formatDataAAAAMMDD } from "@/lib/format";
import { SessaoExpiradaError } from "@/lib/session";

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

  /* --- Mover de fila (Fase 2 — efeito real no workflow) --- */
  const [moverAlvo, setMoverAlvo] = useState<PropostaPainel | null>(null);
  const [transicoes, setTransicoes] = useState<TransicaoStatus[] | null>(null);
  const [destino, setDestino] = useState<number | null>(null);
  const [observacao, setObservacao] = useState("");
  const [moverConfirmText, setMoverConfirmText] = useState("");
  const [movendo, setMovendo] = useState(false);
  const [moverErro, setMoverErro] = useState<string | null>(null);
  /** Mensagem de sucesso da última transferência. */
  const [info, setInfo] = useState<string | null>(null);

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

  /** Abre o dialog de transferência e busca os destinos permitidos. */
  async function abrirMover(p: PropostaPainel) {
    if (p.nrStatus === null || p.nrWf === null) return;
    setMoverAlvo(p);
    setTransicoes(null);
    setDestino(null);
    setObservacao("");
    setMoverConfirmText("");
    setMoverErro(null);
    try {
      const res = await getTransicoesProposta(p.nrWf, p.nrStatus);
      setTransicoes(res.transicoes);
    } catch (e) {
      if (!(e instanceof SessaoExpiradaError)) setMoverErro((e as Error).message);
      setTransicoes([]);
    }
  }

  const transicaoEscolhida = transicoes?.find((t) => t.proxStatus === destino) ?? null;
  const observacaoOk = !transicaoEscolhida?.exigeObservacao || observacao.trim() !== "";
  const confirmacaoMoverOk = !IS_PROD || moverConfirmText.trim().toUpperCase() === "MOVER";
  const podeMover =
    !!moverAlvo && !!transicaoEscolhida && observacaoOk && confirmacaoMoverOk && !movendo;

  /** Executa a transferência e recarrega a esteira + a fila atual. */
  async function confirmarMover() {
    if (!moverAlvo || !transicaoEscolhida || !podeMover) return;
    setMovendo(true);
    setMoverErro(null);
    try {
      const res = await transferirProposta({
        nrProsp: moverAlvo.nrProsp,
        nrWf: moverAlvo.nrWf!,
        nrStatusAtual: moverAlvo.nrStatus!,
        proxStatus: transicaoEscolhida.proxStatus,
        dsObserv: observacao.trim(),
        nrCpf: moverAlvo.nrCpfCnpj,
        nmCliente: moverAlvo.nmClient,
        cdProd: moverAlvo.cdProd ?? 0,
        nrContra: moverAlvo.nrContra,
      });
      setInfo(
        `Proposta ${moverAlvo.nrProsp} movida para "${nomeEtapa(res.destino.dsStatus)}".`,
      );
      // Histórico daquela proposta mudou — invalida o cache dela.
      setHistoricos((prev) => {
        const next = new Map(prev);
        next.delete(moverAlvo.nrProsp);
        return next;
      });
      setMoverAlvo(null);
      void carregarFilas();
      void buscar(filaSelecionada);
    } catch (e) {
      if (!(e instanceof SessaoExpiradaError)) setMoverErro((e as Error).message);
    } finally {
      setMovendo(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Breadcrumb + título + CTAs de criação */}
      <div className="flex flex-wrap items-end justify-between gap-4">
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
      <Card>
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
      <Card>
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
                  <TableHead className="w-20 text-right">Nº</TableHead>
                  <TableHead>Tomador</TableHead>
                  <TableHead>CPF/CNPJ</TableHead>
                  <TableHead>Produto</TableHead>
                  <TableHead className="text-right">Valor</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Entrada</TableHead>
                  <TableHead className="text-right">SLA</TableHead>
                  <TableHead className="text-right">Contrato</TableHead>
                  <TableHead>Ações</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {gruposPorConvenio.map((g) => (
                  <Fragment key={`conv-${g.cdConv ?? "sem"}`}>
                    {/* Cabeçalho do grupo — o convênio separa o "bolo" de propostas */}
                    <TableRow className="bg-muted/60 hover:bg-muted/60">
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
                      <TableRow>
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
                          <StatusPill nrStatus={p.nrStatus} dsStatus={p.dsStatus} />
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
                          <span className="flex items-center gap-3">
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
                            <button
                              type="button"
                              onClick={() => void abrirMover(p)}
                              disabled={p.nrStatus === null || p.nrWf === null}
                              title="Move a proposta para outra etapa do workflow"
                              className="focus-ring flex items-center gap-1 text-caption text-primary hover:underline disabled:opacity-50"
                            >
                              <ArrowRight className="h-3 w-3" />
                              mover
                            </button>
                          </span>
                        </TableCell>
                      </TableRow>
                      {aberta && (
                        <TableRow>
                          <TableCell colSpan={9} className="bg-muted/40">
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

      {/* Mover de fila — fricção deliberada: efeito real no workflow */}
      <Dialog open={moverAlvo !== null} onOpenChange={(o) => !o && setMoverAlvo(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className={cn("flex items-center gap-2", IS_PROD && "text-destructive")}>
              <AlertTriangle className={cn("h-5 w-5", IS_PROD ? "" : "text-warning")} />
              Mover proposta {moverAlvo?.nrProsp}
            </DialogTitle>
            <DialogDescription>
              <strong>{moverAlvo?.nmClient || "—"}</strong> está em{" "}
              <strong>{moverAlvo ? nomeEtapa(moverAlvo.dsStatus) : "—"}</strong> em{" "}
              <strong>{IS_PROD ? "PRODUÇÃO" : "HOMOLOGAÇÃO"}</strong>. Os destinos abaixo
              são os que o workflow permite; a ferramenta não desfaz o movimento.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            {moverErro && (
              <p className="flex items-start gap-1.5 text-caption text-destructive">
                <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {moverErro}
              </p>
            )}

            {transicoes === null ? (
              <div className="space-y-2">
                <Skeleton className="h-9 w-full" />
                <Skeleton className="h-9 w-full" />
              </div>
            ) : transicoes.length === 0 ? (
              <p className="text-body text-muted-foreground">
                O workflow não permite mover a proposta a partir desta etapa.
              </p>
            ) : (
              <div className="space-y-1" role="radiogroup" aria-label="Etapa de destino">
                {transicoes.map((t) => (
                  <label
                    key={t.proxStatus}
                    className={cn(
                      "flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-body transition-colors duration-150",
                      destino === t.proxStatus
                        ? "border-primary bg-accent"
                        : "border-border hover:border-primary/50",
                    )}
                  >
                    <input
                      type="radio"
                      name="destino-transferencia"
                      className="focus-ring h-4 w-4 accent-[var(--primary)]"
                      checked={destino === t.proxStatus}
                      onChange={() => setDestino(t.proxStatus)}
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
            )}

            {transicoes && transicoes.length > 0 && (
              <div className="space-y-1">
                <Label htmlFor="mover-obs" className="text-caption">
                  Observação
                  {transicaoEscolhida?.exigeObservacao ? (
                    <span className="text-destructive"> (obrigatória)</span>
                  ) : (
                    " (opcional)"
                  )}
                </Label>
                <Input
                  id="mover-obs"
                  value={observacao}
                  maxLength={500}
                  placeholder="Ex.: Contrato assinado"
                  onChange={(e) => setObservacao(e.target.value)}
                />
                <p className="text-caption text-muted-foreground">
                  A observação fica registrada no histórico da proposta.
                </p>
              </div>
            )}

            {IS_PROD && transicoes && transicoes.length > 0 && (
              <div className="space-y-1">
                <Label htmlFor="mover-confirma" className="text-caption">
                  Digite <strong>MOVER</strong> para liberar:
                </Label>
                <Input
                  id="mover-confirma"
                  value={moverConfirmText}
                  onChange={(e) => setMoverConfirmText(e.target.value)}
                  placeholder="MOVER"
                />
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setMoverAlvo(null)} disabled={movendo}>
              Cancelar
            </Button>
            <Button
              variant={IS_PROD ? "destructive" : "default"}
              onClick={() => void confirmarMover()}
              disabled={!podeMover}
            >
              {movendo ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ArrowRight className="h-4 w-4" />
              )}
              {transicaoEscolhida
                ? `Mover para ${nomeEtapa(transicaoEscolhida.dsStatus)}`
                : "Mover"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
