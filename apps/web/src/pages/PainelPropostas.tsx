import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Loader2,
  RefreshCw,
  Search,
  SearchX,
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
import { cn } from "@/lib/utils";
import {
  getFilasPropostas,
  getHistoricoProposta,
  painelPropostas,
  type FilaWf,
  type HistoricoPropostaItem,
  type PainelCursor,
  type PainelFiltros,
  type PropostaPainel,
} from "@/lib/api";
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
}

const FILTROS_INICIAIS: FiltrosForm = { nrPropos: "", cpf: "", nome: "", dtIni: "", dtFim: "" };

const isoParaStr = (iso: string) => iso.replace(/-/g, "");

/** "1536" (HHMM) → "15:36". */
function formatHora(hr: number | null): string {
  if (hr === null) return "";
  const s = String(hr).padStart(4, "0");
  return `${s.slice(0, 2)}:${s.slice(2, 4)}`;
}

/** Cor do badge por família de status — estado, nunca decoração. */
function variantDoStatus(ds: string): "success" | "warning" | "destructive" | "secondary" {
  if (/cancelad|negad/i.test(ds)) return "destructive";
  if (/assinado|aprovado|desembols|finalizado/i.test(ds)) return "success";
  if (/pendent|assinatura|risco/i.test(ds)) return "warning";
  return "secondary";
}

export function PainelPropostas({ ativa }: { ativa: boolean }) {
  const [filas, setFilas] = useState<FilaWf[] | null>(null);
  const [carregandoFilas, setCarregandoFilas] = useState(false);
  const [mostrarVazias, setMostrarVazias] = useState(false);
  /** Fila selecionada (nrStatus) — filtra a listagem. null = todas. */
  const [filaSelecionada, setFilaSelecionada] = useState<number | null>(null);

  const [filtros, setFiltros] = useState<FiltrosForm>(FILTROS_INICIAIS);
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

  const jaAtivou = useRef(false);
  useEffect(() => {
    if (!ativa || jaAtivou.current) return;
    jaAtivou.current = true;
    void carregarFilas();
    void buscar(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- só na 1ª ativação
  }, [ativa]);

  async function carregarFilas() {
    if (carregandoFilas) return;
    setCarregandoFilas(true);
    try {
      const res = await getFilasPropostas();
      setFilas(res.filas);
    } catch (e) {
      // Filas são orientação; a listagem funciona sem elas.
      if (!(e instanceof SessaoExpiradaError)) setFilas([]);
    } finally {
      setCarregandoFilas(false);
    }
  }

  /** Monta os filtros efetivos a partir do formulário + fila selecionada. */
  function filtrosEfetivos(status: number | null): PainelFiltros {
    return {
      nrPropos: filtros.nrPropos.trim() || undefined,
      nrCPFCNPJ: filtros.cpf.replace(/\D/g, "") || undefined,
      nmClient: filtros.nome.trim() || undefined,
      dtPerIni: filtros.dtIni ? isoParaStr(filtros.dtIni) : undefined,
      dtPerFim: filtros.dtFim ? isoParaStr(filtros.dtFim) : undefined,
      nrStatus: status ?? undefined,
    };
  }

  /** Busca do zero (nova consulta) com a fila indicada. */
  async function buscar(status: number | null) {
    if (carregando) return;
    setCarregando(true);
    setErro(null);
    setPropostas([]);
    setCursor(null);
    setExpandidas(new Set());
    try {
      const res = await painelPropostas({ filtros: filtrosEfetivos(status) });
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

  const selecionarFila = (nrStatus: number | null) => {
    const novo = filaSelecionada === nrStatus ? null : nrStatus;
    setFilaSelecionada(novo);
    void buscar(novo);
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

  const filasVisiveis = useMemo(() => {
    if (!filas) return [];
    return filas.filter(
      (f) => mostrarVazias || f.qtFilhos > 0 || f.nrStatus === filaSelecionada,
    );
  }, [filas, mostrarVazias, filaSelecionada]);

  const totalNasFilas = useMemo(
    () => (filas ?? []).reduce((acc, f) => acc + f.qtFilhos, 0),
    [filas],
  );

  return (
    <div className="space-y-6">
      {/* Breadcrumb + título */}
      <div>
        <div className="mb-3 text-caption text-muted-foreground">
          Esteira de Originação › Propostas › Painel de propostas
        </div>
        <h1 className="text-display text-foreground">Painel de propostas</h1>
        <p className="mt-1 text-body text-muted-foreground">
          Todas as propostas do ambiente, direto da esteira — filtre por fila, cliente ou
          período e acompanhe o histórico de cada uma. Somente leitura.
        </p>
      </div>

      {erro && (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-body text-destructive">
          <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{erro}</span>
        </div>
      )}

      {/* Filas do workflow */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle>Filas da esteira</CardTitle>
              <CardDescription>
                {filas === null ? (
                  "Carregando as filas do workflow…"
                ) : (
                  <>
                    <span className="font-medium text-foreground tabular-nums">
                      {totalNasFilas}
                    </span>{" "}
                    proposta(s) distribuída(s) nas filas — clique para filtrar.
                  </>
                )}
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setMostrarVazias((v) => !v)}
                className="focus-ring text-caption text-primary underline-offset-2 hover:underline"
              >
                {mostrarVazias ? "ocultar filas vazias" : "mostrar filas vazias"}
              </button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void carregarFilas()}
                disabled={carregandoFilas}
                title="Recarrega as contagens das filas"
              >
                {carregandoFilas ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4" />
                )}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {filas === null ? (
            <div className="flex flex-wrap gap-2">
              {Array.from({ length: 6 }, (_, i) => (
                <Skeleton key={i} className="h-7 w-40 rounded-full" />
              ))}
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => selecionarFila(null)}
                className={cn(
                  "focus-ring rounded-full border px-3 py-1 text-caption font-medium transition-colors duration-150",
                  filaSelecionada === null
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border text-muted-foreground hover:border-primary hover:text-foreground",
                )}
              >
                Todas
              </button>
              {filasVisiveis.map((f) => (
                <button
                  key={f.nrStatus}
                  type="button"
                  onClick={() => selecionarFila(f.nrStatus)}
                  title={`Status ${f.nrStatus} (workflow ${f.nrWf})`}
                  className={cn(
                    "focus-ring rounded-full border px-3 py-1 text-caption font-medium transition-colors duration-150 tabular-nums",
                    filaSelecionada === f.nrStatus
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border text-muted-foreground hover:border-primary hover:text-foreground",
                    f.qtFilhos === 0 && filaSelecionada !== f.nrStatus && "opacity-60",
                  )}
                >
                  {f.dsStatus} · {f.qtFilhos}
                </button>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Filtros */}
      <Card>
        <CardHeader>
          <CardTitle>Filtros</CardTitle>
          <CardDescription>
            Todos opcionais — combinam com a fila selecionada acima.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-end gap-3">
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
            <div className="min-w-48 flex-1 space-y-1">
              <Label htmlFor="pf-nome" className="text-caption">
                Nome do cliente
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
            <Button onClick={() => void buscar(filaSelecionada)} disabled={carregando}>
              {carregando ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Search className="h-4 w-4" />
              )}
              Buscar
            </Button>
            <Button
              variant="ghost"
              onClick={() => setFiltros(FILTROS_INICIAIS)}
              disabled={carregando}
            >
              Limpar filtros
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Listagem */}
      <Card>
        <CardHeader>
          <CardTitle>Propostas</CardTitle>
          <CardDescription>
            {propostas.length > 0 ? (
              <span className="tabular-nums">
                <span className="font-medium text-foreground">{propostas.length}</span>{" "}
                proposta(s) carregada(s), mais recentes primeiro
                {cursor ? " — há mais para carregar" : ""}
              </span>
            ) : (
              "As propostas aparecem aqui, mais recentes primeiro."
            )}
          </CardDescription>
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
                Nenhuma proposta com estes filtros.
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setFiltros(FILTROS_INICIAIS);
                  setFilaSelecionada(null);
                  void buscar(null);
                }}
              >
                Ver todas
              </Button>
            </div>
          ) : (
            <Table scroll>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-20 text-right">Nº</TableHead>
                  <TableHead>Cliente</TableHead>
                  <TableHead>CPF/CNPJ</TableHead>
                  <TableHead>Produto</TableHead>
                  <TableHead className="text-right">Valor</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Entrada</TableHead>
                  <TableHead className="text-right">Contrato</TableHead>
                  <TableHead>Histórico</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {propostas.map((p) => {
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
                          <Badge variant={variantDoStatus(p.dsStatus)} title={`Status ${p.nrStatus ?? "—"}`}>
                            {p.dsStatus || "—"}
                          </Badge>
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-right tabular-nums">
                          {formatDataAAAAMMDD(p.dtEntrad)} {formatHora(p.hrEntrad)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {p.nrContra ?? "—"}
                        </TableCell>
                        <TableCell>
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
                            {aberta ? "ocultar" : "ver"}
                          </button>
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
    </div>
  );
}
