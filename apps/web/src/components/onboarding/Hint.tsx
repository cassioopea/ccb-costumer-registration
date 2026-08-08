import { useEffect, useRef, useState } from "react";
import { HelpCircle, X } from "lucide-react";
import { HINTS } from "@/lib/onboarding-roteiro";
import { useOnboarding } from "@/lib/onboarding";
import { cn } from "@/lib/utils";

/**
 * Dica contextual ancorada a um elemento — ícone "?" discreto ao lado de algo
 * que gera dúvida. Sob demanda (clique abre o balão); enquanto nunca foi visto,
 * um pontinho chama atenção. "Não mostrar de novo" oculta de vez, por usuário
 * (persistido na base). Texto+ícone, nunca só cor.
 */
export function Hint({ id, className }: { id: keyof typeof HINTS | string; className?: string }) {
  const def = HINTS[id as string];
  const { estado, hintDispensado, dispensarHint } = useOnboarding();
  const [aberto, setAberto] = useState(false);
  const raiz = useRef<HTMLSpanElement>(null);

  // Fecha ao clicar fora.
  useEffect(() => {
    if (!aberto) return;
    const fora = (e: MouseEvent) => {
      if (raiz.current && !raiz.current.contains(e.target as Node)) setAberto(false);
    };
    document.addEventListener("mousedown", fora);
    return () => document.removeEventListener("mousedown", fora);
  }, [aberto]);

  // Estado ainda carregando, def inexistente ou já dispensado: não renderiza.
  if (!def || !estado || hintDispensado(id as string)) return null;

  const nuncaVisto = false; // ponto de atenção some após a 1ª abertura na sessão
  return (
    <span ref={raiz} className={cn("relative inline-flex", className)}>
      <button
        type="button"
        onClick={() => setAberto((v) => !v)}
        aria-label={`Dica: ${def.titulo}`}
        aria-expanded={aberto}
        className="focus-ring flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground transition-colors duration-150 hover:text-primary"
      >
        <HelpCircle className="h-4 w-4" />
        {nuncaVisto && (
          <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-wine-500" />
        )}
      </button>

      {aberto && (
        <div className="absolute left-1/2 top-7 z-40 w-64 -translate-x-1/2 rounded-lg border border-border bg-popover p-3 shadow-elevated">
          <div className="mb-1 flex items-start justify-between gap-2">
            <span className="text-body font-semibold text-foreground">{def.titulo}</span>
            <button
              type="button"
              onClick={() => setAberto(false)}
              aria-label="Fechar dica"
              className="focus-ring rounded-md text-muted-foreground hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <p className="text-caption text-muted-foreground">{def.texto}</p>
          <button
            type="button"
            onClick={() => {
              dispensarHint(id as string);
              setAberto(false);
            }}
            className="focus-ring mt-2 text-caption text-primary underline-offset-2 hover:underline"
          >
            Não mostrar de novo
          </button>
        </div>
      )}
    </span>
  );
}
