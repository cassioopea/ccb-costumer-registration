import { Fragment, useCallback, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Download,
  FileText,
  Loader2,
  Play,
  ShieldCheck,
  Upload,
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
  startImport,
  streamImport,
  TEMPLATE_URL,
  validate,
  type IdAcao,
  type RowResult,
  type ValidateResponse,
} from "@/lib/api";
import { exportResultsCsv } from "@/lib/export-csv";
import { ControlesLote, sanitizeControl, useControlesLote } from "@/components/ControlesLote";
import {
  MARGEM_CURTA_MS,
  SessaoExpiradaError,
  formatarRestante,
  useRestante,
  useSession,
} from "@/lib/session";

type Phase = "idle" | "validating" | "validated" | "importing" | "done";

/** Verbo da ação escolhida, usado nos textos de confirmação. "" = inclusão. */
const ACAO_VERBO: Record<IdAcao | "", string> = {
  "": "cadastrar",
  IN: "cadastrar",
  AL: "alterar",
  EX: "EXCLUIR",
  CO: "consultar",
};

const ENV_LABEL = IS_PROD ? "PRODUÇÃO" : "HML";

export function CadastroLote() {
  const [file, setFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const { control, setControl } = useControlesLote();

  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [validation, setValidation] = useState<ValidateResponse | null>(null);

  const [progress, setProgress] = useState({
    processed: 0,
    total: 0,
    success: 0,
    error: 0,
    skipped: 0,
    naoEnviado: 0,
  });
  const [results, setResults] = useState<RowResult[]>([]);
  const [filter, setFilter] = useState<"all" | "OK" | "ERRO" | "PULADO" | "NAO_ENVIADO">("all");
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  /** Texto digitado para liberar a exclusão em lote (exige "EXCLUIR"). */
  const [confirmText, setConfirmText] = useState("");

  const fileInputRef = useRef<HTMLInputElement>(null);

  /**
   * Sessão perto de expirar. Importa porque não há renovação automática: um
   * lote longo iniciado agora pode ser interrompido no meio.
   */
  const { session } = useSession();
  const restanteSessao = useRestante(session);
  const sessaoCurta = restanteSessao > 0 && restanteSessao < MARGEM_CURTA_MS;

  const canValidate = !!file && phase !== "validating" && phase !== "importing";
  const validCount = validation ? validation.total - validation.totalErros : 0;
  const skipCount = validation?.totalErros ?? 0;
  // Executa se houver ao menos uma linha válida (as inválidas são puladas).
  const canExecute = phase === "validated" && validCount > 0;

  /** Qualquer mudança em credenciais/arquivo invalida a validação anterior. */
  const resetValidation = useCallback(() => {
    if (phase === "validated" || phase === "done") {
      setPhase("idle");
      setValidation(null);
      setResults([]);
      setProgress({ processed: 0, total: 0, success: 0, error: 0, skipped: 0, naoEnviado: 0 });
    }
  }, [phase]);

  const pickFile = (f: File | null) => {
    setFile(f);
    setError(null);
    resetValidation();
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) pickFile(f);
  };

  async function handleValidate() {
    if (!file) return;
    setError(null);
    setPhase("validating");
    try {
      const res = await validate(file, sanitizeControl(control));
      setValidation(res);
      setPhase("validated");
    } catch (e) {
      // Sessão expirada já abre o modal de reautenticação — não vira erro na tela.
      if (!(e instanceof SessaoExpiradaError)) setError((e as Error).message);
      setPhase("idle");
    }
  }

  function handleExecuteClick() {
    if (!canExecute) return;
    // Exclusão confirma em qualquer ambiente — apagar cadastro não tem desfazer
    // nem em HML. Nos demais casos, só produção pede confirmação.
    if (IS_PROD || control.idAcao === "EX") {
      setConfirmText("");
      setConfirmOpen(true);
    } else {
      void runImport();
    }
  }

  async function runImport() {
    if (!file) return;
    setConfirmOpen(false);
    setError(null);
    setResults([]);
    setProgress({ processed: 0, total: validation?.total ?? 0, success: 0, error: 0, skipped: 0, naoEnviado: 0 });
    setPhase("importing");
    try {
      const { jobId, total } = await startImport(file, sanitizeControl(control));
      setProgress((p) => ({ ...p, total }));
      streamImport(jobId, {
        onRow: (row) => setResults((prev) => [...prev, row]),
        onProgress: (p) => setProgress({ ...p, naoEnviado: p.naoEnviado ?? 0 }),
        onSessaoExpirada: (d) => {
          // O job já marcou as linhas restantes como NAO_ENVIADO; aqui só
          // explicamos o que aconteceu. O modal de senha abre pela próxima
          // chamada autenticada.
          setError(
            `${d.message} As linhas concluídas estão no relatório; reexecute apenas as marcadas como NÃO ENVIADO.`,
          );
        },
        onFatal: (d) => {
          setError(`Erro no lote: ${d.message}`);
          setPhase("done");
        },
        onDone: () => setPhase("done"),
        onError: () => {
          setError("Conexão de progresso (SSE) caiu. Verifique o backend.");
        },
      });
    } catch (e) {
      if (!(e instanceof SessaoExpiradaError)) setError((e as Error).message);
      setPhase("idle");
    }
  }

  const filteredResults = useMemo(
    () => (filter === "all" ? results : results.filter((r) => r.status === filter)),
    [results, filter],
  );

  const pct =
    progress.total > 0 ? Math.round((progress.processed / progress.total) * 100) : 0;

  const toggleExpand = (i: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(i) ? next.delete(i) : next.add(i);
      return next;
    });

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-display font-semibold tracking-tight text-foreground">
          Cadastro em Lote de Clientes
        </h1>
        <p className="mt-1 text-label text-muted-foreground">
          Importe tomadores de CCB para a API Sinqia (BJ21M05). Requer VPN da Opea ativa.
        </p>
      </div>

      {IS_PROD && (
        <div className="flex items-center gap-2 rounded-lg border border-[var(--destructive)] bg-[var(--destructive)]/10 px-4 py-3 text-sm font-medium text-[var(--destructive)]">
          <AlertTriangle className="h-4 w-4" />
          Ambiente de PRODUÇÃO ativo — os cadastros serão reais.
        </div>
      )}

      {sessaoCurta && (
        <div className="flex items-start gap-2 rounded-lg border border-[var(--warning)] bg-[var(--warning)]/15 px-4 py-3 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            A sessão expira em <strong>{formatarRestante(restanteSessao)}</strong> e não há
            renovação automática. Um lote longo iniciado agora pode ser interrompido — as linhas
            restantes ficariam como <strong>NÃO ENVIADO</strong>. Saia e entre novamente antes de
            executar.
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
      <div className="grid gap-6">
        {/* Upload */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Upload className="h-4 w-4 text-[var(--primary)]" />
              Arquivo do lote
            </CardTitle>
            <CardDescription>
              Aceita <code>.csv</code> ou <code>.json</code>.{" "}
              <a href={TEMPLATE_URL} className="font-medium text-[var(--primary)] underline">
                Baixar template CSV
              </a>
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
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
                "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-4 py-8 text-center transition-colors",
                dragOver
                  ? "border-[var(--primary)] bg-[var(--accent)]"
                  : "border-[var(--border)] hover:border-[var(--primary)]",
              )}
            >
              <FileText className="h-8 w-8 text-[var(--muted-foreground)]" />
              {file ? (
                <div className="text-sm">
                  <span className="font-medium">{file.name}</span>
                  <span className="text-[var(--muted-foreground)]">
                    {" "}
                    ({(file.size / 1024).toFixed(1)} KB)
                  </span>
                </div>
              ) : (
                <p className="text-sm text-[var(--muted-foreground)]">
                  Arraste o arquivo aqui ou clique para selecionar
                </p>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,.json"
                className="hidden"
                onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
              />
            </div>

            {/* Controles do request — compartilhados com o cadastro individual. */}
            <div className="rounded-lg border border-[var(--border)] p-3">
              <ControlesLote
                control={control}
                setControl={setControl}
                onChange={resetValidation}
              />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Ações */}
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="outline" onClick={handleValidate} disabled={!canValidate}>
          {phase === "validating" ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <ShieldCheck className="h-4 w-4" />
          )}
          Validar (dry-run)
        </Button>
        <Button
          onClick={handleExecuteClick}
          disabled={!canExecute}
          variant={control.idAcao === "EX" ? "destructive" : "default"}
        >
          {phase === "importing" ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Play className="h-4 w-4" />
          )}
          {control.idAcao && control.idAcao !== "IN"
            ? `Executar lote (${control.idAcao} — ${ACAO_VERBO[control.idAcao]})`
            : "Executar lote"}
        </Button>

        {validation && (
          <span className="text-sm">
            {validCount > 0 ? (
              <span className="inline-flex items-center gap-1 text-[var(--success)]">
                <CheckCircle2 className="h-4 w-4" />
                {validCount} válida(s)
                {skipCount > 0 ? (
                  <span className="text-[var(--destructive)]">
                    {" "}
                    · {skipCount} serão puladas
                  </span>
                ) : null}{" "}
                — pronto para executar
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-[var(--destructive)]">
                <XCircle className="h-4 w-4" />
                Nenhuma linha válida — corrija o arquivo
              </span>
            )}
          </span>
        )}
      </div>

      {/* Erros de validação por linha */}
      {validation && !validation.valido && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {skipCount} linha(s) serão puladas
            </CardTitle>
            <CardDescription>
              Estas linhas têm erro e <strong>não serão enviadas</strong> à Sinqia. As válidas
              seguem normalmente. Corrija e valide de novo se quiser incluí-las.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="max-h-64 overflow-y-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-16">Linha</TableHead>
                    <TableHead>Nome</TableHead>
                    <TableHead>Documento</TableHead>
                    <TableHead>Erros</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {validation.rows
                    .filter((r) => r.errors.length > 0)
                    .map((r) => (
                      <TableRow key={r.index}>
                        <TableCell>{r.index}</TableCell>
                        <TableCell>{r.nome || "—"}</TableCell>
                        <TableCell className="font-mono text-xs">{r.documento || "—"}</TableCell>
                        <TableCell className="text-[var(--destructive)]">
                          <ul className="list-disc pl-4">
                            {r.errors.map((e, i) => (
                              <li key={i}>{e}</li>
                            ))}
                          </ul>
                        </TableCell>
                      </TableRow>
                    ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Progresso + resultados */}
      {(phase === "importing" || phase === "done") && (
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <CardTitle className="text-base">
                  {phase === "importing" ? "Processando lote…" : "Lote concluído"}
                </CardTitle>
                <CardDescription>
                  {progress.processed} / {progress.total} processados ·{" "}
                  <span className="text-[var(--success)]">{progress.success} OK</span> ·{" "}
                  <span className="text-[var(--destructive)]">{progress.error} erro(s)</span> ·{" "}
                  <span className="text-[var(--muted-foreground)]">{progress.skipped} pulada(s)</span>
                </CardDescription>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => exportResultsCsv(results)}
                  disabled={results.length === 0}
                >
                  <Download className="h-4 w-4" />
                  Exportar CSV
                </Button>
              </div>
            </div>
            <Progress value={pct} className="mt-3" />
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex gap-2">
              {(["all", "OK", "ERRO", "PULADO", "NAO_ENVIADO"] as const).map((f) => (
                <Button
                  key={f}
                  variant={filter === f ? "default" : "outline"}
                  size="sm"
                  onClick={() => setFilter(f)}
                >
                  {f === "all" ? "Todos" : f === "NAO_ENVIADO" ? "NÃO ENVIADO" : f}
                </Button>
              ))}
            </div>

            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-16">Linha</TableHead>
                  <TableHead>Nome</TableHead>
                  <TableHead>Documento</TableHead>
                  <TableHead>Tipo</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>HTTP</TableHead>
                  <TableHead>Envelope</TableHead>
                  <TableHead>Mensagens</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredResults.map((r) => {
                  const hasMsg = !!r.messages || !!r.globalMessage || !!r.detail;
                  const isOpen = expanded.has(r.index);
                  return (
                    <Fragment key={r.index}>
                      <TableRow>
                        <TableCell>{r.index}</TableCell>
                        <TableCell className="max-w-48 truncate">{r.nome || "—"}</TableCell>
                        <TableCell className="font-mono text-xs">{r.documento || "—"}</TableCell>
                        <TableCell>
                          <Badge variant="secondary">{r.tipo}</Badge>
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={
                              r.status === "OK"
                                ? "success"
                                : r.status === "PULADO" || r.status === "NAO_ENVIADO"
                                  ? "secondary"
                                  : "destructive"
                            }
                          >
                            {r.status === "NAO_ENVIADO" ? "NÃO ENVIADO" : r.status}
                          </Badge>
                        </TableCell>
                        <TableCell>{r.httpStatus ?? "—"}</TableCell>
                        <TableCell className="font-mono text-xs">
                          {r.envelopeStatus ?? "—"}
                        </TableCell>
                        <TableCell>
                          {hasMsg ? (
                            <button
                              onClick={() => toggleExpand(r.index)}
                              className="flex items-center gap-1 text-xs text-[var(--primary)] hover:underline"
                            >
                              {isOpen ? (
                                <ChevronDown className="h-3 w-3" />
                              ) : (
                                <ChevronRight className="h-3 w-3" />
                              )}
                              {isOpen ? "ocultar" : "ver"}
                            </button>
                          ) : (
                            "—"
                          )}
                        </TableCell>
                      </TableRow>
                      {isOpen && hasMsg && (
                        <TableRow>
                          <TableCell colSpan={8} className="bg-[var(--muted)]/40">
                            <div className="space-y-1 text-xs">
                              {r.globalMessage && (
                                <div>
                                  <span className="font-semibold">globalMessage:</span>{" "}
                                  {r.globalMessage}
                                </div>
                              )}
                              {r.detail && (
                                <div>
                                  <span className="font-semibold">detalhe:</span> {r.detail}
                                </div>
                              )}
                              {r.messages && (
                                <div>
                                  <span className="font-semibold">consistências:</span>
                                  <ul className="list-disc pl-4">
                                    {r.messages.split(" ;; ").map((m, i) => (
                                      <li key={i}>{m}</li>
                                    ))}
                                  </ul>
                                </div>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  );
                })}
                {filteredResults.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={8} className="py-8 text-center text-[var(--muted-foreground)]">
                      Nenhuma linha para este filtro.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Confirmação de produção */}
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-[var(--destructive)]">
              <AlertTriangle className="h-5 w-5" />
              Confirmar {ACAO_VERBO[control.idAcao]} em {ENV_LABEL}
            </DialogTitle>
            <DialogDescription>
              Você está prestes a <strong>{ACAO_VERBO[control.idAcao]}</strong>{" "}
              <strong>{validCount}</strong> cliente(s) em <strong>{ENV_LABEL}</strong>
              {skipCount > 0 ? ` (${skipCount} inválida(s) serão puladas)` : ""}. Esta ação é real e
              não pode ser desfeita pela ferramenta.
              {control.idAcao === "EX" && (
                <>
                  {" "}
                  Para confirmar a <strong>exclusão</strong>, digite <code>EXCLUIR</code> abaixo.
                </>
              )}
            </DialogDescription>
            {sessaoCurta && (
              <div className="mt-2 flex items-start gap-2 rounded-md border border-[var(--warning)] bg-[var(--warning)]/15 px-3 py-2 text-xs">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  A sessão expira em menos de 5 minutos e não há renovação automática. Um lote
                  longo pode ser interrompido no meio — as linhas restantes ficariam como{" "}
                  <strong>NÃO ENVIADO</strong>. Considere sair e entrar novamente antes.
                </span>
              </div>
            )}
          </DialogHeader>
          {control.idAcao === "EX" && (
            <Input
              autoFocus
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder="EXCLUIR"
              className="border-[var(--destructive)]"
            />
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              Cancelar
            </Button>
            <Button
              variant="destructive"
              disabled={control.idAcao === "EX" && confirmText.trim() !== "EXCLUIR"}
              onClick={() => void runImport()}
            >
              Confirmar e {ACAO_VERBO[control.idAcao]}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
