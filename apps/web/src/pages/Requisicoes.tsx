import { ClipboardCheck, Inbox } from "lucide-react";
import { cn } from "@/lib/utils";
import { PainelPendencias } from "@/pages/PainelPendencias";
import { MinhasRequisicoes } from "@/pages/MinhasRequisicoes";

/**
 * Módulo "Requisições" da Esteira de Aprovação (SoD) — duas visões:
 *  - Pendências de aprovação (US-03, lado do aprovador): decidir requisições
 *    de outros operadores;
 *  - Minhas requisições (US-02, lado do requisitante): acompanhar e cancelar.
 * Ambas ficam montadas (padrão do App) para navegar sem perder estado.
 */

export type TelaRequisicoes = "pendencias" | "minhas";

const ABAS: Array<{ id: TelaRequisicoes; label: string; icone: typeof Inbox }> = [
  { id: "pendencias", label: "Pendências de aprovação", icone: ClipboardCheck },
  { id: "minhas", label: "Minhas requisições", icone: Inbox },
];

export function Requisicoes({
  ativa,
  tela,
  onTelaChange,
}: {
  ativa: boolean;
  tela: TelaRequisicoes;
  onTelaChange: (t: TelaRequisicoes) => void;
}) {
  return (
    <div className="space-y-6">
      <nav
        className="flex items-center gap-0.5 border-b border-border"
        aria-label="Visões de requisições"
      >
        {ABAS.map(({ id, label, icone: Icone }) => {
          const ativo = tela === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => onTelaChange(id)}
              aria-current={ativo ? "page" : undefined}
              className={cn(
                "focus-ring relative inline-flex items-center gap-1.5 px-3 py-3 text-subheading transition-colors duration-150",
                ativo
                  ? "text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Icone className="h-4 w-4" />
              {label}
              {ativo && (
                <span className="absolute inset-x-3 -bottom-px h-[2px] rounded-full bg-primary" />
              )}
            </button>
          );
        })}
      </nav>

      <div className={tela === "pendencias" ? undefined : "hidden"}>
        <PainelPendencias ativa={ativa && tela === "pendencias"} />
      </div>
      <div className={tela === "minhas" ? undefined : "hidden"}>
        <MinhasRequisicoes ativa={ativa && tela === "minhas"} />
      </div>
    </div>
  );
}
