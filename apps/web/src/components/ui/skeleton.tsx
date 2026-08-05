import { cn } from "@/lib/utils";

/**
 * Placeholder de carregamento com a FORMA do conteúdo que vai chegar.
 * Preferir sempre a spinner genérico: linhas de tabela viram barras de
 * linha, um select vira um retângulo de select. O pulso respeita
 * prefers-reduced-motion via regra global.
 */
function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden
      className={cn("animate-pulse rounded-md bg-muted", className)}
      {...props}
    />
  );
}

export { Skeleton };
