import { Fragment, useCallback, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Download,
  ListChecks,
  Loader2,
  RefreshCw,
  Search,
  ShieldCheck,
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
  listarTodosClientes,
  startAlterarSituacao,
  streamSituacao,
  type ClienteResumo,
  type SituacaoRowResult,
  type TodosClientesResponse,
} from "@/lib/api";
import { exportSituacaoCsv } from "@/lib/export-csv";

type Phase = "idle" | "carregando" | "carregado" | "alterando" | "done";

/** Teto de linhas renderizadas. Filtrar é barato; desenhar 20 mil <tr> não é. */
const MAX_LINHAS_VISIVEIS = 200;

export function SituacaoClientes() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const [tipoPessoa, setTipoPessoa] = useState("");
  const [filtro, setFiltro] = useState("");

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

  const [progress, setProgress] = useState({ processed: 0, total: 0, success: 0, error: 0 });
  const [results, setResults] = useState<SituacaoRowResult[]>([]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [verSelecionados, setVerSelecionados] = useState(false);

  const temCredenciais = !!username && !!password;
  const busy = phase === "carregando" || phase === "alterando";
  const totalSelecionados = selecionados.size;
  const podeAlterar = totalSelecionados > 0 && temCredenciais && !busy;

  const carregar = useCallback(async () => {
    if (!temCredenciais) return;
    setError(null);
    setPhase("carregando");
    try {
      const res = await listarTodosClientes(username, password, tipoPessoa || undefined);
      setBase(res);
      setPhase("carregado");
    } catch (e) {
      setError((e as Error).message);
      setPhase("idle");
    }
  }, [username, password, tipoPessoa, temCredenciais]);

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
    setProgress({ processed: 0, total: totalSelecionados, success: 0, error: 0 });
    setPhase("alterando");

    const alvos = [...selecionados.values()].map((c) => ({
      nrCliente: c.nrCliente!,
      nome: c.nome,
      documento: c.documento,
      situacaoAnterior: c.dsSituacao || situacaoLabel(c.cdSituacao),
    }));

    try {
      const { jobId, total } = await startAlterarSituacao(username, password, cdSituacao, alvos);
      setProgress((p) => ({ ...p, total }));
      streamSituacao(jobId, {
        onRow: (row) => setResults((prev) => [...prev, row]),
        onProgress: (p) => setProgress(p),
        onFatal: (d) => {
          setError(`Erro na alteração: ${d.message}`);
          setPhase("done");
        },
        onDone: () => setPhase("done"),
        onError: () => setError("Conexão de progresso (SSE) caiu. Verifique o backend."),
      });
    } catch (e) {
      setError((e as Error).message);
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
          Situação de Clientes
        </h1>
        <p className="mt-1 text-label text-muted-foreground">
          Carregue os clientes cadastrados na Sinqia, filtre por número, nome ou CPF/CNPJ e altere
          a situação de um ou vários. Requer VPN da Opea ativa.
        </p>
      </div>

      {IS_PROD && (
        <div className="flex items-center gap-2 rounded-lg border border-[var(--destructive)] bg-[var(--destructive)]/10 px-4 py-3 text-sm font-medium text-[var(--destructive)]">
          <AlertTriangle className="h-4 w-4" />
          Ambiente de PRODUÇÃO ativo — as alterações de situação são reais.
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
              <Label htmlFor="sit-username">Usuário</Label>
              <Input
                id="sit-username"
                autoComplete="off"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="usuário da Sinqia"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sit-password">Senha</Label>
              <Input
                id="sit-password"
                type="password"
                autoComplete="off"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
              />
            </div>
          </CardContent>
        </Card>

        {/* Carga */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <RefreshCw className="h-4 w-4 text-[var(--primary)]" />
              Carregar clientes
            </CardTitle>
            <CardDescription>
              Traz a base inteira de uma vez (<code>GET /v1/cliente</code>, todas as páginas, um
              login só). Depois o filtro é local e instantâneo.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1">
              <Label htmlFor="sit-tipo" className="text-xs">
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

            <Button
              variant="outline"
              onClick={() => void carregar()}
              disabled={!temCredenciais || busy}
              className="w-full"
            >
              {phase === "carregando" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
              {base ? "Recarregar clientes" : "Carregar clientes"}
            </Button>

            {phase === "carregando" && (
              <p className="text-xs text-muted-foreground">
                Varrendo as páginas na Sinqia — numa base grande isso leva alguns segundos.
              </p>
            )}

            {base && (
              <p className="text-sm">
                <strong className="tabular-nums">{base.items.length}</strong> cliente(s)
                carregado(s) em {base.paginas} página(s)
                {base.totalElements !== null && base.totalElements !== base.items.length
                  ? ` — a Sinqia informa ${base.totalElements} no total`
                  : ""}
                .
              </p>
            )}

            {base?.truncado && (
              <div className="flex items-start gap-2 rounded-md border border-[var(--destructive)] bg-[var(--destructive)]/10 px-3 py-2 text-xs text-[var(--destructive)]">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  A carga bateu no teto de segurança do backend e <strong>pode estar
                  incompleta</strong>. Use o filtro de tipo de pessoa para reduzir o conjunto.
                </span>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Seleção + ação */}
      {base && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ListChecks className="h-4 w-4 text-[var(--primary)]" />
              Alterar situação
            </CardTitle>
            <CardDescription>
              A seleção <strong>não é perdida</strong> ao filtrar ou recarregar — vá juntando os
              clientes de várias buscas e altere todos de uma vez.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-[320px] flex-1 space-y-1">
                <Label htmlFor="sit-nova" className="text-xs">
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

      {/* Progresso */}
      {(phase === "alterando" || phase === "done") && progress.total > 0 && (
        <Card>
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
                        <Badge variant={r.status === "OK" ? "success" : "destructive"}>
                          {r.status}
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
                          </TableRow>
                          {expanded.has(chave) && (
                            <TableRow>
                              <TableCell colSpan={7} className="bg-[var(--muted)]/40">
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
    </div>
  );
}
