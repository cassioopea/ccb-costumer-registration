import { useId, useMemo, useState } from "react";
import { cn } from "@/lib/utils";

export interface SerieLinha {
  nome: string;
  cor: string;
  /** Um ponto por rótulo do eixo X (mesmo comprimento de `labels`); null = sem dado. */
  valores: Array<number | null>;
}

/**
 * Gráfico de LINHAS em SVG puro (sem biblioteca) — série temporal na
 * identidade Opea: curva suave, área com gradiente sob a série, grid/eixos
 * discretos e tooltip no hover. Responsivo por viewBox; cores vêm das séries.
 */
export function LineChart({
  labels,
  series,
  formatarValor = (v) => String(v),
  altura = 260,
  className,
}: {
  labels: string[];
  series: SerieLinha[];
  /** Formata o eixo Y e o tooltip (ex.: R$). */
  formatarValor?: (v: number) => string;
  altura?: number;
  className?: string;
}) {
  const uid = useId().replace(/:/g, "");
  const [hover, setHover] = useState<number | null>(null);

  // Coordenadas em unidades de viewBox (largura fixa, escala pelo CSS).
  const W = 720;
  const H = altura;
  const padL = 56;
  const padR = 16;
  const padT = 16;
  const padB = 32;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const maxValor = useMemo(() => {
    let m = 0;
    for (const s of series) for (const v of s.valores) if (v !== null && v > m) m = v;
    return m > 0 ? m : 1;
  }, [series]);

  // Teto "redondo" para o eixo Y (5 divisões agradáveis).
  const teto = useMemo(() => {
    const bruto = maxValor / 4;
    const mag = Math.pow(10, Math.floor(Math.log10(bruto)));
    const passo = Math.ceil(bruto / mag) * mag;
    return passo * 4;
  }, [maxValor]);

  const x = (i: number) =>
    padL + (labels.length <= 1 ? plotW / 2 : (i / (labels.length - 1)) * plotW);
  const y = (v: number) => padT + plotH - (v / teto) * plotH;

  /** Caminho suave (curva Catmull-Rom → Bézier) ignorando pontos nulos. */
  const pathDe = (valores: Array<number | null>) => {
    const pts = valores
      .map((v, i) => (v === null ? null : ([x(i), y(v)] as [number, number])))
      .filter((p): p is [number, number] => p !== null);
    if (pts.length === 0) return "";
    if (pts.length === 1) return `M ${pts[0][0]} ${pts[0][1]}`;
    let d = `M ${pts[0][0]} ${pts[0][1]}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i === 0 ? 0 : i - 1];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[i + 2 < pts.length ? i + 2 : i + 1];
      const cp1x = p1[0] + (p2[0] - p0[0]) / 6;
      const cp1y = p1[1] + (p2[1] - p0[1]) / 6;
      const cp2x = p2[0] - (p3[0] - p1[0]) / 6;
      const cp2y = p2[1] - (p3[1] - p1[1]) / 6;
      d += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2[0]} ${p2[1]}`;
    }
    return d;
  };

  const linhasY = [0, 0.25, 0.5, 0.75, 1].map((f) => ({ f, valor: teto * f }));
  // Só uma fração dos rótulos X quando há muitos (evita amontoar).
  const passoLabel = Math.ceil(labels.length / 8);

  return (
    <div className={cn("w-full", className)}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        style={{ height: altura }}
        role="img"
        aria-label="Gráfico de linhas"
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          {series.map((s, si) => (
            <linearGradient key={si} id={`${uid}-g${si}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={s.cor} stopOpacity="0.22" />
              <stop offset="100%" stopColor={s.cor} stopOpacity="0" />
            </linearGradient>
          ))}
        </defs>

        {/* Grid horizontal + rótulos do eixo Y */}
        {linhasY.map((l) => (
          <g key={l.f}>
            <line
              x1={padL}
              y1={y(l.valor)}
              x2={W - padR}
              y2={y(l.valor)}
              stroke="var(--border)"
              strokeWidth="1"
            />
            <text
              x={padL - 8}
              y={y(l.valor) + 4}
              textAnchor="end"
              className="fill-[var(--muted-foreground)] text-[11px] tabular-nums"
            >
              {formatarValor(l.valor)}
            </text>
          </g>
        ))}

        {/* Rótulos do eixo X */}
        {labels.map((lb, i) =>
          i % passoLabel === 0 ? (
            <text
              key={i}
              x={x(i)}
              y={H - 10}
              textAnchor="middle"
              className="fill-[var(--muted-foreground)] text-[11px] tabular-nums"
            >
              {lb}
            </text>
          ) : null,
        )}

        {/* Área + linha de cada série (área só quando há 1 série, para não poluir) */}
        {series.map((s, si) => (
          <g key={si}>
            {series.length === 1 && (
              <path
                d={`${pathDe(s.valores)} L ${x(labels.length - 1)} ${y(0)} L ${x(0)} ${y(0)} Z`}
                fill={`url(#${uid}-g${si})`}
                stroke="none"
              />
            )}
            <path
              d={pathDe(s.valores)}
              fill="none"
              stroke={s.cor}
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </g>
        ))}

        {/* Camada de hover: linha-guia + pontos + faixas de captura */}
        {hover !== null && (
          <line
            x1={x(hover)}
            y1={padT}
            x2={x(hover)}
            y2={padT + plotH}
            stroke="var(--muted-foreground)"
            strokeWidth="1"
            strokeDasharray="3 3"
          />
        )}
        {hover !== null &&
          series.map((s, si) =>
            s.valores[hover] !== null ? (
              <circle
                key={si}
                cx={x(hover)}
                cy={y(s.valores[hover] as number)}
                r="4"
                fill="var(--background)"
                stroke={s.cor}
                strokeWidth="2.5"
              />
            ) : null,
          )}
        {labels.map((_, i) => (
          <rect
            key={i}
            x={x(i) - plotW / Math.max(1, labels.length) / 2}
            y={padT}
            width={plotW / Math.max(1, labels.length)}
            height={plotH}
            fill="transparent"
            onMouseEnter={() => setHover(i)}
          />
        ))}
      </svg>

      {/* Tooltip (HTML, fora do SVG) */}
      {hover !== null && (
        <div className="mt-1 rounded-lg border border-border bg-popover px-3 py-2 shadow-elevated">
          <div className="text-caption font-medium text-foreground">{labels[hover]}</div>
          <ul className="mt-1 space-y-0.5">
            {series
              .filter((s) => s.valores[hover] !== null)
              .sort((a, b) => (b.valores[hover] as number) - (a.valores[hover] as number))
              .map((s) => (
                <li key={s.nome} className="flex items-center gap-2 text-caption">
                  <span
                    aria-hidden
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: s.cor }}
                  />
                  <span className="flex-1 truncate text-muted-foreground">{s.nome}</span>
                  <span className="font-medium tabular-nums">
                    {formatarValor(s.valores[hover] as number)}
                  </span>
                </li>
              ))}
          </ul>
        </div>
      )}

      {/* Legenda */}
      {series.length > 1 && (
        <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
          {series.map((s) => (
            <li key={s.nome} className="flex items-center gap-1.5 text-caption text-muted-foreground">
              <span aria-hidden className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: s.cor }} />
              <span className="max-w-56 truncate">{s.nome}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
