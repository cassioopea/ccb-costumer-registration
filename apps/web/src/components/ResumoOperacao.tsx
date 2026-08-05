import type { ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

export interface ItemResumo {
  rotulo: string;
  valor: ReactNode;
  /** Destaque para o dado-chave da operação (ex.: total financiado). */
  forte?: boolean;
}

/**
 * Resumo vivo da operação — elemento assinatura das telas de originação.
 * Barra aderente ao rodapé que consolida o que está sendo criado (linhas,
 * somas, parâmetros, status das fases) e carrega o CTA da fase atual.
 * O operador nunca perde de vista o que a ferramenta vai gravar na Sinqia.
 */
export function ResumoOperacao({
  itens,
  status,
  alerta,
  cta,
}: {
  itens: ItemResumo[];
  /** Linha de status das fases (verificação/cálculo/criação), já formatada. */
  status?: ReactNode;
  /** Aviso bloqueante curto (ex.: parâmetros inválidos). */
  alerta?: string | null;
  /** Ação primária da fase atual. */
  cta: ReactNode;
}) {
  return (
    <div className="sticky bottom-4 z-30">
      <div className="flex flex-wrap items-center justify-between gap-x-8 gap-y-3 rounded-xl border border-border bg-card/95 px-6 py-4 shadow-elevated backdrop-blur">
        <div className="min-w-0 space-y-1.5">
          <dl className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
            {itens.map((item) => (
              <div key={item.rotulo} className="flex flex-col">
                <dt className="text-caption text-muted-foreground">{item.rotulo}</dt>
                <dd
                  className={cn(
                    "tabular-nums",
                    item.forte
                      ? "text-subheading text-foreground"
                      : "text-body text-foreground",
                  )}
                >
                  {item.valor}
                </dd>
              </div>
            ))}
          </dl>
          {status && <div className="text-caption text-muted-foreground">{status}</div>}
          {alerta && (
            <p className="flex items-center gap-1.5 text-caption text-destructive">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              {alerta}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-3">{cta}</div>
      </div>
    </div>
  );
}
