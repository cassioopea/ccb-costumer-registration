import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * O tailwind-merge precisa CONHECER a escala tipográfica semântica do tema
 * (index.css › @theme). Sem isto ele classifica `text-body`/`text-label` como
 * COR de texto e, ao mesclar com `text-primary-foreground`, descarta uma das
 * duas — foi o bug do filtro selecionado "sem texto" na conferência do cálculo.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [
        {
          text: [
            "display",
            "title",
            "heading",
            "subheading",
            "body",
            "label",
            "caption",
            "code",
          ],
        },
      ],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
