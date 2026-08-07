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

        <div className="reveal reveal-delay-3">
          <h3 className="text-subheading text-foreground">Originado no tempo</h3>
          <p className="mb-4 text-caption text-muted-foreground">
            Evolução mensal por convênio — passe o mouse para os valores.
          </p>
          <LinhaMensal porMes={valor.porMes} />
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
