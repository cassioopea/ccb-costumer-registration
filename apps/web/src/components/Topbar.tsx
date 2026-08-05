import { Clock, LogOut, UserRound } from "lucide-react";
import { cn } from "@/lib/utils";
import { OpeaLogo } from "./OpeaLogo";
import { formatarRestante, useRestante, useSession } from "@/lib/session";

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
    </span>
  );
}

/**
 * Estado da sessão no header: usuário, validade e sair.
 *
 * A validade é o menor prazo entre inatividade (30 min), teto absoluto (8 h) e
 * expiração do token. Quando o token é opaco a Sinqia não informa a validade
 * dele — o tooltip diz isso em vez de fingir precisão.
 */
function SessionChip() {
  const { session, sair } = useSession();
  const restante = useRestante(session);
  if (!session) return null;

  const tokenDesc =
    session.tokenFormato === "jwt" && session.tokenTtlSegundos !== null
      ? `Token JWT da Sinqia: validade de ${Math.round(session.tokenTtlSegundos / 60)} min.`
      : "A Sinqia não informa a validade deste token (formato opaco).";

  return (
    <div className="flex items-center gap-3">
      <span className="hidden items-center gap-1.5 text-caption text-sidebar-foreground/75 sm:flex">
        <UserRound className="size-3.5" />
        {session.username}
      </span>
      <span
        className="hidden items-center gap-1.5 text-caption text-sidebar-foreground/60 md:flex"
        title={`Sessão expira em ${formatarRestante(restante)}. ${tokenDesc}`}
      >
        <Clock className="size-3.5" />
        {formatarRestante(restante)}
      </span>
      <button
        type="button"
        onClick={() => void sair()}
        className="focus-ring flex items-center gap-1.5 rounded-md border border-sidebar-foreground/20 px-2.5 py-1 text-caption text-sidebar-foreground/85 transition-colors duration-150 hover:bg-sidebar-foreground/10"
      >
        <LogOut className="size-3.5" />
        Sair
      </button>
    </div>
  );
}

/** Módulos da esteira — a topbar navega entre eles (estilo AppShell do backoffice). */
export type Modulo = "clientes" | "propostas";

const MODULOS: Array<{ id: Modulo; label: string }> = [
  { id: "clientes", label: "Clientes" },
  { id: "propostas", label: "Propostas" },
];

interface TopbarProps {
  modulo: Modulo;
  onModuloChange: (m: Modulo) => void;
}

export function Topbar({ modulo, onModuloChange }: TopbarProps) {
  return (
    <header className="sticky top-0 z-40 bg-sidebar text-sidebar-foreground shadow-elevated">
      {/* Faixa contextual */}
      <div className="border-b border-sidebar-foreground/10 bg-sidebar-foreground/[0.04]">
        <div className="mx-auto flex max-w-shell items-center justify-between gap-4 px-8 py-2 text-caption">
          <div className="flex items-center gap-3">
            <EnvironmentChip />
            <span className="hidden text-sidebar-foreground/55 sm:inline">
              Originação CCB · Sinqia BJ21M05
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

      {/* Faixa principal: logo + produto + módulos + sessão */}
      <div className="mx-auto flex h-16 max-w-shell items-center gap-8 px-8">
        <div className="flex items-center gap-3 text-sidebar-foreground">
          <OpeaLogo className="h-6 w-auto text-sidebar-foreground" />
          <span aria-hidden className="h-5 w-px bg-sidebar-foreground/25" />
          <span className="text-caption font-medium uppercase tracking-label text-sidebar-foreground/70">
            Esteira de Originação
          </span>
        </div>

        <nav className="flex items-center gap-0.5" aria-label="Módulos">
          {MODULOS.map(({ id, label }) => {
            const ativo = modulo === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => onModuloChange(id)}
                aria-current={ativo ? "page" : undefined}
                className={cn(
                  "focus-ring relative inline-flex items-center px-3 py-5 text-subheading font-normal transition-colors duration-150",
                  ativo
                    ? "text-sidebar-foreground"
                    : "text-sidebar-foreground/65 hover:text-sidebar-foreground",
                )}
              >
                {label}
                {ativo && (
                  <span className="absolute inset-x-3 -bottom-px h-[2px] rounded-full bg-sidebar-foreground" />
                )}
              </button>
            );
          })}
        </nav>

        <div className="ml-auto">
          <SessionChip />
        </div>
      </div>
    </header>
  );
}

export { IS_PROD, ENV };
