import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { OpeaLogo } from "./OpeaLogo";

const ENV = (import.meta.env.VITE_SINQIA_ENV ?? "hml").toLowerCase();
const IS_PROD = ENV === "prod";

/** Chip de ambiente no header (estilo do AppShell do backoffice). */
function EnvironmentChip() {
  return (
    <span
      className={cn(
        "flex items-center gap-2 rounded-full border px-3 py-1 text-caption",
        IS_PROD
          ? "border-destructive/50 bg-destructive/15 text-sidebar-foreground"
          : "border-sidebar-foreground/15 bg-sidebar-foreground/5 text-sidebar-foreground/85",
      )}
      title={IS_PROD ? "Ambiente de PRODUÇÃO — cadastros são reais" : "Ambiente de homologação"}
    >
      <span className={cn("size-1.5 rounded-full", IS_PROD ? "bg-destructive" : "bg-success")} />
      <span className="font-medium uppercase tracking-wider">
        {IS_PROD ? "Produção" : "HML"}
      </span>
      <ChevronDown className="size-3 opacity-70" />
    </span>
  );
}

export function Topbar() {
  return (
    <header className="sticky top-0 z-40 bg-sidebar text-sidebar-foreground shadow-elevated">
      {/* Faixa contextual */}
      <div className="border-b border-sidebar-foreground/10 bg-sidebar-foreground/[0.04]">
        <div className="mx-auto flex max-w-[1440px] items-center justify-between gap-4 px-8 py-2.5 text-caption">
          <div className="flex items-center gap-3">
            <EnvironmentChip />
            <span className="hidden text-sidebar-foreground/55 sm:inline">
              Cadastro em Lote · Sinqia BJ21M05
            </span>
          </div>
          <span className="hidden tabular-nums text-sidebar-foreground/55 lg:inline">
            {new Date().toLocaleDateString("pt-BR", {
              weekday: "short",
              day: "2-digit",
              month: "short",
            })}
          </span>
        </div>
      </div>

      {/* Faixa principal */}
      <div className="mx-auto flex h-16 max-w-[1440px] items-center gap-8 px-8">
        <div className="flex items-center gap-3 text-sidebar-foreground">
          <OpeaLogo className="h-6 w-auto text-sidebar-foreground" />
          <span aria-hidden className="h-5 w-px bg-sidebar-foreground/25" />
          <span className="text-caption font-medium uppercase tracking-[0.2em] text-sidebar-foreground/70">
            Cadastro de Clientes CCB
          </span>
        </div>

      </div>
    </header>
  );
}

export { IS_PROD, ENV };
