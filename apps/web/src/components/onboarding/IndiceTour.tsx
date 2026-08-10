import { Check, Compass, PlayCircle, RotateCcw } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { CAPITULOS_ATIVOS, TOTAL_PASSOS, capituloPorId } from "@/lib/onboarding-roteiro";
import { useTour } from "@/lib/tour";
import { cn } from "@/lib/utils";

/**
 * Índice do tour — a porta de entrada. O usuário faz o percurso completo (o
 * tour navega entre as telas sozinho) ou entra direto num capítulo. Capítulo
 * já concluído aparece marcado, e "continuar de onde parei" só aparece quando
 * existe posição salva.
 */
export function IndiceTour() {
  const {
    indiceAberto,
    concluidos,
    retomada,
    iniciarCapitulo,
    fechar,
  } = useTour();

  if (!indiceAberto) return null;

  /** Percurso completo começa no primeiro capítulo ainda não concluído. */
  const primeiroPendente =
    CAPITULOS_ATIVOS.find((c) => !concluidos.has(c.id))?.id ?? CAPITULOS_ATIVOS[0]?.id;
  const tudoConcluido = CAPITULOS_ATIVOS.every((c) => concluidos.has(c.id));
  const capRetomada = retomada ? capituloPorId(retomada.capitulo) : undefined;

  return (
    <Dialog open onOpenChange={(aberto) => !aberto && fechar()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Compass className="h-5 w-5 text-primary" />
            Tour guiado
          </DialogTitle>
          <DialogDescription>
            {CAPITULOS_ATIVOS.length} capítulos, {TOTAL_PASSOS} paradas. Faça tudo em
            sequência — o tour troca de tela sozinho — ou entre direto no capítulo que
            interessa. Seu progresso fica salvo.
          </DialogDescription>
        </DialogHeader>

        <ul className="space-y-1.5">
          {CAPITULOS_ATIVOS.map((c, i) => {
            const feito = concluidos.has(c.id);
            return (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => iniciarCapitulo(c.id, "capitulo", 0)}
                  className="focus-ring flex w-full items-start gap-3 rounded-lg border border-border px-3 py-2.5 text-left transition-colors duration-150 hover:border-primary/50 hover:bg-accent"
                >
                  <span
                    className={cn(
                      "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-caption tabular-nums",
                      feito
                        ? "border-transparent bg-success text-success-foreground"
                        : "border-border text-muted-foreground",
                    )}
                  >
                    {feito ? <Check className="h-3 w-3" /> : i + 1}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-baseline gap-x-2">
                      <span className="text-subheading text-foreground">{c.titulo}</span>
                      <span className="text-caption text-muted-foreground tabular-nums">
                        {c.passos.length} passo(s)
                      </span>
                    </span>
                    <span className="mt-0.5 block text-caption text-muted-foreground">
                      {c.resumo}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>

        <DialogFooter>
          <Button variant="outline" onClick={fechar}>
            Fechar
          </Button>
          {capRetomada && retomada && (
            <Button
              variant="outline"
              onClick={() => iniciarCapitulo(retomada.capitulo, "completo", retomada.passo)}
            >
              <RotateCcw className="h-4 w-4" />
              Continuar em “{capRetomada.titulo}”
            </Button>
          )}
          {primeiroPendente && (
            <Button onClick={() => iniciarCapitulo(primeiroPendente, "completo", 0)}>
              <PlayCircle className="h-4 w-4" />
              {tudoConcluido ? "Refazer o tour completo" : "Fazer o tour completo"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
