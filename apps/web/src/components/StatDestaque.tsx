import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Número institucional — anatomia do "Nossos números" das apresentações Opea:
 * categoria pequena em caixa alta, número grande em display com a unidade
 * menor, e rodapé de contexto. O accent rosa (wine-500) é reservado ao dado
 * que pede olhar primeiro — nunca mais de um por grupo.
 */
export function StatDestaque({
  categoria,
  valor,
  unidade,
  rodape,
  acento = false,
  className,
}: {
  categoria: string;
  valor: ReactNode;
  unidade?: string;
  rodape?: ReactNode;
  /** true = número no rosa de dados da marca. */
  acento?: boolean;
  className?: string;
}) {
  return (
    <div className={className}>
      <div className="text-caption font-medium uppercase tracking-label text-muted-foreground">
        {categoria}
      </div>
      <div
        className={cn(
          "mt-1 font-display text-display tabular-nums",
          acento ? "text-wine-500" : "text-foreground",
        )}
      >
        {valor}
        {unidade && <span className="ml-1.5 text-heading text-muted-foreground">{unidade}</span>}
      </div>
      {rodape && <div className="mt-1 text-caption text-muted-foreground">{rodape}</div>}
    </div>
  );
}
