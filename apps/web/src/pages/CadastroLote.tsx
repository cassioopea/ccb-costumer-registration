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
import { Label } from "@/components/ui/label";
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
  type BatchControlInput,
  type RowResult,
  type ValidateResponse,
} from "@/lib/api";
import { exportResultsCsv } from "@/lib/export-csv";

type Phase = "idle" | "validating" | "validated" | "importing" | "done";

export function CadastroLote() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const [control, setControl] = useState<BatchControlInput>({
    finalizar: false,
    idIntegracaoCadastro: "",
    idRetConsistencias: "",
  });

  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [validation, setValidation] = useState<ValidateResponse | null>(null);

  const [progress, setProgress] = useState({
    processed: 0,
    total: 0,
    success: 0,
    error: 0,
    skipped: 0,
  });
  const [results, setResults] = useState<RowResult[]>([]);
  const [filter, setFilter] = useState<"all" | "OK" | "ERRO" | "PULADO">("all");
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const canValidate = !!file && !!username && !!password && phase !== "validating" && phase !== "importing";
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
      setProgress({ processed: 0, total: 0, success: 0, error: 0, skipped: 0 });
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
      const res = await validate(file, username, password, sanitizeControl(control));
      setValidation(res);
      setPhase("validated");
    } catch (e) {
      setError((e as Error).message);
      setPhase("idle");
    }
  }

  function handleExecuteClick() {
    if (!canExecute) return;
    if (IS_PROD) setConfirmOpen(true);
    else void runImport();
  }

  async function runImport() {
    if (!file) return;
    setConfirmOpen(false);
    setError(null);
    setResults([]);
    setProgress({ processed: 0, total: validation?.total ?? 0, success: 0, error: 0, skipped: 0 });
    setPhase("importing");
    try {
      const { jobId, total } = await startImport(file, username, password, sanitizeControl(control));
      setProgress((p) => ({ ...p, total }));
      streamImport(jobId, {
        onRow: (row) => setResults((prev) => [...prev, row]),
        onProgress: (p) => setProgress(p),
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
      setError((e as Error).message);
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

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-[var(--destructive)] bg-[var(--destructive)]/10 px-4 py-3 text-sm text-[var(--destructive)]">
          <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Credenciais */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-[var(--primary)]" />
              Credenciais Sinqia
            </CardTitle>
            <CardDescription>
              Usadas apenas para o login. Trafegam somente nesta sessão — não são gravadas em
              disco, log ou código.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="username">Usuário</Label>
              <Input
                id="username"
                autoComplete="off"
                value={username}
                onChange={(e) => {
                  setUsername(e.target.value);
                  resetValidation();
                }}
                placeholder="usuário da Sinqia"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="password">Senha</Label>
              <Input
                id="password"
                type="password"
                autoComplete="off"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  resetValidation();
                }}
                placeholder="••••••••"
              />
            </div>
          </CardContent>
        </Card>

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

            {/* Controles do lote */}
            <div className="space-y-3 rounded-lg border border-[var(--border)] p-3">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-[var(--primary)]"
                  checked={control.finalizar}
                  onChange={(e) => {
                    setControl((c) => ({ ...c, finalizar: e.target.checked }));
                    resetValidation();
                  }}
                />
                <span className="font-medium">
                  Finalizar e enviar ao Motor de Crédito (<code>step="FI"</code>)
                </span>
              </label>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label htmlFor="idInt" className="text-xs">
                    idIntegracaoCadastro
                  </Label>
                  <Input
                    id="idInt"
                    placeholder='ex.: "N" (opcional)'
                    value={control.idIntegracaoCadastro}
                    onChange={(e) => {
                      setControl((c) => ({ ...c, idIntegracaoCadastro: e.target.value }));
                      resetValidation();
                    }}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="idRet" className="text-xs">
                    idRetConsistencias
                  </Label>
                  <Input
                    id="idRet"
                    placeholder="opcional"
                    value={control.idRetConsistencias}
                    onChange={(e) => {
                      setControl((c) => ({ ...c, idRetConsistencias: e.target.value }));
                      resetValidation();
                    }}
                  />
                </div>
              </div>
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
        <Button onClick={handleExecuteClick} disabled={!canExecute}>
          {phase === "importing" ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Play className="h-4 w-4" />
          )}
          Executar lote
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
              {(["all", "OK", "ERRO", "PULADO"] as const).map((f) => (
                <Button
                  key={f}
                  variant={filter === f ? "default" : "outline"}
                  size="sm"
                  onClick={() => setFilter(f)}
                >
                  {f === "all" ? "Todos" : f}
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
                                : r.status === "PULADO"
                                  ? "secondary"
                                  : "destructive"
                            }
                          >
                            {r.status}
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
              Confirmar cadastro em PRODUÇÃO
            </DialogTitle>
            <DialogDescription>
              Você está prestes a cadastrar <strong>{validCount}</strong> cliente(s) em{" "}
              <strong>PRODUÇÃO</strong>
              {skipCount > 0 ? ` (${skipCount} inválida(s) serão puladas)` : ""}. Esta ação é real e
              não pode ser desfeita pela ferramenta. Confirma?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              Cancelar
            </Button>
            <Button variant="destructive" onClick={() => void runImport()}>
              Confirmar e cadastrar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Remove strings vazias dos campos de controle opcionais. */
function sanitizeControl(c: BatchControlInput): BatchControlInput {
  return {
    finalizar: c.finalizar,
    ...(c.idIntegracaoCadastro ? { idIntegracaoCadastro: c.idIntegracaoCadastro } : {}),
    ...(c.idRetConsistencias ? { idRetConsistencias: c.idRetConsistencias } : {}),
  };
}
