import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Calculator,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ClipboardList,
  Download,
  FileSpreadsheet,
  Inbox,
  Loader2,
  SearchX,
  UserCheck,
  XCircle,
} from "lucide-react";
import {
  CARACTERISTICAS_PROPOSTA,
  isSituacaoCancelada,
  type EmissaoRow,
} from "@cadastro-lote/shared";
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
import { Progress } from "@/components/ui/progress";
import { Select } from "@/components/ui/select";
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
import { PipelineSteps, type EtapaPipeline } from "@/components/PipelineSteps";
import { ResumoOperacao, type ItemResumo } from "@/components/ResumoOperacao";
import { RateInput } from "@/components/ui/rate-input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  getLookups,
  parseEmissoes,
  startCalcular,
  startCriarPropostas,
  startVerificarClientes,
  streamCalculo,
  streamCriacao,
  streamVerificacao,
  type CalculoRowResult,
  type CriacaoRowResult,
  type LookupsResponse,
  type ParseEmissoesResult,
  type VerificacaoRowResult,
} from "@/lib/api";
import {
  exportCalculoCsv,
  exportCriacaoCsv,
  exportPendenciasCsv,
  type PendenciaRow,
} from "@/lib/export-csv";
import { formatBRL, formatCpf, formatDataAAAAMMDD } from "@/lib/format";
import { SessaoExpiradaError } from "@/lib/session";

type Phase = "idle" | "lendo" | "carregado" | "calculando" | "calculado" | "criando" | "criado";

/**
 * Parâmetros do lote que NÃO vêm do Excel (defaults do payload validado).
 * Guardados como string para validação inline; convertidos no envio.
 */
interface ParamsLote {
  txJuros: string;
  cdProd: string;
  idCarCtr: string;
  cdConven: string;
  cdLoja: string;
  /** ISO yyyy-mm-dd (input date); convertida para AAAAMMDD no envio. */
  dtContra: string;
}

const hojeIso = new Date().toISOString().slice(0, 10);

const PARAMS_DEFAULT: ParamsLote = {
  txJuros: "12",
  cdProd: "1015",
  idCarCtr: "31",
  cdConven: "111",
  cdLoja: "111",
  dtContra: hojeIso,
};

/** Validação inline: numéricos obrigatórios; data obrigatória; Loja pode ficar vazia. */
function paramInvalido(campo: keyof ParamsLote, valor: string): string | null {
  if (!valor.trim()) {
    // Loja (filial) é opcional — a proposta pode ir sem cdLoja.
    return campo === "cdLoja" ? null : "Obrigatório.";
  }
  if (campo === "dtContra") {
    return /^\d{4}-\d{2}-\d{2}$/.test(valor) ? null : "Data inválida.";
  }
  if (campo !== "cdConven" && !/^\d+([.,]\d+)?$/.test(valor.trim())) return "Somente números.";
  return null;
}

const isoParaAAAAMMDD = (iso: string) => Number(iso.replace(/-/g, ""));

const isoParaBR = (iso: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : iso;

/** Rolagem suave que respeita prefers-reduced-motion (ver DESIGN.md › Movimento). */
function rolarAte(el: HTMLElement | null) {
  el?.scrollIntoView({
    behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    block: "start",
  });
}

/**
 * Data-base sugerida para o contrato: 1 mês ANTES do 1º vencimento mais comum
 * da planilha. Confirmado empiricamente: com essa data o cálculo da Sinqia
 * reproduz a parcela do Excel no centavo. Editável — na criação real o
 * operador pode usar a data efetiva de emissão.
 */
function sugerirDtContra(rows: EmissaoRow[]): string | null {
  const contagem = new Map<number, number>();
  for (const r of rows) {
    if (r.dtVct1Ap) contagem.set(r.dtVct1Ap, (contagem.get(r.dtVct1Ap) ?? 0) + 1);
  }
  const modal = [...contagem.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!modal) return null;
  const ano = Math.floor(modal / 10_000);
  const mes = Math.floor((modal % 10_000) / 100);
  const dia = modal % 100;
  // Mês anterior, com clamp do dia (evita 31 → overflow de mês em JS).
  const anoAnt = mes === 1 ? ano - 1 : ano;
  const mesAnt = mes === 1 ? 12 : mes - 1;
  const ultimoDia = new Date(anoAnt, mesAnt, 0).getDate();
  const d = Math.min(dia, ultimoDia);
  return `${anoAnt}-${String(mesAnt).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function PropostasLote() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [base, setBase] = useState<ParseEmissoesResult | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const [params, setParams] = useState<ParamsLote>(PARAMS_DEFAULT);

  /** Listas da Sinqia para os selects (produto/convênio/loja). null = não carregadas. */
  const [lookups, setLookups] = useState<LookupsResponse | null>(null);
  const [carregandoLookups, setCarregandoLookups] = useState(false);
  const [lookupsErro, setLookupsErro] = useState<string | null>(null);

  /** Carrega/recarrega as listas usando a característica e o convênio atuais. */
  async function carregarLookups(idCarctrAtual?: string, convenioAtual?: string) {
    if (carregandoLookups) return;
    setCarregandoLookups(true);
    setLookupsErro(null);
    try {
      const idCarctr = Number(idCarctrAtual ?? params.idCarCtr) || 31;
      const convenio = Number(convenioAtual ?? params.cdConven);
      const res = await getLookups(idCarctr, Number.isFinite(convenio) ? convenio : undefined);
      setLookups(res);
      if (res.avisos.length > 0) setLookupsErro(res.avisos.join(" "));
    } catch (e) {
      // Lookup é conveniência: mantém a última lista boa e avisa — nunca
      // descarta opções que já funcionavam nem falha em silêncio.
      if (!(e instanceof SessaoExpiradaError)) {
        setLookupsErro(`Não foi possível carregar as listas da Sinqia: ${(e as Error).message}`);
      }
    } finally {
      setCarregandoLookups(false);
    }
  }

  /** Popula os selects assim que a tela abre (a sessão já existe pós-login). */
  useEffect(() => {
    void carregarLookups();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- só na montagem
  }, []);

  /** Seleção por nº da linha — sobrevive a filtro/reupload não relacionado. */
  const [selecionadas, setSelecionadas] = useState<Set<number>>(new Set());
  /** Filtro por situação; null = todas. */
  const [filtroSituacao, setFiltroSituacao] = useState<string | null>(null);

  /** Verificação dos clientes na Sinqia (por linha). */
  const [verificacao, setVerificacao] = useState<Map<number, VerificacaoRowResult>>(new Map());
  const [verificando, setVerificando] = useState(false);
  const [verifProgress, setVerifProgress] = useState({ processed: 0, total: 0 });
  /**
   * Linhas cujo operador ADOTOU o nrClient verificado na Sinqia (linha → nº).
   * A planilha traz o código de outro ambiente; adotar o verificado é o que
   * permite seguir para o cálculo/criação com o número certo.
   */
  const [adotados, setAdotados] = useState<Map<number, number>>(new Map());

  /** Resultado do cálculo (Fase 2). */
  const [calcProgress, setCalcProgress] = useState({
    processed: 0,
    total: 0,
    success: 0,
    divergencia: 0,
    error: 0,
    naoEnviado: 0,
  });
  const [calcResults, setCalcResults] = useState<CalculoRowResult[]>([]);
  const [calcJobId, setCalcJobId] = useState<string | null>(null);
  const [filtroCalc, setFiltroCalc] = useState<"all" | CalculoRowResult["status"]>("all");
  const [expandidas, setExpandidas] = useState<Set<number>>(new Set());

  /** Criação (Fase 3 — irreversível). */
  const [criarOpen, setCriarOpen] = useState(false);
  const [criarPiloto, setCriarPiloto] = useState(false);
  const [criarForcar, setCriarForcar] = useState(false);
  const [criarConfirmText, setCriarConfirmText] = useState("");
  const [criacaoProgress, setCriacaoProgress] = useState({
    processed: 0,
    total: 0,
    success: 0,
    jaExiste: 0,
    error: 0,
    naoEnviado: 0,
  });
  const [criacaoResults, setCriacaoResults] = useState<CriacaoRowResult[]>([]);
  const [criacaoExpandidas, setCriacaoExpandidas] = useState<Set<number>>(new Set());

  const fileInputRef = useRef<HTMLInputElement>(null);
  /** Rola até a grade de conferência/criação assim que o lote começa. */
  const calcCardRef = useRef<HTMLDivElement>(null);
  const criacaoCardRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (phase === "calculando") rolarAte(calcCardRef.current);
    if (phase === "criando") rolarAte(criacaoCardRef.current);
  }, [phase]);

  async function lerArquivo(file: File) {
    setError(null);
    setPhase("lendo");
    try {
      const res = await parseEmissoes(file);
      setBase(res);
      // Default de seleção: linhas sem problema e não canceladas.
      setSelecionadas(
        new Set(
          res.rows
            .filter((r) => r.erros.length === 0 && !isSituacaoCancelada(r.situacao))
            .map((r) => r.linha),
        ),
      );
      // Data-base sugerida a partir da própria planilha (1 mês antes do 1º vcto.).
      const sugerida = sugerirDtContra(res.rows);
      if (sugerida) setParams((p) => ({ ...p, dtContra: sugerida }));
      setFiltroSituacao(null);
      setCalcResults([]);
      setVerificacao(new Map());
      setAdotados(new Map());
      setPhase("carregado");
      // Aproveita para popular os selects de parâmetros (não bloqueia a tela).
      if (!lookups) void carregarLookups();
    } catch (e) {
      // Sessão expirada abre o modal de reautenticação — não vira erro de tela.
      if (!(e instanceof SessaoExpiradaError)) setError((e as Error).message);
      setPhase(base ? "carregado" : "idle");
    }
  }

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) void lerArquivo(f);
  };

  /** Linhas EFETIVAS: com o nrClient adotado da Sinqia aplicado por cima da planilha. */
  const rowsEfetivas = useMemo(() => {
    if (!base) return [];
    if (adotados.size === 0) return base.rows;
    return base.rows.map((r) =>
      adotados.has(r.linha) ? { ...r, nrClient: adotados.get(r.linha)! } : r,
    );
  }, [base, adotados]);

  const visiveis = useMemo(() => {
    return filtroSituacao === null
      ? rowsEfetivas
      : rowsEfetivas.filter((r) => r.situacao === filtroSituacao);
  }, [rowsEfetivas, filtroSituacao]);

  const selecionaveisVisiveis = useMemo(
    () => visiveis.filter((r) => r.erros.length === 0),
    [visiveis],
  );
  const todasVisiveisMarcadas =
    selecionaveisVisiveis.length > 0 &&
    selecionaveisVisiveis.every((r) => selecionadas.has(r.linha));

  const toggle = (linha: number) =>
    setSelecionadas((prev) => {
      const next = new Set(prev);
      next.has(linha) ? next.delete(linha) : next.add(linha);
      return next;
    });

  const marcarVisiveis = () =>
    setSelecionadas((prev) => {
      const next = new Set(prev);
      for (const r of selecionaveisVisiveis) next.add(r.linha);
      return next;
    });

  const desmarcarVisiveis = () =>
    setSelecionadas((prev) => {
      const next = new Set(prev);
      for (const r of visiveis) next.delete(r.linha);
      return next;
    });

  const comProblema = base ? base.rows.filter((r) => r.erros.length > 0).length : 0;
  const paramsErros = (Object.keys(params) as Array<keyof ParamsLote>)
    .map((k) => ({ campo: k, erro: paramInvalido(k, params[k]) }))
    .filter((p) => p.erro !== null);

  const busy = phase === "lendo" || phase === "calculando";
  const podeCalcular =
    !!base && selecionadas.size > 0 && paramsErros.length === 0 && !busy;

  async function calcular() {
    if (!base || !podeCalcular) return;
    // Usa as linhas EFETIVAS — nrClient adotado da Sinqia já aplicado.
    const rows = rowsEfetivas.filter(
      (r) => selecionadas.has(r.linha) && r.erros.length === 0,
    );
    setError(null);
    setCalcResults([]);
    setExpandidas(new Set());
    setFiltroCalc("all");
    setCalcProgress({
      processed: 0,
      total: rows.length,
      success: 0,
      divergencia: 0,
      error: 0,
      naoEnviado: 0,
    });
    setPhase("calculando");
    try {
      const { jobId, total } = await startCalcular(rows, {
        txJuros: Number(params.txJuros.replace(",", ".")),
        cdProd: Number(params.cdProd),
        idCarCtr: Number(params.idCarCtr),
        dtContra: isoParaAAAAMMDD(params.dtContra),
      });
      setCalcJobId(jobId);
      setCriacaoResults([]);
      setCalcProgress((p) => ({ ...p, total }));
      streamCalculo(jobId, {
        onSnapshot: (d) => {
          if (d.results.length) setCalcResults(d.results);
        },
        onRow: (row) => setCalcResults((prev) => [...prev, row]),
        onProgress: (p) =>
          setCalcProgress((prev) => ({
            ...prev,
            ...p,
            divergencia: p.divergencia ?? prev.divergencia,
            naoEnviado: p.naoEnviado ?? prev.naoEnviado,
          })),
        onSessaoExpirada: () => setPhase("calculado"),
        onFatal: (d) => {
          setError(`Erro no cálculo: ${d.message}`);
          setPhase("calculado");
        },
        onDone: () => setPhase("calculado"),
        onError: () => {
          /* fim de stream após done também dispara — o estado done já cobre */
        },
      });
    } catch (e) {
      if (!(e instanceof SessaoExpiradaError)) setError((e as Error).message);
      setPhase("carregado");
    }
  }

  /** Verifica na Sinqia (leitura) se cada cliente existe e se o nrClient bate. */
  async function verificarClientes() {
    if (!base || verificando) return;
    const alvos = rowsEfetivas
      .filter((r) => r.cpf.length === 11)
      .map((r) => ({ linha: r.linha, nome: r.nome, cpf: r.cpf, nrClient: r.nrClient }));
    if (alvos.length === 0) return;
    setError(null);
    setVerificando(true);
    setVerifProgress({ processed: 0, total: alvos.length });
    try {
      const { jobId } = await startVerificarClientes(alvos);
      streamVerificacao(jobId, {
        onSnapshot: (d) => {
          if (d.results.length) {
            setVerificacao(new Map(d.results.map((r) => [r.linha, r])));
            setVerifProgress({ processed: d.processed, total: d.total });
          }
          if (d.done) setVerificando(false);
        },
        onRow: (row) =>
          setVerificacao((prev) => {
            const next = new Map(prev);
            next.set(row.linha, row);
            return next;
          }),
        onProgress: (p) => setVerifProgress({ processed: p.processed, total: p.total }),
        onSessaoExpirada: () => setVerificando(false),
        onDone: () => setVerificando(false),
        onError: () => {
          /* done cobre o encerramento */
        },
      });
    } catch (e) {
      if (!(e instanceof SessaoExpiradaError)) setError((e as Error).message);
      setVerificando(false);
    }
  }

  const verifContagem = useMemo(() => {
    let ok = 0;
    let diverge = 0;
    let naoEncontrado = 0;
    let erro = 0;
    for (const v of verificacao.values()) {
      // Divergência ADOTADA conta como ok — o operador já assumiu o nº da Sinqia.
      if (v.status === "ENCONTRADO" || (v.status === "DIVERGE" && adotados.has(v.linha))) ok++;
      else if (v.status === "DIVERGE") diverge++;
      else if (v.status === "NAO_ENCONTRADO") naoEncontrado++;
      else erro++;
    }
    return { ok, diverge, naoEncontrado, erro };
  }, [verificacao, adotados]);

  /** Divergências ainda não resolvidas (candidatas à adoção do nº da Sinqia). */
  const divergentesNaoAdotados = useMemo(
    () =>
      [...verificacao.values()].filter(
        (v) => v.status === "DIVERGE" && v.nrClientSinqia !== null && !adotados.has(v.linha),
      ),
    [verificacao, adotados],
  );

  /** Adota o nrClient da Sinqia para UMA linha divergente. */
  const adotarNrClient = (linha: number) => {
    const v = verificacao.get(linha);
    if (!v || v.nrClientSinqia === null) return;
    setAdotados((prev) => new Map(prev).set(linha, v.nrClientSinqia!));
  };

  /** Adota o nrClient da Sinqia para TODAS as divergentes de uma vez. */
  const adotarTodosDivergentes = () =>
    setAdotados((prev) => {
      const next = new Map(prev);
      for (const v of divergentesNaoAdotados) next.set(v.linha, v.nrClientSinqia!);
      return next;
    });

  /**
   * Relatório de pendências — tudo que impede uma linha de virar proposta:
   * (1) problemas de planilha, (2) cliente não encontrado/divergente na
   * Sinqia, (3) divergência ou erro de cálculo. Vai para quem corrige o Excel.
   */
  const pendencias = useMemo<PendenciaRow[]>(() => {
    if (!base) return [];
    const porLinha = new Map(rowsEfetivas.map((r) => [r.linha, r]));
    const lista: PendenciaRow[] = [];
    const push = (linha: number, origem: string, problema: string) => {
      const r = porLinha.get(linha);
      lista.push({
        linha,
        nome: r?.nome ?? "",
        cpf: r?.cpf ?? "",
        idSinqia: r?.idSinqia ?? "",
        situacao: r?.situacao ?? "",
        origem,
        problema,
      });
    };

    for (const r of base.rows) {
      if (r.erros.length > 0) push(r.linha, "Planilha (não selecionável)", r.erros.join(" | "));
    }
    for (const v of verificacao.values()) {
      // Divergência ADOTADA deixa de ser pendência — o nº da Sinqia foi assumido.
      if (v.status === "DIVERGE" && adotados.has(v.linha)) continue;
      if (v.status === "NAO_ENCONTRADO" || v.status === "DIVERGE" || v.status === "ERRO") {
        push(v.linha, "Cliente Sinqia", v.detail ?? v.status);
      }
    }
    for (const c of calcResults) {
      if (c.status === "DIVERGENCIA") {
        push(
          c.linha,
          "Cálculo — divergência",
          c.divergencias
            .map((d) => `${d.campo}: Excel ${d.excel} × calculado ${d.calculado}`)
            .join(" | "),
        );
      } else if (c.status === "ERRO") {
        push(c.linha, "Cálculo — erro", c.messages || c.detail || `HTTP ${c.httpStatus ?? "—"}`);
      }
    }
    return lista.sort((a, b) => a.linha - b.linha);
  }, [base, rowsEfetivas, verificacao, adotados, calcResults]);

  const calcVisiveis = useMemo(
    () =>
      filtroCalc === "all" ? calcResults : calcResults.filter((r) => r.status === filtroCalc),
    [calcResults, filtroCalc],
  );

  const calcPct =
    calcProgress.total > 0
      ? Math.round((calcProgress.processed / calcProgress.total) * 100)
      : 0;

  const toggleExpandida = (linha: number) =>
    setExpandidas((prev) => {
      const next = new Set(prev);
      next.has(linha) ? next.delete(linha) : next.add(linha);
      return next;
    });

  const linhasOK = useMemo(
    () => calcResults.filter((r) => r.status === "OK").map((r) => r.linha),
    [calcResults],
  );
  const conferidas = linhasOK.length;
  const somaFinanciadoOK = useMemo(
    () =>
      calcResults
        .filter((r) => r.status === "OK")
        .reduce((acc, r) => acc + (r.vlFinanciadoCalc ?? 0), 0),
    [calcResults],
  );

  const podeCriar =
    (phase === "calculado" || phase === "criado") && conferidas > 0 && !!calcJobId;
  const confirmacaoProdOk = !IS_PROD || criarConfirmText.trim().toUpperCase() === "CRIAR";

  /** Somas das linhas SELECIONADAS na planilha — alimentam o resumo vivo. */
  const somaSelecionadas = useMemo(() => {
    let financiado = 0;
    let liquido = 0;
    for (const r of rowsEfetivas) {
      if (!selecionadas.has(r.linha)) continue;
      financiado += r.vlFinanciado ?? 0;
      liquido += r.vlLiquido ?? 0;
    }
    return { financiado, liquido };
  }, [rowsEfetivas, selecionadas]);

  /** Etapas do fluxo para o indicador passivo (não trava navegação). */
  const etapas: EtapaPipeline[] = [
    { id: "carregar", label: "Carregar planilha", estado: base ? "concluida" : "ativa" },
    {
      id: "verificar",
      label: "Verificar clientes",
      estado: verificando ? "ativa" : verificacao.size > 0 ? "concluida" : "pendente",
    },
    {
      id: "calcular",
      label: "Calcular e conferir",
      estado:
        phase === "calculando"
          ? "ativa"
          : calcResults.length > 0 && phase !== "carregado"
            ? "concluida"
            : "pendente",
    },
    {
      id: "criar",
      label: "Criar propostas",
      estado: phase === "criando" ? "ativa" : phase === "criado" ? "concluida" : "pendente",
    },
  ];

  const produtoSelecionado = lookups?.produtos.find(
    (o) => String(o.codigo) === params.cdProd,
  )?.descricao;

  /** Dados-chave da operação para o resumo vivo (barra sticky). */
  const itensResumo: ItemResumo[] = [
    { rotulo: "Linhas selecionadas", valor: base ? `${selecionadas.size} de ${base.total}` : "—" },
    { rotulo: "Financiado (seleção)", valor: formatBRL(somaSelecionadas.financiado), forte: true },
    { rotulo: "Líquido (seleção)", valor: formatBRL(somaSelecionadas.liquido) },
    { rotulo: "Taxa", valor: params.txJuros ? `${params.txJuros}% a.m.` : "—" },
    {
      rotulo: "Produto",
      valor: (
        <span title={produtoSelecionado}>{params.cdProd || "—"}</span>
      ),
    },
    { rotulo: "Contrato", valor: isoParaBR(params.dtContra) },
  ];

  const statusResumo =
    verificacao.size > 0 || calcResults.length > 0 || criacaoResults.length > 0 ? (
      <span className="tabular-nums">
        {verificacao.size > 0 && (
          <>
            Clientes: <span className="text-success">{verifContagem.ok} ok</span>
            {verifContagem.diverge > 0 && (
              <span className="text-warning-foreground"> · {verifContagem.diverge} divergentes</span>
            )}
            {verifContagem.naoEncontrado > 0 && (
              <span className="text-destructive"> · {verifContagem.naoEncontrado} não cadastrados</span>
            )}
          </>
        )}
        {calcResults.length > 0 && (
          <>
            {verificacao.size > 0 && "   ·   "}
            Cálculo: <span className="text-success">{calcProgress.success} OK</span>
            {calcProgress.divergencia > 0 && (
              <span className="text-warning-foreground"> · {calcProgress.divergencia} divergências</span>
            )}
            {calcProgress.error > 0 && (
              <span className="text-destructive"> · {calcProgress.error} erros</span>
            )}
          </>
        )}
        {criacaoResults.length > 0 && (
          <>
            {"   ·   "}
            Criação: <span className="text-success">{criacaoProgress.success} criadas</span>
            {criacaoProgress.jaExiste > 0 && (
              <span className="text-warning-foreground"> · {criacaoProgress.jaExiste} já existiam</span>
            )}
            {criacaoProgress.error > 0 && (
              <span className="text-destructive"> · {criacaoProgress.error} erros</span>
            )}
          </>
        )}
      </span>
    ) : (
      "O cálculo só confere — nada é gravado na Sinqia até a criação."
    );

  /** CTA da fase atual — mora no resumo vivo, único lugar de ação primária. */
  const ctaResumo = (
    <>
      {(phase === "calculado" || phase === "criado") && (
        <Button variant="outline" onClick={() => void calcular()} disabled={!podeCalcular}>
          <Calculator className="h-4 w-4" />
          Recalcular
        </Button>
      )}
      {phase === "criando" ? (
        <Button disabled>
          <Loader2 className="h-4 w-4 animate-spin" />
          <span className="tabular-nums">
            Criando {criacaoProgress.processed}/{criacaoProgress.total}…
          </span>
        </Button>
      ) : phase === "calculando" ? (
        <Button disabled>
          <Loader2 className="h-4 w-4 animate-spin" />
          <span className="tabular-nums">
            Calculando {calcProgress.processed}/{calcProgress.total}…
          </span>
        </Button>
      ) : podeCriar ? (
        <Button
          onClick={() => {
            setCriarPiloto(false);
            setCriarForcar(false);
            setCriarConfirmText("");
            setCriarOpen(true);
          }}
          title="Cria as propostas na Sinqia — ação irreversível, com confirmação"
        >
          Criar propostas ({conferidas} OK)
        </Button>
      ) : (
        <Button onClick={() => void calcular()} disabled={!podeCalcular}>
          <Calculator className="h-4 w-4" />
          Calcular selecionadas
        </Button>
      )}
    </>
  );

  /** Dispara a criação (irreversível) das linhas OK do cálculo retido. */
  async function criarPropostas() {
    if (!calcJobId || linhasOK.length === 0) return;
    setCriarOpen(false);
    setCriarConfirmText("");
    setError(null);
    setCriacaoResults([]);
    setCriacaoProgress({
      processed: 0,
      total: criarPiloto ? 1 : linhasOK.length,
      success: 0,
      jaExiste: 0,
      error: 0,
      naoEnviado: 0,
    });
    setPhase("criando");
    try {
      const { jobId, total } = await startCriarPropostas({
        calcJobId,
        linhas: linhasOK,
        params: {
          txJuros: Number(params.txJuros.replace(",", ".")),
          cdProd: Number(params.cdProd),
          idCarCtr: Number(params.idCarCtr),
          cdConven: params.cdConven.trim(),
          // Loja vazia = proposta sem cdLoja (undefined some do JSON).
          cdLoja: params.cdLoja.trim() === "" ? undefined : Number(params.cdLoja),
          dtContra: isoParaAAAAMMDD(params.dtContra),
        },
        piloto: criarPiloto,
        forcarDuplicadas: criarForcar,
      });
      setCriacaoProgress((p) => ({ ...p, total }));
      streamCriacao(jobId, {
        onSnapshot: (d) => {
          if (d.results.length) setCriacaoResults(d.results);
        },
        onRow: (row) => setCriacaoResults((prev) => [...prev, row]),
        onProgress: (p) =>
          setCriacaoProgress((prev) => ({
            ...prev,
            ...p,
            jaExiste: p.jaExiste ?? prev.jaExiste,
            naoEnviado: p.naoEnviado ?? prev.naoEnviado,
          })),
        onSessaoExpirada: () => setPhase("criado"),
        onDone: () => setPhase("criado"),
      });
    } catch (e) {
      if (!(e instanceof SessaoExpiradaError)) setError((e as Error).message);
      setPhase("calculado");
    }
  }

  return (
    <div className="space-y-6">
      {/* Breadcrumb + título + etapas do fluxo */}
      <div className="space-y-4">
        <div>
          <div className="mb-3 text-caption text-muted-foreground">
            Esteira de Originação › Propostas › Lote de propostas
          </div>
          <h1 className="text-display text-foreground">Lote de Propostas</h1>
          <p className="mt-1 text-body text-muted-foreground">
            Carregue o Emissoes.xlsx, selecione as linhas, calcule e confira antes de
            criar. O cálculo (calcProsp) não grava nada na Sinqia.
          </p>
        </div>
        <PipelineSteps etapas={etapas} />
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-destructive bg-destructive/10 px-4 py-3 text-body text-destructive">
          <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* 1/3 upload + 2/3 parâmetros — o formulário precisa de mais respiro. */}
      <div className="grid gap-6 lg:grid-cols-3">
        {/* Upload */}
        <Card className="lg:col-span-1">
          <CardHeader>
            <CardTitle>Planilha de emissões</CardTitle>
            <CardDescription>
              Aceita <code>.xlsx</code> no formato do Emissoes (Nome, CPF, ID_Sinqia,
              valores, 1º vcto., Situação).
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div
              role="button"
              tabIndex={0}
              onClick={() => fileInputRef.current?.click()}
              onKeyDown={(e) => e.key === "Enter" && fileInputRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
              className={cn(
                "focus-ring flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-4 py-8 text-center transition-colors duration-150",
                dragOver ? "border-primary bg-accent" : "border-border hover:border-primary",
              )}
            >
              {phase === "lendo" ? (
                <>
                  <Loader2 className="h-8 w-8 animate-spin text-primary" />
                  <p className="text-body text-muted-foreground">Lendo a planilha…</p>
                </>
              ) : base ? (
                <>
                  <FileSpreadsheet className="h-8 w-8 text-primary" />
                  <div className="text-body">
                    <span className="font-medium">{base.arquivo}</span>
                    <span className="text-muted-foreground"> · {base.total} linhas</span>
                  </div>
                  <p className="text-caption text-muted-foreground">
                    Clique ou arraste para substituir
                  </p>
                </>
              ) : (
                <>
                  <FileSpreadsheet className="h-8 w-8 text-muted-foreground" />
                  <p className="text-body text-muted-foreground">
                    Arraste o Emissoes.xlsx aqui ou clique para selecionar
                  </p>
                </>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx,.xls"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void lerArquivo(f);
                  e.target.value = "";
                }}
              />
            </div>

            {base && base.avisos.length > 0 && (
              <ul className="mt-3 space-y-1">
                {base.avisos.map((a, i) => (
                  <li key={i} className="flex items-start gap-1.5 text-caption text-warning-foreground">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
                    {a}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* Parâmetros do lote (fora do Excel) */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <div className="flex items-start justify-between gap-2">
              <div>
                <CardTitle>Parâmetros do lote</CardTitle>
                <CardDescription>
                  Valem para todas as propostas deste lote — não vêm do Excel. Produto,
                  convênio e loja vêm das listas da Sinqia.
                </CardDescription>
                {lookupsErro && (
                  <p className="mt-1 flex items-start gap-1.5 text-caption text-warning-foreground">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
                    {lookupsErro} Os campos aceitam digitação livre enquanto isso.
                  </p>
                )}
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void carregarLookups()}
                disabled={carregandoLookups}
                title="Recarrega produtos/convênios/lojas da Sinqia"
              >
                {carregandoLookups ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  "Carregar listas"
                )}
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {/* Taxa de juros — campo financeiro com sufixo de unidade. */}
              <ParamInput
                campo="txJuros"
                label="Taxa de juros"
                sufixo="% a.m."
                params={params}
                setParams={setParams}
              />
              {/* Característica — domínio FIXO documentado no swagger (Principal.idCarctr).
                  Trocar recarrega os produtos dela; sem produtos = aviso. */}
              <ParamSelect
                campo="idCarCtr"
                label="Característica"
                params={params}
                setParams={setParams}
                options={CARACTERISTICAS_PROPOSTA.map((c) => ({
                  codigo: c.codigo,
                  descricao: c.label,
                }))}
                onChangeValue={(v) => void carregarLookups(v)}
                aviso={
                  lookups && lookups.produtos.length === 0
                    ? "Nenhum produto para esta característica/convênio neste ambiente."
                    : undefined
                }
              />
              <ParamSelect
                campo="cdProd"
                label="Produto (cdProd)"
                params={params}
                setParams={setParams}
                options={lookups?.produtos ?? []}
                permitirManual
                carregando={carregandoLookups}
              />
              <ParamSelect
                campo="cdConven"
                label="Convênio (cdConven)"
                params={params}
                setParams={setParams}
                options={lookups?.convenios ?? []}
                onChangeValue={(v) => void carregarLookups(undefined, v)}
                permitirManual
                carregando={carregandoLookups}
              />
              <ParamSelect
                campo="cdLoja"
                label="Loja (filial do convênio)"
                params={params}
                setParams={setParams}
                options={lookups?.filiais ?? []}
                permitirManual
                permitirVazio
                carregando={carregandoLookups}
              />
              <ParamInput
                campo="dtContra"
                label="Data do contrato"
                type="date"
                params={params}
                setParams={setParams}
              />
            </div>
            <p className="mt-3 text-caption text-muted-foreground">
              A data do contrato é sugerida como 1 mês antes do 1º vencimento da planilha
              — é a data-base que reproduz os valores do Excel. Convênio/loja e dados
              bancários são usados na criação (Fase 3).
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Grade de seleção */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle>Linhas do arquivo</CardTitle>
              <CardDescription>
                {base ? (
                  <>
                    <span className="font-medium text-foreground">{selecionadas.size}</span>{" "}
                    selecionada(s) de {base.total}
                    {comProblema > 0 && (
                      <span className="text-destructive">
                        {" "}
                        · {comProblema} com problema (não selecionáveis)
                      </span>
                    )}
                  </>
                ) : (
                  "Selecione quais linhas vão virar proposta."
                )}
              </CardDescription>
            </div>
            {base && (
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void verificarClientes()}
                  disabled={verificando || busy}
                  title="Consulta a Sinqia (somente leitura): o CPF existe? O nrClient bate com o ID_Sinqia?"
                >
                  {verificando ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <UserCheck className="h-4 w-4" />
                  )}
                  {verificando ? (
                    <span className="tabular-nums">
                      Verificando {verifProgress.processed}/{verifProgress.total}…
                    </span>
                  ) : (
                    "Verificar clientes"
                  )}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => exportPendenciasCsv(pendencias)}
                  disabled={pendencias.length === 0}
                  title="CSV com tudo que impede linhas de virarem proposta — para corrigir a planilha"
                >
                  <ClipboardList className="h-4 w-4" />
                  Exportar pendências ({pendencias.length})
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={todasVisiveisMarcadas ? desmarcarVisiveis : marcarVisiveis}
                  disabled={visiveis.length === 0 || busy}
                >
                  {todasVisiveisMarcadas ? "Desmarcar visíveis" : "Marcar visíveis"}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setSelecionadas(new Set())}
                  disabled={selecionadas.size === 0 || busy}
                >
                  Limpar seleção
                </Button>
              </div>
            )}
          </div>

          {/* Resumo da verificação de clientes */}
          {verificacao.size > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-muted-foreground">
              <span>
                Clientes na Sinqia:{" "}
                <span className="text-success">{verifContagem.ok} ok</span>
                {verifContagem.diverge > 0 && (
                  <span className="text-warning-foreground">
                    {" "}
                    · {verifContagem.diverge} com nrClient divergente
                  </span>
                )}
                {verifContagem.naoEncontrado > 0 && (
                  <span className="text-destructive">
                    {" "}
                    · {verifContagem.naoEncontrado} não cadastrados
                  </span>
                )}
                {verifContagem.erro > 0 && <> · {verifContagem.erro} com erro</>}
              </span>
              {divergentesNaoAdotados.length > 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-6 px-2 text-caption"
                  onClick={adotarTodosDivergentes}
                  title="Substitui o nrClient da planilha pelo verificado na Sinqia em todas as linhas divergentes"
                >
                  <UserCheck className="h-3 w-3" />
                  Usar nº da Sinqia nas {divergentesNaoAdotados.length} divergentes
                </Button>
              )}
              {adotados.size > 0 && (
                <span className="text-success">
                  {adotados.size} linha(s) usando o nº verificado da Sinqia.
                </span>
              )}
              {verifContagem.naoEncontrado > 0 && (
                <span>Não cadastrados precisam do módulo Clientes antes da criação.</span>
              )}
            </div>
          )}

          {/* Filtro por situação — chips com contagem */}
          {base && (
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setFiltroSituacao(null)}
                className={cn(
                  "focus-ring rounded-full border px-3 py-1 text-caption font-medium transition-colors duration-150",
                  filtroSituacao === null
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border text-muted-foreground hover:border-primary hover:text-foreground",
                )}
              >
                Todas · {base.total}
              </button>
              {base.porSituacao.map(([sit, count]) => (
                <button
                  key={sit}
                  type="button"
                  onClick={() => setFiltroSituacao(filtroSituacao === sit ? null : sit)}
                  className={cn(
                    "focus-ring rounded-full border px-3 py-1 text-caption font-medium transition-colors duration-150",
                    filtroSituacao === sit
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border text-muted-foreground hover:border-primary hover:text-foreground",
                    isSituacaoCancelada(sit) && filtroSituacao !== sit && "opacity-70",
                  )}
                >
                  {sit} · {count}
                </button>
              ))}
            </div>
          )}
        </CardHeader>
        <CardContent>
          {/* Estado vazio */}
          {!base && phase !== "lendo" && (
            <div className="flex flex-col items-center gap-2 py-12 text-center">
              <Inbox className="h-8 w-8 text-muted-foreground/60" />
              <p className="text-body text-muted-foreground">
                Nenhuma planilha carregada ainda.
              </p>
              <p className="text-caption text-muted-foreground">
                Carregue o Emissoes.xlsx acima para ver as linhas aqui.
              </p>
            </div>
          )}

          {/* Carregando — skeleton com a forma da grade que vai chegar */}
          {phase === "lendo" && !base && (
            <div className="space-y-2 py-2" role="status" aria-label="Lendo a planilha">
              <Skeleton className="h-9 w-full" />
              {Array.from({ length: 8 }, (_, i) => (
                <Skeleton key={i} className="h-8 w-full" />
              ))}
              <span className="sr-only">Lendo a planilha…</span>
            </div>
          )}

          {/* Filtro sem resultado */}
          {base && visiveis.length === 0 && (
            <div className="flex flex-col items-center gap-2 py-12 text-center">
              <SearchX className="h-8 w-8 text-muted-foreground/60" />
              <p className="text-body text-muted-foreground">
                Nenhuma linha na situação “{filtroSituacao}”.
              </p>
              <Button variant="outline" size="sm" onClick={() => setFiltroSituacao(null)}>
                Ver todas
              </Button>
            </div>
          )}

          {base && visiveis.length > 0 && (
            <Table scroll>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <span className="sr-only">Selecionar</span>
                  </TableHead>
                  <TableHead className="w-12">Linha</TableHead>
                  <TableHead>Nome</TableHead>
                  <TableHead>CPF</TableHead>
                  <TableHead className="text-right">ID Sinqia</TableHead>
                  <TableHead className="text-right">CCB</TableHead>
                  <TableHead className="text-right">Financiado</TableHead>
                  <TableHead className="text-right">Líquido</TableHead>
                  <TableHead className="text-right">Parc. inicial</TableHead>
                  <TableHead className="text-right">Qtd.</TableHead>
                  <TableHead className="text-right">1º vcto.</TableHead>
                  <TableHead>Situação</TableHead>
                  <TableHead>Cliente Sinqia</TableHead>
                  <TableHead>Problemas</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visiveis.map((r) => (
                  <LinhaEmissao
                    key={r.linha}
                    row={r}
                    marcada={selecionadas.has(r.linha)}
                    bloqueio={busy}
                    verif={verificacao.get(r.linha)}
                    adotado={adotados.has(r.linha)}
                    onAdotar={() => adotarNrClient(r.linha)}
                    onToggle={() => toggle(r.linha)}
                  />
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>


      {/* Resultado do cálculo + conferência (Fase 2) */}
      {(phase === "calculando" || phase === "calculado" || calcResults.length > 0) && (
        <Card ref={calcCardRef} className="scroll-mt-40">
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <CardTitle>
                  {phase === "calculando" ? "Calculando e conferindo…" : "Conferência do cálculo"}
                </CardTitle>
                <CardDescription className="tabular-nums">
                  {calcProgress.processed} / {calcProgress.total} calculadas ·{" "}
                  <span className="text-success">{calcProgress.success} OK</span> ·{" "}
                  <span className="text-warning-foreground">
                    {calcProgress.divergencia} divergência(s)
                  </span>{" "}
                  · <span className="text-destructive">{calcProgress.error} erro(s)</span>
                  {calcProgress.naoEnviado > 0 && (
                    <> · {calcProgress.naoEnviado} não enviada(s)</>
                  )}
                </CardDescription>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => exportCalculoCsv(calcResults)}
                disabled={calcResults.length === 0}
              >
                <Download className="h-4 w-4" />
                Exportar CSV
              </Button>
            </div>
            <Progress value={calcPct} className="mt-3" />
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap gap-2">
              {(
                [
                  ["all", "Todos"],
                  ["OK", "OK"],
                  ["DIVERGENCIA", "Divergência"],
                  ["ERRO", "Erro"],
                  ["NAO_ENVIADO", "Não enviado"],
                ] as Array<["all" | CalculoRowResult["status"], string]>
              ).map(([f, label]) => (
                <Button
                  key={f}
                  variant={filtroCalc === f ? "default" : "outline"}
                  size="sm"
                  onClick={() => setFiltroCalc(f)}
                >
                  {label}
                </Button>
              ))}
            </div>

            {calcVisiveis.length === 0 ? (
              <p className="py-8 text-center text-body text-muted-foreground">
                {calcResults.length === 0
                  ? "Aguardando os primeiros resultados…"
                  : "Nenhuma linha neste filtro."}
              </p>
            ) : (
              <Table scroll>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-12">Linha</TableHead>
                    <TableHead>Nome</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Parcela Excel</TableHead>
                    <TableHead className="text-right">Parcela calc.</TableHead>
                    <TableHead className="text-right">Financiado Excel</TableHead>
                    <TableHead className="text-right">Financiado calc.</TableHead>
                    <TableHead className="text-right">Líquido calc.</TableHead>
                    <TableHead className="text-right">CET mês</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                    <TableHead>Revisão</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {calcVisiveis.map((r) => {
                    const aberta = expandidas.has(r.linha);
                    return (
                      <Fragment key={r.linha}>
                        <TableRow>
                          <TableCell className="tabular-nums text-muted-foreground">
                            {r.linha}
                          </TableCell>
                          <TableCell className="max-w-44 truncate font-medium" title={r.nome}>
                            {r.nome || "—"}
                          </TableCell>
                          <TableCell>
                            <StatusCalcBadge status={r.status} />
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatBRL(r.vlPrestaExcel)}
                          </TableCell>
                          <TableCell
                            className={cn(
                              "text-right tabular-nums",
                              r.status === "DIVERGENCIA" &&
                                r.divergencias.some((d) => d.campo === "Parcela") &&
                                "font-semibold text-warning-foreground",
                            )}
                          >
                            {formatBRL(r.vlPrestaCalc)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatBRL(r.vlFinanciadoExcel)}
                          </TableCell>
                          <TableCell
                            className={cn(
                              "text-right tabular-nums",
                              r.status === "DIVERGENCIA" &&
                                r.divergencias.some((d) => d.campo === "Financiado") &&
                                "font-semibold text-warning-foreground",
                            )}
                          >
                            {formatBRL(r.vlFinanciadoCalc)}
                          </TableCell>
                          <TableCell
                            className={cn(
                              "text-right tabular-nums",
                              r.status === "DIVERGENCIA" &&
                                r.divergencias.some((d) => d.campo === "Líquido") &&
                                "font-semibold text-warning-foreground",
                            )}
                          >
                            {formatBRL(r.vlLiquidCalc)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {r.txCetAm !== null ? `${r.txCetAm.toFixed(4)}%` : "—"}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatBRL(r.vlTotal)}
                          </TableCell>
                          <TableCell>
                            <button
                              type="button"
                              onClick={() => toggleExpandida(r.linha)}
                              className="focus-ring flex items-center gap-1 text-caption text-primary hover:underline"
                            >
                              {aberta ? (
                                <ChevronDown className="h-3 w-3" />
                              ) : (
                                <ChevronRight className="h-3 w-3" />
                              )}
                              {aberta ? "ocultar" : "revisar"}
                            </button>
                          </TableCell>
                        </TableRow>
                        {aberta && (
                          <TableRow>
                            <TableCell colSpan={11} className="bg-muted/40">
                              <DetalheCalculo r={r} />
                            </TableCell>
                          </TableRow>
                        )}
                      </Fragment>
                    );
                  })}
                </TableBody>
              </Table>
            )}

            {/* Contexto da criação — o CTA mora no resumo vivo, único ponto de ação */}
            {(phase === "calculado" || phase === "criando" || phase === "criado") && (
              <div className="rounded-lg border border-border bg-muted/30 p-4 text-body text-muted-foreground">
                {calcProgress.divergencia > 0 ? (
                  <span className="flex items-center gap-1.5 text-warning-foreground">
                    <AlertTriangle className="h-4 w-4 text-warning" />
                    {calcProgress.divergencia} divergência(s) ficarão de fora — a criação
                    usa apenas as linhas OK.
                  </span>
                ) : (
                  <span className="flex items-center gap-1.5 text-success">
                    <CheckCircle2 className="h-4 w-4" />
                    {conferidas} linha(s) conferida(s) e batendo com o Excel.
                  </span>
                )}
                {pendencias.length > 0 && (
                  <span className="mt-1 block text-caption">
                    Exporte as <strong>pendências ({pendencias.length})</strong> no botão da
                    grade acima e envie para quem corrige a planilha.
                  </span>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Resultado da CRIAÇÃO (Fase 3) */}
      {(phase === "criando" || phase === "criado" || criacaoResults.length > 0) && (
        <Card ref={criacaoCardRef} className="scroll-mt-40">
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <CardTitle>
                  {phase === "criando" ? "Criando propostas na Sinqia…" : "Resultado da criação"}
                </CardTitle>
                <CardDescription className="tabular-nums">
                  {criacaoProgress.processed} / {criacaoProgress.total} processadas ·{" "}
                  <span className="text-success">{criacaoProgress.success} criadas</span>
                  {criacaoProgress.jaExiste > 0 && (
                    <span className="text-warning-foreground">
                      {" "}
                      · {criacaoProgress.jaExiste} já existiam
                    </span>
                  )}{" "}
                  · <span className="text-destructive">{criacaoProgress.error} erro(s)</span>
                  {criacaoProgress.naoEnviado > 0 && (
                    <> · {criacaoProgress.naoEnviado} não enviada(s)</>
                  )}
                </CardDescription>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => exportCriacaoCsv(criacaoResults)}
                disabled={criacaoResults.length === 0}
              >
                <Download className="h-4 w-4" />
                Exportar relatório
              </Button>
            </div>
            <Progress
              value={
                criacaoProgress.total > 0
                  ? Math.round((criacaoProgress.processed / criacaoProgress.total) * 100)
                  : 0
              }
              className="mt-3"
            />
          </CardHeader>
          <CardContent>
            <Table scroll>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12">Linha</TableHead>
                  <TableHead>Nome</TableHead>
                  <TableHead>CPF</TableHead>
                  <TableHead className="text-right">nrClient</TableHead>
                  <TableHead className="text-right">Nº proposta</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>HTTP</TableHead>
                  <TableHead>Mensagens</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {criacaoResults.map((r) => {
                  const aberta = criacaoExpandidas.has(r.linha);
                  const mensagens = (r.messages || "")
                    .split(" ;; ")
                    .map((m) => m.trim())
                    .filter(Boolean);
                  return (
                    <Fragment key={r.linha}>
                      <TableRow>
                        <TableCell className="tabular-nums text-muted-foreground">{r.linha}</TableCell>
                        <TableCell className="max-w-44 truncate font-medium" title={r.nome}>
                          {r.nome || "—"}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-label tabular-nums">
                          {formatCpf(r.cpf)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{r.nrClient ?? "—"}</TableCell>
                        <TableCell className="text-right font-semibold tabular-nums">
                          {r.nrProsp ?? "—"}
                        </TableCell>
                        <TableCell>
                          {r.status === "JA_EXISTE" ? (
                            <Badge
                              className="border-transparent bg-warning text-warning-foreground"
                              title={r.detail}
                            >
                              Já existia
                            </Badge>
                          ) : (
                            <Badge
                              variant={
                                r.status === "OK"
                                  ? "success"
                                  : r.status === "NAO_ENVIADO"
                                    ? "secondary"
                                    : "destructive"
                              }
                            >
                              {r.status === "OK" ? "Criada" : r.status === "NAO_ENVIADO" ? "Não enviada" : "Erro"}
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell className="tabular-nums">{r.httpStatus ?? "—"}</TableCell>
                        <TableCell>
                          {mensagens.length > 0 || r.globalMessage || r.detail ? (
                            <button
                              type="button"
                              onClick={() =>
                                setCriacaoExpandidas((prev) => {
                                  const next = new Set(prev);
                                  next.has(r.linha) ? next.delete(r.linha) : next.add(r.linha);
                                  return next;
                                })
                              }
                              className="focus-ring flex items-center gap-1 text-caption text-primary hover:underline"
                            >
                              {aberta ? (
                                <ChevronDown className="h-3 w-3" />
                              ) : (
                                <ChevronRight className="h-3 w-3" />
                              )}
                              {mensagens.length > 0
                                ? `${mensagens.length} mensagem(ns)`
                                : "detalhes"}
                            </button>
                          ) : (
                            <span className="text-caption text-muted-foreground">—</span>
                          )}
                        </TableCell>
                      </TableRow>
                      {aberta && (
                        <TableRow>
                          <TableCell colSpan={8} className="bg-muted/40">
                            <DetalheCriacao r={r} mensagens={mensagens} />
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  );
                })}
                {criacaoResults.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={8} className="py-8 text-center text-muted-foreground">
                      Aguardando os primeiros envios…
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Resumo vivo da operação — sempre à vista, carrega o CTA da fase */}
      {base && (
        <ResumoOperacao
          itens={itensResumo}
          status={statusResumo}
          alerta={
            paramsErros.length > 0
              ? "Corrija os parâmetros do lote antes de calcular."
              : null
          }
          cta={ctaResumo}
        />
      )}

      {/* Confirmação da criação — fricção deliberada: é irreversível */}
      <Dialog open={criarOpen} onOpenChange={setCriarOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className={cn("flex items-center gap-2", IS_PROD && "text-destructive")}>
              <AlertTriangle className={cn("h-5 w-5", IS_PROD ? "" : "text-warning")} />
              Criar propostas na Sinqia
            </DialogTitle>
            <DialogDescription>
              Você está prestes a criar{" "}
              <strong>{criarPiloto ? 1 : conferidas} proposta(s)</strong> em{" "}
              <strong>{IS_PROD ? "PRODUÇÃO" : "HOMOLOGAÇÃO"}</strong>, total financiado de{" "}
              <strong className="tabular-nums">{formatBRL(somaFinanciadoOK)}</strong>. Esta
              ação é <strong>irreversível</strong> pela ferramenta.
            </DialogDescription>
          </DialogHeader>
          {/* Controles fora da description — descrição é descrição, formulário é formulário. */}
          <div className="space-y-3">
            <label className="flex items-center gap-2 text-body">
              <input
                type="checkbox"
                className="focus-ring h-4 w-4 accent-[var(--primary)]"
                checked={criarPiloto}
                onChange={(e) => setCriarPiloto(e.target.checked)}
              />
              <span>
                Piloto: criar <strong>somente a 1ª linha</strong> e conferir na Sinqia antes
                das demais
              </span>
            </label>
            <p className="text-caption text-muted-foreground">
              Cada cliente é verificado antes do envio: se já existir proposta{" "}
              <strong>idêntica</strong> (produto, parcelas, valores e 1º vencimento),
              a linha é pulada como “Já existia”.
            </p>
            <label className="flex items-center gap-2 text-body">
              <input
                type="checkbox"
                className="focus-ring h-4 w-4 accent-[var(--destructive)]"
                checked={criarForcar}
                onChange={(e) => setCriarForcar(e.target.checked)}
              />
              <span>
                Criar <strong>mesmo se já existir</strong> proposta idêntica
                <span className="text-muted-foreground"> (só para reemissão consciente)</span>
              </span>
            </label>
            {IS_PROD && (
              <div className="space-y-1">
                <Label htmlFor="confirma-criar" className="text-caption">
                  Digite <strong>CRIAR</strong> para liberar:
                </Label>
                <Input
                  id="confirma-criar"
                  value={criarConfirmText}
                  onChange={(e) => setCriarConfirmText(e.target.value)}
                  placeholder="CRIAR"
                />
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCriarOpen(false)}>
              Cancelar
            </Button>
            <Button
              variant={IS_PROD ? "destructive" : "default"}
              onClick={() => void criarPropostas()}
              disabled={!confirmacaoProdOk}
            >
              {criarPiloto ? "Criar 1 proposta (piloto)" : `Criar ${conferidas} proposta(s)`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function StatusCalcBadge({ status }: { status: CalculoRowResult["status"] }) {
  switch (status) {
    case "OK":
      return <Badge variant="success">OK</Badge>;
    case "DIVERGENCIA":
      return (
        <Badge className="border-transparent bg-warning text-warning-foreground">
          Divergência
        </Badge>
      );
    case "NAO_ENVIADO":
      return <Badge variant="secondary">Não enviado</Badge>;
    default:
      return <Badge variant="destructive">Erro</Badge>;
  }
}

/** Revisão da linha: divergências campo a campo + request exato enviado. */
function DetalheCalculo({ r }: { r: CalculoRowResult }) {
  return (
    <div className="space-y-3 text-caption">
      <div className="grid gap-1">
        <span>
          <span className="font-semibold">CPF:</span>{" "}
          <span className="tabular-nums">{formatCpf(r.cpf)}</span>
          {"  ·  "}
          <span className="font-semibold">nrClient:</span>{" "}
          <span className="tabular-nums">{r.nrClient ?? "—"}</span>
          {"  ·  "}
          <span className="font-semibold">HTTP:</span> {r.httpStatus ?? "—"}
          {r.qtPrest !== null && (
            <>
              {"  ·  "}
              <span className="font-semibold">parcelas:</span>{" "}
              <span className="tabular-nums">{r.qtPrest}</span>
            </>
          )}
        </span>
        {r.detail && (
          <span className="text-destructive">
            <span className="font-semibold">detalhe:</span> {r.detail}
          </span>
        )}
        {r.messages && (
          <span>
            <span className="font-semibold">mensagens da Sinqia:</span> {r.messages}
          </span>
        )}
      </div>

      {r.divergencias.length > 0 && (
        <div>
          <span className="font-semibold text-warning-foreground">
            Divergências (Excel × calculado):
          </span>
          <ul className="mt-1 list-disc pl-5">
            {r.divergencias.map((d, i) => (
              <li key={i} className="tabular-nums">
                {d.campo}: {formatBRL(d.excel)} (Excel) × {formatBRL(d.calculado)} (calculado) — Δ{" "}
                {formatBRL(Math.abs(d.calculado - d.excel))}
              </li>
            ))}
          </ul>
        </div>
      )}

      <details>
        <summary className="focus-ring cursor-pointer font-semibold text-primary">
          Ver o request enviado ao calcProsp (o que será usado na proposta)
        </summary>
        <pre className="mt-2 max-h-64 overflow-auto rounded-md border border-border bg-card p-3 font-mono text-code">
          {JSON.stringify(r.request, null, 2)}
        </pre>
      </details>
    </div>
  );
}

/**
 * Detalhe expandido de uma linha da criação: globalMessage + todas as
 * mensagens da Sinqia, categorizadas por tipo (Sucesso verde, Consistência
 * âmbar, Erro vermelho). O nº da proposta vem na mensagem "Sucesso".
 */
function DetalheCriacao({ r, mensagens }: { r: CriacaoRowResult; mensagens: string[] }) {
  const tipoDe = (m: string) => (m.split(" | ")[0] ?? "").trim();
  const textoDe = (m: string) => m.split(" | ").slice(1).join(" | ").trim() || m;

  return (
    <div className="space-y-2 text-caption">
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {r.globalMessage && (
          <span>
            <span className="font-semibold">Retorno:</span> {r.globalMessage}
          </span>
        )}
        {r.envelopeStatus && (
          <span>
            <span className="font-semibold">Status:</span> {r.envelopeStatus}
          </span>
        )}
        {r.nrProsp && (
          <span>
            <span className="font-semibold">Nº proposta:</span>{" "}
            <span className="tabular-nums">{r.nrProsp}</span>
          </span>
        )}
      </div>
      {r.detail && (
        <p className={r.status === "JA_EXISTE" ? "text-warning-foreground" : "text-destructive"}>
          <span className="font-semibold">Detalhe:</span> {r.detail}
        </p>
      )}
      {mensagens.length > 0 && (
        <ul className="space-y-1">
          {mensagens.map((m, i) => {
            const tipo = tipoDe(m);
            const sucesso = /sucesso/i.test(tipo);
            const erro = /erro/i.test(tipo);
            return (
              <li key={i} className="flex items-start gap-1.5">
                {sucesso ? (
                  <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />
                ) : erro ? (
                  <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
                ) : (
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
                )}
                <span>
                  <span
                    className={cn(
                      "font-semibold",
                      sucesso ? "text-success" : erro ? "text-destructive" : "text-warning-foreground",
                    )}
                  >
                    {tipo}:
                  </span>{" "}
                  {sucesso && /^\d+$/.test(textoDe(m)) ? `proposta nº ${textoDe(m)}` : textoDe(m)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * Campo de parâmetro como texto livre. Valida em BLUR (touched) — não grita
 * erro enquanto o operador ainda digita; o bloqueio do CTA continua imediato.
 */
function ParamInput({
  campo,
  label,
  params,
  setParams,
  onBlur,
  aviso,
  sufixo,
  type,
}: {
  campo: keyof ParamsLote;
  label: string;
  params: ParamsLote;
  setParams: React.Dispatch<React.SetStateAction<ParamsLote>>;
  onBlur?: () => void;
  /** Aviso não-bloqueante (ex.: característica sem produtos na Sinqia). */
  aviso?: string;
  /** Sufixo de unidade dentro do campo (ex.: "% a.m.") — vira RateInput. */
  sufixo?: string;
  /** Tipo do input nativo (ex.: "date"). */
  type?: string;
}) {
  const [tocado, setTocado] = useState(false);
  const erro = paramInvalido(campo, params[campo]);
  const mostraErro = tocado ? erro : null;

  const comuns = {
    id: `param-${campo}`,
    value: params[campo],
    type,
    "aria-invalid": mostraErro ? true : undefined,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
      setParams((p) => ({ ...p, [campo]: e.target.value })),
    onBlur: () => {
      setTocado(true);
      onBlur?.();
    },
    className: cn(
      "tabular-nums",
      mostraErro && "border-destructive",
      !mostraErro && aviso && "border-warning",
    ),
  };

  return (
    <div className="space-y-1">
      <Label htmlFor={`param-${campo}`} className="text-caption">
        {label}
      </Label>
      {sufixo ? (
        <RateInput sufixo={sufixo} {...comuns} />
      ) : (
        <Input inputMode={type ? undefined : "decimal"} {...comuns} />
      )}
      {mostraErro && <p className="text-caption text-destructive">{mostraErro}</p>}
      {!mostraErro && aviso && (
        <p className="flex items-start gap-1 text-caption text-warning-foreground">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-warning" />
          {aviso}
        </p>
      )}
    </div>
  );
}

/**
 * Campo de parâmetro como SELECT populado pela Sinqia.
 * Sem opções carregadas (lookup indisponível), degrada para texto livre —
 * a ferramenta nunca fica travada por causa de uma lista.
 */
function ParamSelect({
  campo,
  label,
  params,
  setParams,
  options,
  onChangeValue,
  aviso,
  permitirManual = false,
  permitirVazio = false,
  carregando = false,
}: {
  campo: keyof ParamsLote;
  label: string;
  params: ParamsLote;
  setParams: React.Dispatch<React.SetStateAction<ParamsLote>>;
  options: Array<{ codigo: number; descricao: string }>;
  onChangeValue?: (novo: string) => void;
  /** Aviso não-bloqueante exibido sob o campo (ex.: característica sem produtos). */
  aviso?: string;
  /** Permite alternar para digitação manual (lookup pode não trazer o código). */
  permitirManual?: boolean;
  /** Inclui a opção "(vazia)" — o parâmetro é opcional. */
  permitirVazio?: boolean;
  /** true enquanto as listas da Sinqia carregam — mostra skeleton, não input. */
  carregando?: boolean;
}) {
  /** Modo manual: o operador digita o código que a lista não trouxe. */
  const [manual, setManual] = useState(false);

  if (carregando && options.length === 0 && !manual) {
    return (
      <div className="space-y-1">
        <Label htmlFor={`param-${campo}`} className="text-caption">
          {label}
        </Label>
        <Skeleton className="h-9 w-full" />
      </div>
    );
  }

  if (options.length === 0 || manual) {
    return (
      <div className="space-y-1">
        <ParamInput campo={campo} label={label} params={params} setParams={setParams} aviso={aviso} />
        {manual && options.length > 0 && (
          <button
            type="button"
            onClick={() => setManual(false)}
            className="focus-ring text-caption text-primary underline-offset-2 hover:underline"
          >
            ← escolher da lista
          </button>
        )}
      </div>
    );
  }

  const atual = params[campo];
  const atualNaLista =
    options.some((o) => String(o.codigo) === atual) || (permitirVazio && atual === "");

  return (
    <div className="space-y-1">
      <Label htmlFor={`param-${campo}`} className="text-caption">
        {label}
      </Label>
      <Select
        id={`param-${campo}`}
        value={atual}
        onChange={(e) => {
          const novo = e.target.value;
          setParams((p) => ({ ...p, [campo]: novo }));
          onChangeValue?.(novo);
        }}
        className={cn("tabular-nums", aviso && "border-warning")}
      >
        {permitirVazio && <option value="">— (vazia) —</option>}
        {!atualNaLista && (
          <option value={atual}>{atual} — (valor atual, fora da lista)</option>
        )}
        {options.map((o) => (
          <option key={o.codigo} value={String(o.codigo)}>
            {o.codigo} — {o.descricao}
          </option>
        ))}
      </Select>
      {permitirManual && (
        <button
          type="button"
          onClick={() => setManual(true)}
          title="Use quando a lista da Sinqia não trouxer o código que você precisa"
          className="focus-ring text-caption text-primary underline-offset-2 hover:underline"
        >
          digitar código manualmente
        </button>
      )}
      {aviso && (
        <p className="flex items-start gap-1 text-caption text-warning-foreground">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-warning" />
          {aviso}
        </p>
      )}
    </div>
  );
}

/** Badge do resultado da verificação do cliente na Sinqia (+ ação de adoção). */
function ClienteSinqiaBadge({
  verif,
  adotado,
  onAdotar,
}: {
  verif: VerificacaoRowResult | undefined;
  adotado: boolean;
  onAdotar: () => void;
}) {
  if (!verif) return <span className="text-caption text-muted-foreground">—</span>;

  // Divergência resolvida: o operador adotou o nº verificado da Sinqia.
  if (verif.status === "DIVERGE" && adotado) {
    return (
      <Badge
        variant="success"
        title={`Usando o nº verificado da Sinqia (planilha dizia ${verif.nrClientPlanilha ?? "—"})`}
      >
        <Check className="h-3 w-3" aria-hidden />
        <span className="tabular-nums">{verif.nrClientSinqia}</span> · adotado
      </Badge>
    );
  }

  switch (verif.status) {
    case "ENCONTRADO":
      return (
        <Badge variant="success" title={`Sinqia: ${verif.nomeSinqia} (nrClient ${verif.nrClientSinqia})`}>
          <Check className="h-3 w-3" aria-hidden />
          <span className="tabular-nums">{verif.nrClientSinqia}</span>
        </Badge>
      );
    case "DIVERGE":
      return (
        <span className="flex flex-wrap items-center gap-1">
          <Badge
            className="border-transparent bg-warning text-warning-foreground"
            title={verif.detail}
          >
            difere: {verif.nrClientSinqia}
          </Badge>
          <button
            type="button"
            onClick={onAdotar}
            className="focus-ring text-caption font-medium text-primary underline-offset-2 hover:underline"
            title={`Substituir o nº da planilha (${verif.nrClientPlanilha ?? "—"}) pelo verificado na Sinqia (${verif.nrClientSinqia})`}
          >
            usar {verif.nrClientSinqia}
          </button>
        </span>
      );
    case "NAO_ENCONTRADO":
      return (
        <Badge variant="destructive" title={verif.detail}>
          não cadastrado
        </Badge>
      );
    case "NAO_ENVIADO":
      return <span className="text-caption text-muted-foreground">não verificado</span>;
    default:
      return (
        <Badge variant="destructive" title={verif.detail}>
          erro
        </Badge>
      );
  }
}

function LinhaEmissao({
  row,
  marcada,
  bloqueio,
  verif,
  adotado,
  onAdotar,
  onToggle,
}: {
  row: EmissaoRow;
  marcada: boolean;
  /** true enquanto lê/calcula — evita mudar a seleção no meio do lote. */
  bloqueio: boolean;
  verif: VerificacaoRowResult | undefined;
  /** true = usando o nrClient verificado da Sinqia (divergência resolvida). */
  adotado: boolean;
  onAdotar: () => void;
  onToggle: () => void;
}) {
  const bloqueada = row.erros.length > 0;
  const cancelada = isSituacaoCancelada(row.situacao);

  return (
    <TableRow className={cn(bloqueada && "opacity-60")}>
      <TableCell>
        <input
          type="checkbox"
          className="h-4 w-4 accent-[var(--primary)]"
          checked={marcada}
          disabled={bloqueada || bloqueio}
          onChange={onToggle}
          aria-label={`Selecionar linha ${row.linha} (${row.nome})`}
          title={bloqueada ? row.erros.join(" ") : undefined}
        />
      </TableCell>
      <TableCell className="tabular-nums text-muted-foreground">{row.linha}</TableCell>
      <TableCell className="max-w-52 truncate font-medium" title={row.nome}>
        {row.nome || "—"}
      </TableCell>
      <TableCell className="whitespace-nowrap text-label tabular-nums">
        {formatCpf(row.cpf)}
      </TableCell>
      <TableCell className="text-right tabular-nums" title={`nrClient extraído: ${row.nrClient ?? "—"}`}>
        {row.idSinqia || "—"}
      </TableCell>
      <TableCell className="text-right tabular-nums">{row.nrCcb || "—"}</TableCell>
      <TableCell className="text-right tabular-nums">{formatBRL(row.vlFinanciado)}</TableCell>
      <TableCell className="text-right tabular-nums">{formatBRL(row.vlLiquido)}</TableCell>
      <TableCell className="text-right tabular-nums">{formatBRL(row.vlParcelaInicial)}</TableCell>
      <TableCell className="text-right tabular-nums">{row.qtParcelas ?? "—"}</TableCell>
      <TableCell className="text-right tabular-nums">
        {formatDataAAAAMMDD(row.dtVct1Ap)}
      </TableCell>
      <TableCell>
        <Badge variant={cancelada ? "destructive" : "secondary"}>{row.situacao}</Badge>
      </TableCell>
      <TableCell>
        <ClienteSinqiaBadge verif={verif} adotado={adotado} onAdotar={onAdotar} />
      </TableCell>
      <TableCell>
        {bloqueada ? (
          <span
            className="flex items-center gap-1 text-caption text-destructive"
            title={row.erros.join("\n")}
          >
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            {row.erros.length === 1 ? row.erros[0] : `${row.erros.length} problemas`}
          </span>
        ) : row.avisos.length > 0 ? (
          <span
            className="flex items-center gap-1 text-caption text-warning-foreground"
            title={row.avisos.join("\n")}
          >
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-warning" />
            {row.avisos.length === 1 ? row.avisos[0] : `${row.avisos.length} avisos`}
          </span>
        ) : (
          <span className="text-caption text-muted-foreground">—</span>
        )}
      </TableCell>
    </TableRow>
  );
}
