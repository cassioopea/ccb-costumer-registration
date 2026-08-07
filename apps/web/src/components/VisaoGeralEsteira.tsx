import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { StatDestaque } from "@/components/StatDestaque";
import {
  CATEGORIAS,
  ORDEM_CATEGORIAS,
  categoriaDaEtapa,
  contagemPorCategoria,
  type CategoriaEtapa,
} from "@/lib/esteira";
import { getFilasPropostas, type FilaWf } from "@/lib/api";
import { SessaoExpiradaError } from "@/lib/session";

/**
 * Visão geral da esteira — o dashboard da página Início: stats no padrão
 * "Nossos números", donut por categoria semântica e gargalos por etapa.
 * Carrega as filas sozinho na primeira ativação (somente leitura).
 */
export function VisaoGeralEsteira({
  ativa,
  onAbrirFila,
}: {
  ativa: boolean;
  /** Clique num gargalo abre a fila daquela etapa no Painel de propostas. */
  onAbrirFila?: (nrStatus: number) => void;
}) {
  const [filas, setFilas] = useState<FilaWf[] | null>(null);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const jaAtivou = useRef(false);
  useEffect(() => {
    if (!ativa || jaAtivou.current) return;
    jaAtivou.current = true;
    void carregar();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- só na 1ª ativação
  }, [ativa]);

  async function carregar() {
    if (carregando) return;
    setCarregando(true);
    setErro(null);
    try {
      const res = await getFilasPropostas();
      setFilas([...res.filas].sort((a, b) => a.nrStatus - b.nrStatus));
    } catch (e) {
      if (!(e instanceof SessaoExpiradaError)) setErro((e as Error).message);
      setFilas((prev) => prev ?? []);
    } finally {
      setCarregando(false);
    }
  }

  const porCategoria = useMemo(() => contagemPorCategoria(filas ?? []), [filas]);
  const ativasNoFluxo =
    porCategoria.andamento + porCategoria.aguardando + porCategoria.atencao;

  /** Etapas com propostas paradas, maiores primeiro — "onde está travando". */
  const gargalos = useMemo(
    () =>
      (filas ?? [])
        .filter((f) => f.qtFilhos > 0)
        .sort((a, b) => b.qtFilhos - a.qtFilhos)
        .slice(0, 8),
    [filas],
  );
  const maxGargalo = gargalos[0]?.qtFilhos ?? 0;

  const nomeEtapa = (ds: string) => ds.replace(/\s*\(.*\)\s*$/, "");

  return (
    <Card className="reveal">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-caption font-medium uppercase tracking-label text-wine-500">
              Visão geral
            </div>
            <CardTitle>Saúde da esteira</CardTitle>
            <CardDescription>
              {erro
                ? `Não foi possível carregar as filas: ${erro}`
                : "Contagens ao vivo do workflow de propostas."}
            </CardDescription>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void carregar()}
            disabled={carregando}
            title="Recarrega as contagens da esteira"
          >
            {carregando ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-8">
        {filas === null ? (
          <div className="grid grid-cols-2 gap-6 lg:grid-cols-4">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-20 w-full" />
            ))}
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-6 lg:grid-cols-4">
              <StatDestaque
                className="reveal reveal-delay-1"
                categoria="Ativas no fluxo"
                valor={ativasNoFluxo}
                rodape="em andamento, aguardando ou em atenção"
              />
              <StatDestaque
                className="reveal reveal-delay-2"
                categoria="Aguardando ação"
                valor={porCategoria.aguardando}
                acento
                rodape="formalização, assinatura e desembolso"
              />
              <StatDestaque
                className="reveal reveal-delay-3"
                categoria="Requer atenção"
                valor={porCategoria.atencao}
                rodape="risco apontado ou documentos pendentes"
              />
              <StatDestaque
                className="reveal reveal-delay-4"
                categoria="Concluídas"
                valor={porCategoria.concluida}
                rodape={`${porCategoria.cancelada} cancelada(s) · ${porCategoria.negada} negada(s)`}
              />
            </div>

            <div className="grid items-start gap-8 lg:grid-cols-2">
              {/* Donut por categoria — cores fixas de estado */}
              <div className="reveal reveal-delay-2">
                <h3 className="text-subheading text-foreground">Propostas por categoria</h3>
                <p className="mb-4 text-caption text-muted-foreground">
                  Distribuição de tudo que está no workflow.
                </p>
                <DonutCategorias porCategoria={porCategoria} />
              </div>

              {/* Gargalos — onde as propostas estão paradas */}
              <div className="reveal reveal-delay-3">
                <h3 className="text-subheading text-foreground">Onde está travando</h3>
                <p className="mb-4 text-caption text-muted-foreground">
                  Propostas paradas por etapa, maiores primeiro
                  {onAbrirFila ? " — clique para abrir a fila" : ""}.
                </p>
                <div className="space-y-2">
                  {gargalos.length === 0 && (
                    <p className="text-body text-muted-foreground">
                      Nenhuma proposta no workflow deste ambiente.
                    </p>
                  )}
                  {gargalos.map((f) => {
                    const cat = CATEGORIAS[categoriaDaEtapa(f.nrStatus, f.dsStatus)];
                    return (
                      <button
                        key={f.nrStatus}
                        type="button"
                        onClick={() => onAbrirFila?.(f.nrStatus)}
                        disabled={!onAbrirFila}
                        title={`${f.dsStatus} — ${cat.label}.${onAbrirFila ? " Clique para ver a fila." : ""}`}
                        className="focus-ring group flex w-full items-center gap-3 rounded-md px-1 py-0.5 text-left"
                      >
                        <span className="w-44 shrink-0 truncate text-caption text-muted-foreground group-hover:text-foreground">
                          {nomeEtapa(f.dsStatus)}
                        </span>
                        <span className="h-4 flex-1 overflow-hidden rounded-sm bg-muted">
                          <span
                            className="block h-full rounded-sm transition-all duration-200"
                            style={{
                              width: `${maxGargalo > 0 ? Math.max(4, (f.qtFilhos / maxGargalo) * 100) : 0}%`,
                              backgroundColor: cat.cor,
                            }}
                          />
                        </span>
                        <span className="w-10 shrink-0 text-right text-body font-medium tabular-nums">
                          {f.qtFilhos}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Donut das categorias em SVG puro (sem biblioteca): um anel por categoria com
 * a cor de estado, total no centro, legenda com contagem e definição no title.
 */
function DonutCategorias({ porCategoria }: { porCategoria: Record<CategoriaEtapa, number> }) {
  const total = ORDEM_CATEGORIAS.reduce((acc, c) => acc + porCategoria[c], 0);
  const R = 54;
  const C = 2 * Math.PI * R;
  let acumulado = 0;

  return (
    <div className="flex flex-wrap items-center gap-6">
      <svg
        width="150"
        height="150"
        viewBox="0 0 150 150"
        role="img"
        aria-label={`Distribuição de ${total} propostas por categoria`}
        className="shrink-0"
      >
        <circle cx="75" cy="75" r={R} fill="none" stroke="var(--border)" strokeWidth="16" />
        <g transform="rotate(-90 75 75)">
          {ORDEM_CATEGORIAS.filter((c) => porCategoria[c] > 0).map((c) => {
            const fracao = total > 0 ? porCategoria[c] / total : 0;
            const seg = (
              <circle
                key={c}
                cx="75"
                cy="75"
                r={R}
                fill="none"
                stroke={CATEGORIAS[c].cor}
                strokeWidth="16"
                strokeDasharray={`${fracao * C} ${C}`}
                strokeDashoffset={-acumulado * C}
              />
            );
            acumulado += fracao;
            return seg;
          })}
        </g>
        <text
          x="75"
          y="72"
          textAnchor="middle"
          className="fill-[var(--foreground)] font-display text-title tabular-nums"
        >
          {total}
        </text>
        <text x="75" y="92" textAnchor="middle" className="fill-[var(--muted-foreground)] text-caption">
          propostas
        </text>
      </svg>

      <ul className="min-w-44 flex-1 space-y-1.5">
        {ORDEM_CATEGORIAS.map((c) => (
          <li key={c} title={CATEGORIAS[c].definicao} className="flex items-center gap-2 text-body">
            <span
              aria-hidden
              className="h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: CATEGORIAS[c].cor }}
            />
            <span className="flex-1 truncate">{CATEGORIAS[c].label}</span>
            <span className="font-medium tabular-nums">{porCategoria[c]}</span>
            <span className="w-11 text-right text-caption text-muted-foreground tabular-nums">
              {total > 0 ? `${Math.round((porCategoria[c] / total) * 100)}%` : "—"}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
