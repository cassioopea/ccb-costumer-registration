import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { StatDestaque } from "@/components/StatDestaque";
import { LineChart, type SerieLinha } from "@/components/ui/line-chart";
import { CORES_SERIES } from "@/lib/esteira";
import type { ValorOriginadoResumo } from "@/lib/api";
import { formatBRL } from "@/lib/format";

/**
 * Bloco executivo VALOR: quanto a esteira originou (contratos efetivados),
 * ticket com mediana ao lado e o originado no tempo, empilhado por convênio.
 * Números saem do vlSolic (valor solicitado) da varredura; o líquido exato só
 * existe para o que a FERRAMENTA criou (base local) — cobertura sempre à vista.
 */
export function ValorOriginado({ valor }: { valor: ValorOriginadoResumo }) {
  const variacao =
    valor.originadoMesAnterior > 0
      ? ((valor.originadoMesAtual - valor.originadoMesAnterior) /
          valor.originadoMesAnterior) *
        100
      : null;

  return (
    <Card className="reveal">
      <CardHeader>
        <div className="text-caption font-medium uppercase tracking-label text-wine-500">
          Valor
        </div>
        <CardTitle>Valor originado</CardTitle>
        <CardDescription>
          Contratos efetivados (etapa finalizada), em valor solicitado — fonte: esteira
          Sinqia.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-8">
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-3">
          <StatDestaque
            className="reveal reveal-delay-1"
            categoria="Originado no mês"
            valor={formatBRL(valor.originadoMesAtual)}
            acento
            rodape={
              variacao === null
                ? `mês anterior: ${formatBRL(valor.originadoMesAnterior)}`
                : `${variacao >= 0 ? "▲" : "▼"} ${Math.abs(variacao).toFixed(0)}% vs mês anterior (${formatBRL(valor.originadoMesAnterior)})`
            }
          />
          <StatDestaque
            className="reveal reveal-delay-2"
            categoria="Ticket médio"
            valor={valor.ticketMedio !== null ? formatBRL(valor.ticketMedio) : "—"}
            rodape={
              valor.ticketMediana !== null
                ? `mediana ${formatBRL(valor.ticketMediana)} · ${valor.contratos} contrato(s)`
                : `${valor.contratos} contrato(s)`
            }
          />
          <StatDestaque
            className="reveal reveal-delay-3"
            categoria="Líquido liberado"
            valor={valor.liquidoLiberado !== null ? formatBRL(valor.liquidoLiberado) : "—"}
            rodape={
              valor.liquidoLiberado !== null
                ? `registrado em ${valor.liquidoCobertura} de ${valor.contratos} contrato(s) — criações pela ferramenta`
                : "pendente — sem registros locais ainda (passa a valer para criações feitas aqui)"
            }
          />
        </div>

        <div className="reveal reveal-delay-3 grid items-start gap-8 lg:grid-cols-2">
          {/* Tendência (linha) e composição do mês (barras) lado a lado. */}
          <div>
            <h3 className="text-subheading text-foreground">Tendência mensal</h3>
            <p className="mb-4 text-caption text-muted-foreground">
              Evolução por convênio — passe o mouse para os valores.
            </p>
            <LinhaMensal porMes={valor.porMes} />
          </div>
          <div>
            <h3 className="text-subheading text-foreground">Composição do mês</h3>
            <p className="mb-4 text-caption text-muted-foreground">
              Quanto cada convênio pesou, empilhado por mês.
            </p>
            <BarrasMensais porMes={valor.porMes} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Evolução mensal do valor originado, uma LINHA por convênio. Compacto para
 * BRL no eixo Y (R$ 1,2 mi); o tooltip do gráfico dá o valor cheio.
 */
function LinhaMensal({ porMes }: { porMes: ValorOriginadoResumo["porMes"] }) {
  if (porMes.length === 0) {
    return (
      <p className="text-body text-muted-foreground">
        Nenhum contrato efetivado no recorte ainda.
      </p>
    );
  }

  const rotuloMes = (mes: string) => `${mes.slice(4, 6)}/${mes.slice(2, 4)}`;
  const labels = porMes.map((m) => rotuloMes(m.mes));

  // Uma série por convênio; valor 0 no mês sem dado (linha não some, encosta no piso).
  const ordem: Array<{ chave: string; nmConv: string; cor: string }> = [];
  const indice = new Map<string, number>();
  for (const m of porMes) {
    for (const s of m.series) {
      const chave = String(s.cdConv ?? "sem");
      if (!indice.has(chave)) {
        indice.set(chave, ordem.length);
        ordem.push({
          chave,
          nmConv: s.nmConv || `Convênio ${s.cdConv ?? "—"}`,
          cor: CORES_SERIES[ordem.length % CORES_SERIES.length],
        });
      }
    }
  }
  const series: SerieLinha[] = ordem.map((c) => ({
    nome: c.nmConv,
    cor: c.cor,
    valores: porMes.map(
      (m) => m.series.find((s) => String(s.cdConv ?? "sem") === c.chave)?.total ?? 0,
    ),
  }));

  return <LineChart labels={labels} series={series} formatarValor={brlCompacto} altura={280} />;
}

/** BRL compacto para o eixo Y: R$ 1,2 mi / R$ 340 mil / R$ 900. */
function brlCompacto(v: number): string {
  if (v >= 1_000_000) return `R$ ${(v / 1_000_000).toFixed(1).replace(".", ",")} mi`;
  if (v >= 1_000) return `R$ ${Math.round(v / 1_000)} mil`;
  return formatBRL(v);
}

/** Barras mensais empilhadas por convênio — mostra a COMPOSIÇÃO de cada mês. */
function BarrasMensais({ porMes }: { porMes: ValorOriginadoResumo["porMes"] }) {
  if (porMes.length === 0) {
    return (
      <p className="text-body text-muted-foreground">
        Nenhum contrato efetivado no recorte ainda.
      </p>
    );
  }

  const maxMes = Math.max(...porMes.map((m) => m.series.reduce((a, s) => a + s.total, 0)));
  // Cor por convênio, estável e na MESMA ordem da linha (consistência visual).
  const convenios = new Map<string, { nmConv: string; cor: string }>();
  for (const m of porMes) {
    for (const s of m.series) {
      const chave = String(s.cdConv ?? "sem");
      if (!convenios.has(chave)) {
        convenios.set(chave, {
          nmConv: s.nmConv || `Convênio ${s.cdConv ?? "—"}`,
          cor: CORES_SERIES[convenios.size % CORES_SERIES.length],
        });
      }
    }
  }
  const rotuloMes = (mes: string) => `${mes.slice(4, 6)}/${mes.slice(2, 4)}`;

  return (
    <div className="space-y-3">
      <div className="flex h-64 items-end gap-3">
        {porMes.map((m) => {
          const totalMes = m.series.reduce((a, s) => a + s.total, 0);
          return (
            <div key={m.mes} className="flex h-full flex-1 flex-col justify-end gap-1">
              <div
                className="flex w-full flex-col-reverse overflow-hidden rounded-t-md"
                style={{ height: `${maxMes > 0 ? Math.max(3, (totalMes / maxMes) * 100) : 0}%` }}
                title={`${rotuloMes(m.mes)} — ${formatBRL(totalMes)}`}
              >
                {m.series.map((s) => (
                  <div
                    key={String(s.cdConv ?? "sem")}
                    style={{
                      height: `${totalMes > 0 ? (s.total / totalMes) * 100 : 0}%`,
                      backgroundColor: convenios.get(String(s.cdConv ?? "sem"))!.cor,
                    }}
                    title={`${s.nmConv || s.cdConv} — ${formatBRL(s.total)}`}
                  />
                ))}
              </div>
              <div className="text-center text-caption text-muted-foreground tabular-nums">
                {rotuloMes(m.mes)}
              </div>
            </div>
          );
        })}
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1">
        {[...convenios.values()].map((c) => (
          <li key={c.nmConv} className="flex items-center gap-1.5 text-caption text-muted-foreground">
            <span aria-hidden className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: c.cor }} />
            <span className="max-w-56 truncate">{c.nmConv}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
