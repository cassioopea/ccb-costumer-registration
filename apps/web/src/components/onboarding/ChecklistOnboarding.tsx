import { useState } from "react";
import { Check, ChevronDown, ListChecks, Play, X } from "lucide-react";
import { CAPITULOS_ATIVOS } from "@/lib/onboarding-roteiro";
import { useOnboarding } from "@/lib/onboarding";
import { useTour } from "@/lib/tour";
import { cn } from "@/lib/utils";

/**
 * Checklist de primeiros passos — painel recolhível no canto inferior. Agora
 * ele espelha os CAPÍTULOS do tour: cada item abre o capítulo correspondente e
 * se marca quando o capítulo é concluído (mesma fonte do índice, persistida por
 * usuário). Antes os itens eram atalhos de navegação soltos, que não diziam se
 * a pessoa tinha entendido a tela — só se tinha passado por ela.
 *
 * Ao concluir tudo, minimiza para uma pílula discreta (não some de vez — dá
 * para reabrir). Fecha por sessão sem apagar o progresso.
 */
export function ChecklistOnboarding() {
  const { estado } = useOnboarding();
  const { concluidos, iniciarCapitulo } = useTour();
  const [aberto, setAberto] = useState(true);
  const [fechadoNaSessao, setFechadoNaSessao] = useState(false);

  if (!estado || fechadoNaSessao) return null;

  // A abertura é só enquadramento — não é "primeiro passo" a cumprir.
  const itens = CAPITULOS_ATIVOS.filter((c) => c.id !== "abertura");
  if (itens.length === 0) return null;

  const feitos = itens.filter((c) => concluidos.has(c.id)).length;
  const total = itens.length;
  const tudoPronto = feitos === total;
  const pct = Math.round((feitos / total) * 100);

  // Recolhido: pílula com o progresso; clicar reabre.
  if (!aberto) {
    return (
      <button
        type="button"
        onClick={() => setAberto(true)}
        className="focus-ring fixed bottom-4 right-4 z-30 flex items-center gap-2 rounded-full border border-border bg-card px-4 py-2 text-body shadow-elevated"
      >
        <ListChecks className="h-4 w-4 text-primary" />
        Primeiros passos
        <span className="rounded-full bg-accent px-2 py-0.5 text-caption font-medium tabular-nums text-accent-foreground">
          {feitos}/{total}
        </span>
      </button>
    );
  }

  return (
    <div className="fixed bottom-4 right-4 z-30 w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-border bg-card shadow-elevated">
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
        <span className="flex items-center gap-2 text-subheading text-foreground">
          <ListChecks className="h-4 w-4 text-primary" />
          Primeiros passos
        </span>
        <span className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setAberto(false)}
            title="Minimizar"
            className="focus-ring rounded-md p-1 text-muted-foreground hover:text-foreground"
          >
            <ChevronDown className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => setFechadoNaSessao(true)}
            title="Fechar (o progresso fica salvo)"
            className="focus-ring rounded-md p-1 text-muted-foreground hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </span>
      </div>

      <div className="px-4 py-3">
        {/* Barra de progresso */}
        <div className="mb-3 flex items-center gap-2">
          <span className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
            <span
              className="block h-full rounded-full bg-primary transition-all duration-200"
              style={{ width: `${pct}%` }}
            />
          </span>
          <span className="text-caption text-muted-foreground tabular-nums">
            {feitos}/{total}
          </span>
        </div>

        {tudoPronto ? (
          <p className="py-2 text-body text-success">
            <Check className="mr-1 inline h-4 w-4" />
            Tudo pronto! Você já conhece a esteira de ponta a ponta.
          </p>
        ) : (
          <ul className="space-y-1">
            {itens.map((cap) => {
              const feito = concluidos.has(cap.id);
              return (
                <li key={cap.id}>
                  <button
                    type="button"
                    onClick={() => iniciarCapitulo(cap.id, "capitulo", 0)}
                    title={cap.resumo}
                    className={cn(
                      "focus-ring group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-body transition-colors duration-150 hover:bg-accent",
                      feito && "text-muted-foreground",
                    )}
                  >
                    <span
                      className={cn(
                        "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
                        feito ? "border-transparent bg-success text-success-foreground" : "border-border",
                      )}
                    >
                      {feito && <Check className="h-3 w-3" />}
                    </span>
                    <span className={cn("flex-1 truncate", feito && "line-through")}>
                      {cap.titulo}
                    </span>
                    <Play className="h-3 w-3 shrink-0 text-muted-foreground opacity-0 transition-opacity duration-150 group-hover:opacity-100" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
