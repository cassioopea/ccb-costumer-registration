import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { StatDestaque } from "@/components/StatDestaque";
import type { VelocidadeResumo } from "@/lib/api";

/**
 * Bloco executivo VELOCIDADE: quanto tempo a esteira consome — tempo de ciclo
 * (média + mediana), duração média por etapa e throughput semanal.
 * DIFERENÇA para o "Onde está travando": lá é FILA (quantas paradas agora);
 * aqui é DURAÇÃO (quanto tempo cada etapa consumiu nas concluídas).
 */
export function VelocidadeEsteira({ velocidade }: { velocidade: VelocidadeResumo }) {
  const semDados = velocidade.base === 0;
  const maxEtapa = Math.max(1, ...velocidade.tempoPorEtapa.map((e) => e.mediaHoras));
  const maxSemana = Math.max(1, ...velocidade.throughputSemanas.map((s) => s.total));

  const labelHoras = (h: number) => (h <= 72 ? `${Math.round(h)} h` : `${(h / 24).toFixed(1)} d`);

  return (
    <Card className="reveal reveal-delay-2">
      <CardHeader>
        <div className="text-caption font-medium uppercase tracking-label text-wine-500">
          Velocidade
        </div>
        <CardTitle>Velocidade da esteira</CardTitle>
        <CardDescription>
          Duração média por etapa — o "Onde está travando" acima mostra fila
          (contagem); aqui é tempo. Fonte: histórico das concluídas na Sinqia
          {velocidade.base > 0 ? ` (${velocidade.base} contrato(s))` : ""}
          {velocidade.capAtingido ? " — amostra limitada" : ""}.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {semDados ? (
          <p className="text-body text-muted-foreground">
            Sem contratos concluídos no recorte — o ciclo é calculado sobre as
            concluídas.
          </p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-6">
              <StatDestaque
                categoria="Tempo de ciclo"
                valor={
                  velocidade.cicloMedioDias !== null
                    ? velocidade.cicloMedioDias.toFixed(1)
                    : "—"
                }
                unidade="dias"
                rodape={
                  velocidade.cicloMedianaDias !== null
                    ? `mediana ${velocidade.cicloMedianaDias.toFixed(1)} dias — da criação ao contrato`
                    : "da criação ao contrato efetivado"
                }
              />
              <div>
                <div className="text-caption font-medium uppercase tracking-label text-muted-foreground">
                  Throughput
                </div>
                <div className="mt-2 flex h-12 items-end gap-1">
                  {velocidade.throughputSemanas.map((s) => (
                    <div
                      key={s.semana}
                      className="flex-1 rounded-t-sm bg-wine-500/80"
                      style={{ height: `${Math.max(8, (s.total / maxSemana) * 100)}%` }}
                      title={`Semana de ${s.semana.slice(8, 10)}/${s.semana.slice(5, 7)}: ${s.total} concluída(s)`}
                    />
                  ))}
                </div>
                <div className="mt-1 text-caption text-muted-foreground">
                  concluídas por semana (últimas {velocidade.throughputSemanas.length})
                </div>
              </div>
            </div>

            <div>
              <h3 className="text-subheading text-foreground">Tempo médio por etapa</h3>
              <p className="mb-3 text-caption text-muted-foreground">
                Quanto cada etapa consumiu, em média, nas concluídas.
              </p>
              <div className="space-y-2">
                {velocidade.tempoPorEtapa.map((e) => (
                  <div key={e.dsStatus} className="flex items-center gap-3">
                    <span
                      className="w-44 shrink-0 truncate text-caption text-muted-foreground"
                      title={`${e.dsStatus} — média sobre ${e.n} transição(ões)`}
                    >
                      {e.dsStatus.replace(/\s*\(.*\)\s*$/, "")}
                    </span>
                    <span className="h-4 flex-1 overflow-hidden rounded-sm bg-muted">
                      <span
                        className="block h-full rounded-sm bg-info"
                        style={{ width: `${Math.max(3, (e.mediaHoras / maxEtapa) * 100)}%` }}
                      />
                    </span>
                    <span className="w-14 shrink-0 text-right text-body font-medium tabular-nums">
                      {labelHoras(e.mediaHoras)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
