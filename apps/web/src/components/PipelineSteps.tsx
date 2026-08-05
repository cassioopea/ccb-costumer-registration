import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

export interface EtapaPipeline {
  id: string;
  label: string;
  estado: "concluida" | "ativa" | "pendente";
}

/**
 * Indicador PASSIVO das etapas do fluxo de originação — orienta, não trava.
 * Não é wizard: o operador continua livre para voltar (adotar nrClient,
 * refiltrar, recalcular). Ver DESIGN.md › Arquitetura de tela.
 */
export function PipelineSteps({ etapas }: { etapas: EtapaPipeline[] }) {
  return (
    <ol className="flex flex-wrap items-center gap-2" aria-label="Etapas do fluxo">
      {etapas.map((e, i) => (
        <li key={e.id} className="flex items-center gap-2">
          {i > 0 && <span aria-hidden className="h-px w-6 bg-border" />}
          <span
            aria-current={e.estado === "ativa" ? "step" : undefined}
            className={cn(
              "flex items-center gap-1.5 rounded-full border px-3 py-1 text-caption font-medium transition-colors duration-150",
              e.estado === "concluida" && "border-transparent bg-accent text-accent-foreground",
              e.estado === "ativa" && "border-primary bg-primary text-primary-foreground",
              e.estado === "pendente" && "border-border text-muted-foreground",
            )}
          >
            {e.estado === "concluida" ? (
              <Check className="h-3 w-3" aria-label="concluída" />
            ) : (
              <span className="tabular-nums">{i + 1}.</span>
            )}
            {e.label}
          </span>
        </li>
      ))}
    </ol>
  );
}
