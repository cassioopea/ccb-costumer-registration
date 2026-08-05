import { useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Eraser,
  FileJson,
  ListChecks,
  Loader2,
  Play,
  ShieldCheck,
  Sparkles,
  UserPlus,
  XCircle,
} from "lucide-react";
import {
  camposVisiveis,
  EXEMPLO_PF,
  EXEMPLO_PJ,
  secoesVisiveis,
  tipoPorDocumento,
  type CampoForm,
  type SecaoId,
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
import { Select } from "@/components/ui/select";
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
import { cn } from "@/lib/utils";
import {
  cadastrarUm,
  getCamposObrigatorios,
  type CadastrarUmResponse,
  type CamposObrigatoriosResponse,
} from "@/lib/api";
import { SessaoExpiradaError } from "@/lib/session";
import { ControlesLote, sanitizeControl, useControlesLote } from "@/components/ControlesLote";

type Fase = "editando" | "validando" | "enviando";

export function CadastroIndividual() {
  /** Estado do formulário: mapa achatado, igual a uma linha de CSV. */
  const [campos, setCampos] = useState<Record<string, string>>({});
  const [fase, setFase] = useState<Fase>("editando");
  const [erro, setErro] = useState<string | null>(null);
  const [resultado, setResultado] = useState<CadastrarUmResponse | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [verPayload, setVerPayload] = useState(false);

  const { control, setControl } = useControlesLote();

  /** Campos obrigatórios segundo a Sinqia (consultarCamposObrigatorios). */
  const [obrig, setObrig] = useState<CamposObrigatoriosResponse | null>(null);
  const [obrigCarregando, setObrigCarregando] = useState(false);
  const [obrigErro, setObrigErro] = useState<string | null>(null);
  const [verBruto, setVerBruto] = useState(false);

  const obrigPaths = useMemo(() => new Set(obrig?.paths ?? []), [obrig]);

  async function consultarObrigatorios() {
    setObrigErro(null);
    setObrigCarregando(true);
    try {
      setObrig(await getCamposObrigatorios());
    } catch (e) {
      if (!(e instanceof SessaoExpiradaError)) setObrigErro((e as Error).message);
    } finally {
      setObrigCarregando(false);
    }
  }

  const tipo = tipoPorDocumento(campos.nrCpfCnpj ?? "");
  const secoes = useMemo(() => secoesVisiveis(tipo), [tipo]);
  const visiveis = useMemo(() => camposVisiveis(tipo), [tipo]);

  // Seções recolhíveis: começam abertas as principais.
  const [recolhidas, setRecolhidas] = useState<Set<SecaoId>>(
    () => new Set(secoesVisiveis("?").filter((s) => s.recolhida).map((s) => s.id)),
  );

  const busy = fase !== "editando";
  /** O documento é o único campo que o schema realmente exige. */
  const podeEnviar = tipo !== "?" && !busy;

  const setCampo = (path: string, valor: string) => {
    setCampos((prev) => {
      const next = { ...prev };
      if (valor === "") delete next[path];
      else next[path] = valor;
      return next;
    });
    // Qualquer edição invalida o resultado anterior.
    setResultado(null);
    setErro(null);
  };

  /**
   * Erros por caminho de campo.
   *
   * O backend devolve "dadosPf.idUniao: mensagem" (formato do zod), então dá
   * para casar com o `path` do campo e mostrar o erro embaixo dele.
   */
  const errosPorCampo = useMemo(() => {
    const mapa = new Map<string, string[]>();
    for (const e of resultado?.errors ?? []) {
      const idx = e.indexOf(":");
      const path = idx > 0 ? e.slice(0, idx).trim() : "";
      const msg = idx > 0 ? e.slice(idx + 1).trim() : e;
      const lista = mapa.get(path) ?? [];
      lista.push(msg);
      mapa.set(path, lista);
    }
    return mapa;
  }, [resultado]);

  /** Erros que não casaram com nenhum campo da tela. */
  const errosSoltos = useMemo(() => {
    const paths = new Set(visiveis.map((c) => c.path));
    return [...errosPorCampo.entries()]
      .filter(([p]) => !paths.has(p))
      .flatMap(([p, msgs]) => msgs.map((m) => (p ? `${p}: ${m}` : m)));
  }, [errosPorCampo, visiveis]);

  async function enviar(dryRun: boolean) {
    setErro(null);
    setResultado(null);
    setConfirmOpen(false);
    setFase(dryRun ? "validando" : "enviando");
    try {
      const res = await cadastrarUm(campos, sanitizeControl(control), dryRun);
      setResultado(res);
    } catch (e) {
      if (!(e instanceof SessaoExpiradaError)) setErro((e as Error).message);
    } finally {
      setFase("editando");
    }
  }

  function onCadastrarClick() {
    if (!podeEnviar) return;
    // Cadastro real em produção pede confirmação, como no lote.
    if (IS_PROD) setConfirmOpen(true);
    else void enviar(false);
  }

  const carregarExemplo = (qual: "PF" | "PJ") => {
    setCampos(qual === "PF" ? { ...EXEMPLO_PF } : { ...EXEMPLO_PJ });
    setResultado(null);
    setErro(null);
  };

  const limpar = () => {
    setCampos({});
    setResultado(null);
    setErro(null);
  };

  const toggleSecao = (id: SecaoId) =>
    setRecolhidas((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const preenchidos = Object.keys(campos).length;

  return (
    <div className="space-y-6">
      <div>
        <div className="mb-3 text-caption text-muted-foreground">
          Esteira de Originação › Clientes › Cadastro individual
        </div>
        <h1 className="text-display text-foreground">Cadastro individual</h1>
        <p className="mt-1 text-body text-muted-foreground">
          Cadastre um tomador preenchendo o formulário. Usa a mesma rota e a mesma validação do
          cadastro em lote.
        </p>
      </div>

      {IS_PROD && (
        <div className="flex items-center gap-2 rounded-lg border border-[var(--destructive)] bg-[var(--destructive)]/10 px-4 py-3 text-sm font-medium text-[var(--destructive)]">
          <AlertTriangle className="h-4 w-4" />
          Ambiente de PRODUÇÃO ativo — o cadastro será real.
        </div>
      )}

      {erro && (
        <div className="flex items-start gap-2 rounded-lg border border-[var(--destructive)] bg-[var(--destructive)]/10 px-4 py-3 text-sm text-[var(--destructive)]">
          <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{erro}</span>
        </div>
      )}

      {/* Cabeçalho de estado: tipo detectado + atalhos */}
      <Card>
        <CardContent className="flex flex-wrap items-center gap-3 py-4">
          <span className="text-sm">
            Tipo detectado:{" "}
            {tipo === "?" ? (
              <Badge variant="secondary">informe o documento</Badge>
            ) : (
              <Badge>{tipo}</Badge>
            )}
          </span>
          <span className="text-sm text-muted-foreground">
            {preenchidos} campo(s) preenchido(s)
          </span>
          <div className="ml-auto flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => carregarExemplo("PF")} disabled={busy}>
              <Sparkles className="h-4 w-4" />
              Exemplo PF
            </Button>
            <Button variant="outline" onClick={() => carregarExemplo("PJ")} disabled={busy}>
              <Sparkles className="h-4 w-4" />
              Exemplo PJ
            </Button>
            <Button variant="outline" onClick={limpar} disabled={busy || preenchidos === 0}>
              <Eraser className="h-4 w-4" />
              Limpar
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Consulta de obrigatórios + controles lado a lado — compactos. */}
      <div className="grid items-start gap-6 lg:grid-cols-2">
      {/* Campos obrigatórios da Sinqia */}
      <Card>
        <CardHeader>
          <CardTitle>Campos obrigatórios da Sinqia</CardTitle>
          <CardDescription>
            <code>GET consultarCamposObrigatorios</code> — somente leitura. Os campos retornados
            ficam marcados com <span className="text-[var(--destructive)]">*</span> no formulário.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="outline" onClick={() => void consultarObrigatorios()} disabled={obrigCarregando}>
              {obrigCarregando ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ListChecks className="h-4 w-4" />
              )}
              {obrig ? "Consultar novamente" : "Consultar campos obrigatórios"}
            </Button>
            {obrig && (
              <>
                <Badge variant={obrig.paths.length > 0 ? "default" : "secondary"}>
                  {obrig.paths.length} campo(s)
                </Badge>
                <span className="text-xs text-muted-foreground">
                  formato reconhecido: <code>{obrig.formato}</code> · HTTP {obrig.httpStatus}
                </span>
              </>
            )}
          </div>

          {obrigErro && (
            <div className="flex items-start gap-2 rounded-lg border border-[var(--destructive)] bg-[var(--destructive)]/10 px-3 py-2 text-xs text-[var(--destructive)]">
              <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{obrigErro}</span>
            </div>
          )}

          {obrig?.formato === "desconhecido" && (
            <div className="flex items-start gap-2 rounded-lg border border-[var(--warning)] bg-[var(--warning)]/15 px-3 py-2 text-xs">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                A resposta chegou, mas em um formato que não soubemos interpretar. Veja o JSON cru
                abaixo — com ele dá para mapear corretamente.
              </span>
            </div>
          )}

          {obrig?.formato === "modelo-cliente" && (
            <div className="flex items-start gap-2 rounded-lg border border-[var(--warning)] bg-[var(--warning)]/15 px-3 py-2 text-xs">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                A resposta veio no formato do <strong>modelo completo do cliente</strong>. Estamos
                assumindo que as chaves presentes são os campos exigidos — <strong>isso não está
                confirmado</strong>. Confira o JSON cru antes de confiar nas marcações.
              </span>
            </div>
          )}

          {obrig?.formato === "sem-registro" && (
            <p className="text-xs text-muted-foreground">
              A Sinqia respondeu HTTP 204 — nenhum campo obrigatório parametrizado.
            </p>
          )}

          {obrig?.paths.length ? (
            <div className="flex flex-wrap gap-1.5">
              {obrig.paths.map((p) => (
                <code
                  key={p}
                  className="rounded border border-[var(--border)] bg-[var(--muted)]/40 px-1.5 py-0.5 text-caption"
                >
                  {p}
                </code>
              ))}
            </div>
          ) : null}

          {obrig?.bruto !== undefined && obrig.bruto !== null && (
            <div>
              <Button variant="outline" onClick={() => setVerBruto((v) => !v)}>
                <FileJson className="h-4 w-4" />
                {verBruto ? "Ocultar" : "Ver"} resposta crua
              </Button>
              {verBruto && (
                <pre className="mt-3 max-h-96 overflow-auto rounded-lg bg-[var(--muted)]/40 p-3 text-xs">
                  {JSON.stringify(obrig.bruto, null, 2)}
                </pre>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Controles do lote (valem para o cadastro individual também) */}
      <Card>
        <CardHeader>
          <CardTitle>Controles do cadastro</CardTitle>
          <CardDescription>
            Mesmos campos de controle do lote — vão no nível raiz do request.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ControlesLote control={control} setControl={setControl} onChange={() => setResultado(null)} />
        </CardContent>
      </Card>
      </div>

      {/* Seções do formulário */}
      {secoes.map((secao) => {
        const doSecao = visiveis.filter((c) => c.secao === secao.id);
        if (doSecao.length === 0) return null;
        const fechada = recolhidas.has(secao.id);
        const errosNaSecao = doSecao.filter((c) => errosPorCampo.has(c.path)).length;

        return (
          <Card key={secao.id}>
            <CardHeader>
              <button
                type="button"
                onClick={() => toggleSecao(secao.id)}
                className="flex w-full items-center gap-2 text-left"
              >
                {fechada ? (
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                )}
                <div className="flex-1">
                  <CardTitle>{secao.titulo}</CardTitle>
                  {secao.descricao && <CardDescription>{secao.descricao}</CardDescription>}
                </div>
                {errosNaSecao > 0 && (
                  <Badge variant="destructive">{errosNaSecao} erro(s)</Badge>
                )}
              </button>
            </CardHeader>
            {!fechada && (
              <CardContent>
                <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                  {doSecao.map((campo) => (
                    <CampoInput
                      key={campo.path}
                      campo={campo}
                      valor={campos[campo.path] ?? ""}
                      erros={errosPorCampo.get(campo.path)}
                      exigidoPelaSinqia={obrigPaths.has(campo.path)}
                      disabled={busy}
                      onChange={(v) => setCampo(campo.path, v)}
                    />
                  ))}
                </div>
              </CardContent>
            )}
          </Card>
        );
      })}

      {/* Ações */}
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="outline" onClick={() => void enviar(true)} disabled={!podeEnviar}>
          {fase === "validando" ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <ShieldCheck className="h-4 w-4" />
          )}
          Validar (dry-run)
        </Button>
        <Button onClick={onCadastrarClick} disabled={!podeEnviar}>
          {fase === "enviando" ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <UserPlus className="h-4 w-4" />
          )}
          Cadastrar
        </Button>
        {tipo === "?" && (
          <span className="text-sm text-muted-foreground">
            Informe um CPF (11 dígitos) ou CNPJ (14) para habilitar.
          </span>
        )}
      </div>

      {/* Resultado */}
      {resultado && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              {!resultado.valido ? (
                <>
                  <XCircle className="h-5 w-5 text-[var(--destructive)]" />
                  Reprovado na validação
                </>
              ) : resultado.dryRun ? (
                <>
                  <CheckCircle2 className="h-5 w-5 text-[var(--success)]" />
                  Validado — nada foi enviado
                </>
              ) : resultado.status === "OK" ? (
                <>
                  <CheckCircle2 className="h-5 w-5 text-[var(--success)]" />
                  Cliente cadastrado
                </>
              ) : (
                <>
                  <XCircle className="h-5 w-5 text-[var(--destructive)]" />
                  Recusado pela Sinqia
                </>
              )}
            </CardTitle>
            <CardDescription>
              {resultado.dryRun
                ? "O payload abaixo é exatamente o que seria enviado."
                : resultado.valido
                  ? "O resultado vem da análise do envelope da Sinqia, não só do HTTP."
                  : "Corrija os campos marcados e valide novamente."}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {errosSoltos.length > 0 && (
              <div className="rounded-lg border border-[var(--destructive)] bg-[var(--destructive)]/10 px-3 py-2 text-[var(--destructive)]">
                <p className="font-medium">Erros fora dos campos da tela:</p>
                <ul className="mt-1 list-inside list-disc">
                  {errosSoltos.map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              </div>
            )}

            {resultado.valido && !resultado.dryRun && (
              <div className="grid gap-1">
                <Linha rotulo="HTTP" valor={resultado.httpStatus} />
                <Linha rotulo="Status do envelope" valor={resultado.envelopeStatus} />
                <Linha rotulo="globalMessage" valor={resultado.globalMessage} />
                <Linha rotulo="Mensagens" valor={resultado.messages} />
                <Linha rotulo="Detalhe" valor={resultado.detail} />
              </div>
            )}

            {resultado.payload !== undefined && (
              <div>
                <Button variant="outline" onClick={() => setVerPayload((v) => !v)}>
                  <FileJson className="h-4 w-4" />
                  {verPayload ? "Ocultar" : "Ver"} payload
                </Button>
                {verPayload && (
                  <pre className="mt-3 max-h-96 overflow-auto rounded-lg bg-[var(--muted)]/40 p-3 text-xs">
                    {JSON.stringify(resultado.payload, null, 2)}
                  </pre>
                )}
              </div>
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
              Confirmar cadastro em PRODUÇÃO
            </DialogTitle>
            <DialogDescription>
              Você está prestes a cadastrar <strong>{campos.dsNome || "este cliente"}</strong> (
              {campos.nrCpfCnpj}) em <strong>PRODUÇÃO</strong>. Esta ação é real e não pode ser
              desfeita pela ferramenta. Confirma?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              Cancelar
            </Button>
            <Button variant="destructive" onClick={() => void enviar(false)}>
              <Play className="h-4 w-4" />
              Confirmar e cadastrar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Linha({ rotulo, valor }: { rotulo: string; valor: unknown }) {
  if (valor === undefined || valor === null || valor === "") return null;
  return (
    <div className="flex gap-2">
      <span className="min-w-40 text-muted-foreground">{rotulo}</span>
      <span className="flex-1 break-words">{String(valor)}</span>
    </div>
  );
}

function CampoInput({
  campo,
  valor,
  erros,
  exigidoPelaSinqia,
  disabled,
  onChange,
}: {
  campo: CampoForm;
  valor: string;
  erros?: string[];
  /** Veio na resposta de consultarCamposObrigatorios. */
  exigidoPelaSinqia: boolean;
  disabled: boolean;
  onChange: (v: string) => void;
}) {
  const temErro = !!erros?.length;
  const id = `campo-${campo.path}`;
  // Vazio + exigido pela Sinqia = provável recusa; destaca sem bloquear, porque
  // quem decide de fato é a API.
  const faltando = exigidoPelaSinqia && valor.trim() === "";

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="flex items-center gap-1">
        {campo.label}
        {(campo.obrigatorio || exigidoPelaSinqia) && (
          <span
            className="text-[var(--destructive)]"
            title={
              campo.obrigatorio
                ? "Exigido pela validação local (documento)."
                : "Exigido pela Sinqia (consultarCamposObrigatorios)."
            }
          >
            *
          </span>
        )}
      </Label>

      {campo.tipo === "select" ? (
        <Select
          id={id}
          value={valor}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          className={cn(
            temErro && "border-[var(--destructive)]",
            !temErro && faltando && "border-[var(--warning)]",
          )}
        >
          <option value="">— não enviar —</option>
          {campo.opcoes?.map((o) => (
            <option key={o.valor} value={o.valor}>
              {o.label}
            </option>
          ))}
        </Select>
      ) : (
        <Input
          id={id}
          value={valor}
          disabled={disabled}
          placeholder={campo.placeholder}
          // Datas AAAAMMDD e códigos são texto: `type=number` atrapalharia
          // (spinner, zeros à esquerda, notação científica).
          inputMode={campo.tipo === "texto" ? undefined : "numeric"}
          onChange={(e) => onChange(e.target.value)}
          className={cn(
            temErro && "border-[var(--destructive)]",
            !temErro && faltando && "border-[var(--warning)]",
          )}
        />
      )}

      {temErro ? (
        <p className="text-caption text-[var(--destructive)]">{erros!.join(" · ")}</p>
      ) : faltando ? (
        <p className="text-caption">Obrigatório segundo a Sinqia.</p>
      ) : (
        campo.hint && <p className="text-caption text-muted-foreground">{campo.hint}</p>
      )}
      <p className="font-mono text-caption text-muted-foreground/60">{campo.path}</p>
    </div>
  );
}
