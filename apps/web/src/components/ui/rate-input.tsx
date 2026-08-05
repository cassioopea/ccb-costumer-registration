import * as React from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

interface RateInputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  /** Sufixo fixo dentro do campo (ex.: "% a.m.", "% a.a."). */
  sufixo: string;
}

/**
 * Campo financeiro de taxa: valor alinhado à direita em tabular-nums, com o
 * sufixo da unidade DENTRO do campo — o operador nunca adivinha se a taxa é
 * mensal ou anual. Canônico para qualquer taxa do sistema (ver DESIGN.md).
 */
const RateInput = React.forwardRef<HTMLInputElement, RateInputProps>(
  ({ sufixo, className, ...props }, ref) => (
    <div className="relative">
      <Input
        ref={ref}
        inputMode="decimal"
        className={cn("pr-14 text-right tabular-nums", className)}
        {...props}
      />
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-caption text-muted-foreground"
      >
        {sufixo}
      </span>
    </div>
  ),
);
RateInput.displayName = "RateInput";

export { RateInput };
