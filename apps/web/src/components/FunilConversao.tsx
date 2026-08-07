import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { StatDestaque } from "@/components/StatDestaque";
import type { FunilResumo } from "@/lib/api";

/**
 * Bloco executivo FUNIL: tomadores → propostas → aprovadas → contratos, com
 * % de passagem por degrau, o maior ponto de perda em destaque e a taxa
 * total. "Aprovadas" é aproximação por estado atual (≥ aprovado p/ desembolso).
 */
export function FunilConversao({
  funil,
  convenioFiltrado,
}: {
  funil: FunilResumo;
  convenioFiltrado: boolean;
}) {
  const degraus = [
    { nome: "Tomadores cadastrados", valor: funil.tomadores },
    { nome: "Propostas criadas", valor: funil.propostas },
    { nome: "Aprovadas*", valor: funil.aprovadas },
    { nome: "Contratos efetivados", valor: funil.efetivadas },
  ];
  const base = degraus.find((d) => d.valor !== null && d.valor > 0)?.valor ?? 0;

  // % de passagem em relação ao degrau anterior + maior perda.
  let maiorPerda: { de: string; para: string; taxa: number } | null = null;
  const linhas = degraus.map((d, i) => {
    const anterior = i > 0 ? degraus[i - 1].valor : null;
    const passagem =
      d.valor !== null && anterior !== null && anterior > 0
        ? (d.valor / anterior) * 100
        : null;
    if (passagem !== null && (maiorPerda === null || passagem < maiorPerda.taxa)) {
      maiorPerda = { de: degraus[i - 1].nome, para: d.nome, taxa: passagem };
    }
    return { ...d, passagem };
  });

  const taxaTotal =
    funil.tomadores !== null && funil.tomadores > 0
      ? (funil.efetivadas / funil.tomadores) * 100
      : null;

  return (
    <Card className="reveal reveal-delay-3">
      <CardHeader>
        <div className="text-caption font-medium uppercase tracking-label text-wine-500">
          Conversão
        </div>
        <CardTitle>Funil de conversão</CardTitle>
        <CardDescription>
          Do cadastro ao contrato. *Aprovadas é aproximação pelo estado atual
          (≥ aprovado para desembolso).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-2">
          {linhas.map((d) => (
            <div key={d.nome} className="flex items-center gap-3">
              <span className="w-44 shrink-0 truncate text-caption text-muted-foreground">
                {d.nome}
              </span>
              <span className="h-5 flex-1 overflow-hidden rounded-sm bg-muted">
                {d.valor !== null && base > 0 && (
                  <span
                    className="block h-full rounded-sm bg-wine-500/85"
                    style={{ width: `${Math.max(2, (d.valor / base) * 100)}%` }}
                  />
                )}
              </span>
              <span className="w-14 shrink-0 text-right text-body font-medium tabular-nums">
                {d.valor ?? "—"}
              </span>
              <span className="w-12 shrink-0 text-right text-caption text-muted-foreground tabular-nums">
                {d.passagem !== null ? `${d.passagem.toFixed(0)}%` : ""}
              </span>
            </div>
          ))}
        </div>

        {funil.tomadores === null && (
          <p className="text-caption text-muted-foreground">
            {convenioFiltrado
              ? "Com o filtro de convênio ativo, o degrau de tomadores (global) fica de fora para não distorcer a comparação."
              : "Contagem de tomadores indisponível neste momento."}
          </p>
        )}

        {maiorPerda !== null && (
          <p className="text-body text-muted-foreground">
            Maior perda:{" "}
            <strong className="text-foreground">
              {(maiorPerda as { de: string; para: string; taxa: number }).de} →{" "}
              {(maiorPerda as { de: string; para: string; taxa: number }).para}
            </strong>{" "}
            — só{" "}
            <span className="tabular-nums">
              {(maiorPerda as { de: string; para: string; taxa: number }).taxa.toFixed(0)}%
            </span>{" "}
            passam desse degrau.
          </p>
        )}

        <StatDestaque
          categoria="Taxa de conversão total"
          valor={taxaTotal !== null ? `${taxaTotal.toFixed(1)}%` : "—"}
          acento
          rodape={
            funil.tomadores !== null
              ? `${funil.efetivadas} contrato(s) / ${funil.tomadores} tomador(es)`
              : `${funil.efetivadas} contrato(s) — denominador global indisponível no recorte`
          }
        />
      </CardContent>
    </Card>
  );
}
