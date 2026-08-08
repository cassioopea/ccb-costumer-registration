import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Calculator,
  Check,
  Loader2,
  Search,
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
import { Hint } from "@/components/onboarding/Hint";
import { PipelineSteps, type EtapaPipeline } from "@/components/PipelineSteps";
import { ResumoOperacao, type ItemResumo } from "@/components/ResumoOperacao";
import {
  CamposParametros,
  PARAMS_DEFAULT,
  paramsErros,
  type ParamsLote,
} from "@/components/ParametrosProposta";
import { cn } from "@/lib/utils";
import {
  buscarClienteParaProposta,
  calcularUmaProposta,
  criarUmaProposta,
  getLookups,
  listarPropostasCliente,
  type CalcularUmaResponse,
  type ClienteBuscaResponse,
  type CriacaoRowResult,
  type LookupsResponse,
  type PropostaResumo,
} from "@/lib/api";
import { formatBRL, formatCpf, formatDataAAAAMMDD } from "@/lib/format";
import { SessaoExpiradaError } from "@/lib/session";

type Fase = "editando" | "calculando" | "calculado" | "criando" | "criado";

const isoParaAAAAMMDD = (iso: string) => Number(iso.replace(/-/g, ""));

/** "1.234,56" ou "1234.56" → número. Vírgula presente = decimal pt-BR. */
function numBr(s: string): number {
  const t = s.trim();
  if (!t) return NaN;
  return t.includes(",") ? Number(t.replace(/\./g, "").replace(",", ".")) : Number(t);
}

/** Dados da operação digitados (strings; convertidos no envio). */
interface DadosOperacao {
  vlLiquido: string;
  qtParcelas: string;
  /** ISO yyyy-mm-dd. */
  dtVct1Ap: string;
  vlTac: string;
  vlSeguro: string;
  vlOutros: string;
}

const DADOS_INICIAIS: DadosOperacao = {
  vlLiquido: "",
  qtParcelas: "12",
  dtVct1Ap: "",
  vlTac: "",
  vlSeguro: "",
  vlOutros: "",
};

/** Erro de validação de um campo da operação (null = ok). */
function dadoInvalido(campo: keyof DadosOperacao, valor: string): string | null {
  const vazio = valor.trim() === "";
  switch (campo) {
    case "vlLiquido":
      if (vazio) return "Obrigatório.";
      return numBr(valor) > 0 ? null : "Valor inválido.";
    case "qtParcelas": {
      if (vazio) return "Obrigatório.";
      const n = Number(valor);
      return Number.isInteger(n) && n > 0 ? null : "Inteiro positivo.";
    }
    case "dtVct1Ap":
      if (vazio) return "Obrigatório.";
      return /^\d{4}-\d{2}-\d{2}$/.test(valor) ? null : "Data inválida.";
    default:
      // Encargos são opcionais; preenchidos, precisam ser número >= 0.
      if (vazio) return null;
      return numBr(valor) >= 0 ? null : "Valor inválido.";
  }
}

export function PropostaIndividual({ onVoltar }: { onVoltar?: () => void }) {
  /* --- Passo 1: cliente --- */
  const [cpf, setCpf] = useState("");
  const [buscando, setBuscando] = useState(false);
  const [cliente, setCliente] = useState<ClienteBuscaResponse | null>(null);
  const [clienteErro, setClienteErro] = useState<string | null>(null);
  const [propostasExistentes, setPropostasExistentes] = useState<PropostaResumo[] | null>(null);

  /* --- Passo 2: dados + parâmetros --- */
  const [dados, setDadosRaw] = useState<DadosOperacao>(DADOS_INICIAIS);
  const [params, setParamsRaw] = useState<ParamsLote>(PARAMS_DEFAULT);
  const [lookups, setLookups] = useState<LookupsResponse | null>(null);
  const [carregandoLookups, setCarregandoLookups] = useState(false);
  const [lookupsErro, setLookupsErro] = useState<string | null>(null);

  /* --- Passos 3 e 4: cálculo retido no servidor e criação --- */
  const [fase, setFase] = useState<Fase>("editando");
  const [erro, setErro] = useState<string | null>(null);
  const [calc, setCalc] = useState<CalcularUmaResponse | null>(null);
  const [resultado, setResultado] = useState<CriacaoRowResult | null>(null);
  const [criarOpen, setCriarOpen] = useState(false);
  const [criarForcar, setCriarForcar] = useState(false);
  const [criarConfirmText, setCriarConfirmText] = useState("");
  const [verRequest, setVerRequest] = useState(false);

  /** Editar qualquer entrada invalida o cálculo retido — criar exige recalcular. */
  const invalidarCalculo = () => {
    setCalc(null);
    setResultado(null);
    setErro(null);
    setFase("editando");
  };
  const setDados: typeof setDadosRaw = (a) => {
    invalidarCalculo();
    setDadosRaw(a);
  };
  const setParams: typeof setParamsRaw = (a) => {
    invalidarCalculo();
    setParamsRaw(a);
  };

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
      if (!(e instanceof SessaoExpiradaError)) {
        setLookupsErro(`Não foi possível carregar as listas da Sinqia: ${(e as Error).message}`);
      }
    } finally {
      setCarregandoLookups(false);
    }
  }

  useEffect(() => {
    void carregarLookups();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- só na montagem
  }, []);

  const cpfDigits = cpf.replace(/\D/g, "");

  async function buscarCliente() {
    if (cpfDigits.length !== 11 || buscando) return;
    setBuscando(true);
    setClienteErro(null);
    setCliente(null);
    setPropostasExistentes(null);
    invalidarCalculo();
    try {
      const res = await buscarClienteParaProposta(cpfDigits);
      setCliente(res);
      if (res.encontrado) {
        // Propostas existentes: visibilidade de duplicidade ANTES de criar.
        try {
          const lista = await listarPropostasCliente(cpfDigits);
          setPropostasExistentes(lista.propostas);
        } catch {
          setPropostasExistentes(null); // consulta é conveniência, não bloqueia
        }
      }
    } catch (e) {
      if (!(e instanceof SessaoExpiradaError)) setClienteErro((e as Error).message);
    } finally {
      setBuscando(false);
    }
  }

  const dadosErros = useMemo(
    () =>
      (Object.keys(dados) as Array<keyof DadosOperacao>)
        .map((k) => ({ campo: k, erro: dadoInvalido(k, dados[k]) }))
        .filter((d) => d.erro !== null),
    [dados],
  );
  const errosParams = paramsErros(params);

  const clienteOk = !!cliente?.encontrado && cliente.nrClient !== null;
  const podeCalcular =
    clienteOk && dadosErros.length === 0 && errosParams.length === 0 && fase !== "calculando";

  async function calcular() {
    if (!podeCalcular || !cliente) return;
    setErro(null);
    setResultado(null);
    setFase("calculando");
    try {
      const res = await calcularUmaProposta({
        cpf: cpfDigits,
        nome: cliente.nome,
        dados: {
          vlLiquido: numBr(dados.vlLiquido),
          qtParcelas: Number(dados.qtParcelas),
          dtVct1Ap: isoParaAAAAMMDD(dados.dtVct1Ap),
          vlTac: dados.vlTac.trim() ? numBr(dados.vlTac) : undefined,
          vlSeguro: dados.vlSeguro.trim() ? numBr(dados.vlSeguro) : undefined,
          vlOutros: dados.vlOutros.trim() ? numBr(dados.vlOutros) : undefined,
        },
        params: {
          txJuros: numBr(params.txJuros),
          cdProd: Number(params.cdProd),
          idCarCtr: Number(params.idCarCtr),
          dtContra: isoParaAAAAMMDD(params.dtContra),
        },
      });
      setCalc(res);
      setFase("calculado");
    } catch (e) {
      if (!(e instanceof SessaoExpiradaError)) setErro((e as Error).message);
      setFase("editando");
    }
  }

  const confirmacaoProdOk = !IS_PROD || criarConfirmText.trim().toUpperCase() === "CRIAR";

  async function criar() {
    if (!calc) return;
    setCriarOpen(false);
    setCriarConfirmText("");
    setErro(null);
    setFase("criando");
    try {
      const res = await criarUmaProposta({
        calcId: calc.calcId,
        params: {
          txJuros: numBr(params.txJuros),
          cdProd: Number(params.cdProd),
          idCarCtr: Number(params.idCarCtr),
          cdConven: params.cdConven.trim(),
          cdLoja: params.cdLoja.trim() === "" ? undefined : Number(params.cdLoja),
          dtContra: isoParaAAAAMMDD(params.dtContra),
        },
        forcarDuplicada: criarForcar,
      });
      setResultado(res);
      setFase("criado");
    } catch (e) {
      if (!(e instanceof SessaoExpiradaError)) setErro((e as Error).message);
      setFase("calculado");
    }
  }

  /** Recomeça mantendo o cliente — próxima proposta do mesmo tomador. */
  const novaProposta = () => {
    setDadosRaw(DADOS_INICIAIS);
    invalidarCalculo();
  };

  const etapas: EtapaPipeline[] = [
    { id: "cliente", label: "Cliente", estado: clienteOk ? "concluida" : "ativa" },
    {
      id: "dados",
      label: "Dados da operação",
      estado: calc ? "concluida" : clienteOk ? "ativa" : "pendente",
    },
    {
      id: "calcular",
      label: "Calcular e conferir",
      estado: fase === "calculando" ? "ativa" : calc ? "concluida" : "pendente",
    },
    {
      id: "criar",
      label: "Criar proposta",
      estado:
        fase === "criando"
          ? "ativa"
          : resultado && (resultado.status === "OK" || resultado.status === "JA_EXISTE")
            ? "concluida"
            : "pendente",
    },
  ];

  const itensResumo: ItemResumo[] = [
    {
      rotulo: "Tomador",
      valor: cliente?.encontrado ? (
        <span className="inline-block max-w-48 truncate align-bottom" title={cliente.nome}>
          {cliente.nome || formatCpf(cpfDigits)}
        </span>
      ) : (
        "—"
      ),
    },
    { rotulo: "nrClient", valor: cliente?.nrClient ?? "—" },
    {
      rotulo: "Líquido",
      valor: dados.vlLiquido.trim() ? formatBRL(numBr(dados.vlLiquido)) : "—",
    },
    {
      rotulo: "Parcela calculada",
      valor: calc ? formatBRL(calc.resumo.vlPresta) : "—",
      forte: true,
    },
    { rotulo: "Financiado", valor: calc ? formatBRL(calc.resumo.vlFinanciado) : "—" },
    { rotulo: "Parcelas", valor: dados.qtParcelas || "—" },
  ];

  const statusResumo = resultado ? (
    <span>
      {resultado.status === "OK" ? (
        <span className="text-success">
          Proposta nº {resultado.nrProsp ?? "—"} criada na Sinqia.
        </span>
      ) : resultado.status === "JA_EXISTE" ? (
        <span className="text-warning-foreground">{resultado.detail}</span>
      ) : (
        <span className="text-destructive">Criação recusada — veja o resultado abaixo.</span>
      )}
    </span>
  ) : calc ? (
    "Cálculo conferido? A criação é irreversível."
  ) : (
    "O cálculo só confere — nada é gravado na Sinqia até a criação."
  );

  const alertaResumo = !clienteOk
    ? "Busque um cliente cadastrado para começar."
    : dadosErros.length > 0 || errosParams.length > 0
      ? "Preencha os dados da operação e os parâmetros."
      : null;

  const ctaResumo = (
    <>
      {calc && fase !== "criando" && (
        <Button variant="outline" onClick={() => void calcular()} disabled={!podeCalcular}>
          <Calculator className="h-4 w-4" />
          Recalcular
        </Button>
      )}
      {fase === "criado" && resultado?.status === "OK" ? (
        <Button onClick={novaProposta}>Nova proposta deste cliente</Button>
      ) : fase === "criando" ? (
        <Button disabled>
          <Loader2 className="h-4 w-4 animate-spin" />
          Criando proposta…
        </Button>
      ) : fase === "calculando" ? (
        <Button disabled>
          <Loader2 className="h-4 w-4 animate-spin" />
          Calculando…
        </Button>
      ) : calc ? (
        <Button
          onClick={() => {
            setCriarForcar(false);
            setCriarConfirmText("");
            setCriarOpen(true);
          }}
          title="Cria a proposta na Sinqia — ação irreversível, com confirmação"
        >
          Criar proposta
        </Button>
      ) : (
        <Button onClick={() => void calcular()} disabled={!podeCalcular}>
          <Calculator className="h-4 w-4" />
          Calcular proposta
        </Button>
      )}
    </>
  );

  return (
    <div className="space-y-6">
      {/* Breadcrumb + título + etapas do fluxo */}
      <div className="reveal space-y-4">
        <div>
          <Breadcrumb
            paginaPrincipal="Painel de propostas"
            onVoltar={onVoltar}
            atual="Proposta individual"
          />
          <h1 className="text-display text-foreground">Proposta individual</h1>
          <p className="mt-1 text-body text-muted-foreground">
            Busque o cliente, preencha a operação, calcule na Sinqia e confira antes de
            criar. Mesmo motor do lote: guarda de duplicidade e TAC incluídos.
          </p>
        </div>
        <PipelineSteps etapas={etapas} />
      </div>

      {erro && (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-body text-destructive">
          <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{erro}</span>
        </div>
      )}

      {/* 1/3 cliente + 2/3 parâmetros — mesmo layout das telas de lote. */}
      <div className="grid items-start gap-6 lg:grid-cols-3">
        {/* Cliente */}
        <Card className="reveal reveal-delay-1 lg:col-span-1" data-tour="individual-cliente">
          <CardHeader>
            <CardTitle>Tomador</CardTitle>
            <CardDescription>
              A busca por CPF é somente leitura e traz o nrClient do ambiente ativo.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-end gap-2">
              <div className="flex-1 space-y-1">
                <Label htmlFor="prop-cpf" className="text-caption">
                  CPF do tomador
                </Label>
                <Input
                  id="prop-cpf"
                  value={cpf}
                  inputMode="numeric"
                  placeholder="000.000.000-00"
                  className="tabular-nums"
                  onChange={(e) => setCpf(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && void buscarCliente()}
                />
              </div>
              <Button
                variant="outline"
                onClick={() => void buscarCliente()}
                disabled={cpfDigits.length !== 11 || buscando}
              >
                {buscando ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Search className="h-4 w-4" />
                )}
                Buscar
              </Button>
            </div>

            {clienteErro && <p className="text-caption text-destructive">{clienteErro}</p>}

            {cliente && !cliente.encontrado && (
              <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-caption text-destructive">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  CPF não cadastrado neste ambiente — cadastre o tomador antes (módulo
                  Tomadores).
                </span>
              </div>
            )}

            {clienteOk && cliente && (
              <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-3">
                <div className="flex items-center gap-2">
                  <Badge variant="success">
                    <Check className="h-3 w-3" aria-hidden />
                    <span className="tabular-nums">{cliente.nrClient}</span>
                  </Badge>
                  <span className="truncate text-body font-medium" title={cliente.nome}>
                    {cliente.nome || "—"}
                  </span>
                </div>
                <p className="text-caption text-muted-foreground tabular-nums">
                  {formatCpf(cpfDigits)}
                </p>
                {propostasExistentes !== null && (
                  <p className="text-caption text-muted-foreground">
                    {propostasExistentes.length === 0
                      ? "Nenhuma proposta existente para este cliente."
                      : `${propostasExistentes.length} proposta(s) existente(s):`}
                  </p>
                )}
                {propostasExistentes && propostasExistentes.length > 0 && (
                  <ul className="max-h-40 space-y-1 overflow-y-auto text-caption tabular-nums">
                    {propostasExistentes.map((p) => (
                      <li key={p.nrProp} className="flex flex-wrap gap-x-2">
                        <span className="font-medium">nº {p.nrProp}</span>
                        <span className="text-muted-foreground">
                          prod. {p.cdProd ?? "—"} · {p.qtPrest ?? "—"}x ·{" "}
                          {formatBRL(p.vlFinan)} · 1º vcto.{" "}
                          {formatDataAAAAMMDD(p.dtVct1ap)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Parâmetros — mesmos campos e listas do lote */}
        <Card className="reveal reveal-delay-2 lg:col-span-2">
          <CardHeader>
            <div className="flex items-start justify-between gap-2">
              <div>
                <CardTitle>Parâmetros da proposta</CardTitle>
                <CardDescription>
                  Produto, convênio e loja vêm das listas da Sinqia — os mesmos do lote.
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
            <CamposParametros
              params={params}
              setParams={setParams}
              lookups={lookups}
              carregando={carregandoLookups}
              onTrocaCaracteristica={(v) => void carregarLookups(v)}
              onTrocaConvenio={(v) => void carregarLookups(undefined, v)}
            />
          </CardContent>
        </Card>
      </div>

      {/* Dados da operação */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-1.5">
            Dados da operação
            <Hint id="dados_operacao" />
          </CardTitle>
          <CardDescription>
            O líquido é o valor que o tomador recebe (vlContra do cálculo); TAC, seguro e
            outros são financiados por cima dele.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <CampoOperacao
              campo="vlLiquido"
              label="Valor líquido (R$)"
              placeholder="0,00"
              dados={dados}
              setDados={setDados}
            />
            <CampoOperacao
              campo="qtParcelas"
              label="Qtd. de parcelas"
              placeholder="12"
              dados={dados}
              setDados={setDados}
            />
            <CampoOperacao
              campo="dtVct1Ap"
              label="1º vencimento"
              type="date"
              dados={dados}
              setDados={setDados}
            />
            <CampoOperacao
              campo="vlTac"
              label="TAC (R$, opcional)"
              placeholder="0,00"
              dados={dados}
              setDados={setDados}
            />
            <CampoOperacao
              campo="vlSeguro"
              label="Seguro (R$, opcional)"
              placeholder="0,00"
              dados={dados}
              setDados={setDados}
            />
            <CampoOperacao
              campo="vlOutros"
              label="Outros (R$, opcional)"
              placeholder="0,00"
              dados={dados}
              setDados={setDados}
            />
          </div>
          <p className="mt-3 text-caption text-muted-foreground">
            Sugestão: a data do contrato (nos parâmetros) 1 mês antes do 1º vencimento é a
            base que reproduz os valores de emissão.
          </p>
        </CardContent>
      </Card>

      {/* Resultado do cálculo — revisão antes da criação */}
      {calc && (
        <Card>
          <CardHeader>
            <CardTitle>Conferência do cálculo</CardTitle>
            <CardDescription>
              Calculado pela Sinqia (calcProsp) — nada foi gravado. Revise antes de criar.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-6">
              <ValorCalculado rotulo="Parcela" valor={formatBRL(calc.resumo.vlPresta)} forte />
              <ValorCalculado rotulo="Financiado" valor={formatBRL(calc.resumo.vlFinanciado)} />
              <ValorCalculado rotulo="Líquido" valor={formatBRL(calc.resumo.vlLiquid)} />
              <ValorCalculado rotulo="IOF" valor={formatBRL(calc.resumo.vlIof)} />
              <ValorCalculado rotulo="Total" valor={formatBRL(calc.resumo.vlTotal)} />
              <ValorCalculado
                rotulo="CET a.m."
                valor={calc.resumo.txCetAm !== null ? `${calc.resumo.txCetAm.toFixed(4)}%` : "—"}
              />
              <ValorCalculado rotulo="TAC" valor={formatBRL(calc.resumo.vlTac)} />
              <ValorCalculado rotulo="Taxa a.m." valor={`${calc.resumo.txAm.toFixed(4)}%`} />
              <ValorCalculado rotulo="Parcelas" valor={String(calc.resumo.qtPrest)} />
              <ValorCalculado
                rotulo="1º vencimento"
                valor={formatDataAAAAMMDD(calc.resumo.dtVct1ap)}
              />
              <ValorCalculado
                rotulo="Último vencimento"
                valor={formatDataAAAAMMDD(calc.resumo.dtVctult)}
              />
            </dl>

            {calc.messages && (
              <p className="text-caption text-muted-foreground">
                <span className="font-semibold">Mensagens da Sinqia:</span> {calc.messages}
              </p>
            )}

            <div>
              <button
                type="button"
                onClick={() => setVerRequest((v) => !v)}
                className="focus-ring text-caption font-semibold text-primary hover:underline"
              >
                {verRequest ? "Ocultar" : "Ver"} o request enviado ao calcProsp
              </button>
              {verRequest && (
                <pre className="mt-2 max-h-64 overflow-auto rounded-md border border-border bg-card p-3 font-mono text-code">
                  {JSON.stringify(calc.request, null, 2)}
                </pre>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Resultado da criação */}
      {resultado && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              {resultado.status === "OK" ? (
                <>
                  <Check className="h-5 w-5 text-success" />
                  Proposta criada
                </>
              ) : resultado.status === "JA_EXISTE" ? (
                <>
                  <AlertTriangle className="h-5 w-5 text-warning" />
                  Proposta idêntica já existia
                </>
              ) : (
                <>
                  <XCircle className="h-5 w-5 text-destructive" />
                  Criação recusada
                </>
              )}
            </CardTitle>
            <CardDescription>
              O resultado vem da análise do envelope da Sinqia, não só do HTTP.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-body">
            {resultado.nrProsp && (
              <p>
                <span className="text-muted-foreground">Nº da proposta:</span>{" "}
                <strong className="text-subheading tabular-nums">{resultado.nrProsp}</strong>
              </p>
            )}
            {resultado.detail && (
              <p
                className={cn(
                  resultado.status === "JA_EXISTE"
                    ? "text-warning-foreground"
                    : resultado.status === "OK"
                      ? "text-muted-foreground"
                      : "text-destructive",
                )}
              >
                {resultado.detail}
              </p>
            )}
            {resultado.messages && (
              <ul className="space-y-1 text-caption">
                {resultado.messages
                  .split(" ;; ")
                  .map((m) => m.trim())
                  .filter(Boolean)
                  .map((m, i) => (
                    <li key={i}>{m}</li>
                  ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}

      {/* Resumo vivo da operação — sempre à vista, carrega o CTA da fase */}
      <ResumoOperacao
        itens={itensResumo}
        status={statusResumo}
        alerta={alertaResumo}
        cta={ctaResumo}
      />

      {/* Confirmação da criação — fricção deliberada: é irreversível */}
      <Dialog open={criarOpen} onOpenChange={setCriarOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className={cn("flex items-center gap-2", IS_PROD && "text-destructive")}>
              <AlertTriangle className={cn("h-5 w-5", IS_PROD ? "" : "text-warning")} />
              Criar proposta na Sinqia
            </DialogTitle>
            <DialogDescription>
              Você está prestes a criar <strong>1 proposta</strong> para{" "}
              <strong>{cliente?.nome || formatCpf(cpfDigits)}</strong> em{" "}
              <strong>{IS_PROD ? "PRODUÇÃO" : "HOMOLOGAÇÃO"}</strong>: financiado de{" "}
              <strong className="tabular-nums">
                {formatBRL(calc?.resumo.vlFinanciado ?? null)}
              </strong>{" "}
              em <strong className="tabular-nums">{calc?.resumo.qtPrest}x</strong> de{" "}
              <strong className="tabular-nums">{formatBRL(calc?.resumo.vlPresta ?? null)}</strong>
              . Esta ação é <strong>irreversível</strong> pela ferramenta.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-caption text-muted-foreground">
              Se já existir proposta <strong>idêntica</strong> (produto, parcelas, valores e 1º
              vencimento), nada é criado — a proposta existente é apontada.
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
                <Label htmlFor="confirma-criar-uma" className="text-caption">
                  Digite <strong>CRIAR</strong> para liberar:
                </Label>
                <Input
                  id="confirma-criar-uma"
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
              onClick={() => void criar()}
              disabled={!confirmacaoProdOk}
            >
              Criar 1 proposta
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Campo da operação: valida em blur; monetários alinhados à direita. */
function CampoOperacao({
  campo,
  label,
  dados,
  setDados,
  placeholder,
  type,
}: {
  campo: keyof DadosOperacao;
  label: string;
  dados: DadosOperacao;
  setDados: React.Dispatch<React.SetStateAction<DadosOperacao>>;
  placeholder?: string;
  type?: string;
}) {
  const [tocado, setTocado] = useState(false);
  const erro = dadoInvalido(campo, dados[campo]);
  const mostraErro = tocado ? erro : null;
  const monetario = campo.startsWith("vl");

  return (
    <div className="space-y-1">
      <Label htmlFor={`op-${campo}`} className="text-caption">
        {label}
      </Label>
      <Input
        id={`op-${campo}`}
        value={dados[campo]}
        type={type}
        placeholder={placeholder}
        inputMode={type ? undefined : "decimal"}
        aria-invalid={mostraErro ? true : undefined}
        onChange={(e) => setDados((d) => ({ ...d, [campo]: e.target.value }))}
        onBlur={() => setTocado(true)}
        className={cn("tabular-nums", monetario && "text-right", mostraErro && "border-destructive")}
      />
      {mostraErro && <p className="text-caption text-destructive">{mostraErro}</p>}
    </div>
  );
}

/** Par rótulo/valor da conferência do cálculo. */
function ValorCalculado({
  rotulo,
  valor,
  forte = false,
}: {
  rotulo: string;
  valor: string;
  forte?: boolean;
}) {
  return (
    <div>
      <dt className="text-caption text-muted-foreground">{rotulo}</dt>
      <dd className={cn("tabular-nums", forte ? "text-subheading" : "text-body")}>{valor}</dd>
    </div>
  );
}
