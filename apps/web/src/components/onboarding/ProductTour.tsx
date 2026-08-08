import { useEffect, useRef } from "react";
import { driver, type Driver } from "driver.js";
import "driver.js/dist/driver.css";
import { ROTEIRO_TOUR, type PaginaTour } from "@/lib/onboarding-roteiro";

/**
 * Product Tour sobre as telas REAIS, com driver.js vestido de Opea.
 * O tour conduz a navegação: antes de cada passo, pede ao App para ir à
 * página-alvo e espera o elemento ficar visível (as telas montam ocultas com
 * `hidden`; navegar remove o hidden). Textos e ordem vêm de onboarding-roteiro.
 */

/** Espera o `data-tour` existir E estar visível (offsetParent != null). */
function esperarVisivel(seletor: string, timeout = 2500): Promise<void> {
  return new Promise((resolve) => {
    const inicio = Date.now();
    const tenta = () => {
      const el = document.querySelector<HTMLElement>(`[data-tour="${seletor}"]`);
      if ((el && el.offsetParent !== null) || Date.now() - inicio > timeout) resolve();
      else requestAnimationFrame(tenta);
    };
    tenta();
  });
}

export function ProductTour({
  aberto,
  navegar,
  onFim,
}: {
  aberto: boolean;
  /** Leva o App à página do passo (troca módulo/tela). */
  navegar: (pagina: PaginaTour) => void;
  /** Chamado quando o tour termina ou é fechado — App persiste e fecha. */
  onFim: () => void;
}) {
  const driverRef = useRef<Driver | null>(null);
  const indiceRef = useRef(0);

  useEffect(() => {
    if (!aberto) return;
    let cancelado = false;

    const prepararPasso = async (i: number) => {
      const passo = ROTEIRO_TOUR[i];
      if (!passo) return;
      indiceRef.current = i;
      navegar(passo.pagina);
      if (passo.seletor) await esperarVisivel(passo.seletor);
    };

    const d = driver({
      showProgress: true,
      allowClose: true,
      overlayColor: "rgba(38, 3, 25, 0.55)", // vinho profundo da marca
      stagePadding: 6,
      stageRadius: 10,
      popoverClass: "opea-tour",
      nextBtnText: "Próximo",
      prevBtnText: "Anterior",
      doneBtnText: "Concluir",
      progressText: "{{current}} de {{total}}",
      steps: ROTEIRO_TOUR.map((p) => ({
        element: p.seletor ? `[data-tour="${p.seletor}"]` : undefined,
        popover: { title: p.titulo, description: p.texto },
      })),
      onNextClick: () => {
        const i = indiceRef.current;
        if (i >= ROTEIRO_TOUR.length - 1) {
          d.destroy();
          return;
        }
        void prepararPasso(i + 1).then(() => {
          if (!cancelado) d.moveNext();
        });
      },
      onPrevClick: () => {
        const i = indiceRef.current;
        if (i <= 0) return;
        void prepararPasso(i - 1).then(() => {
          if (!cancelado) d.movePrevious();
        });
      },
      onCloseClick: () => d.destroy(),
      onDestroyed: () => {
        if (!cancelado) onFim();
      },
    });
    driverRef.current = d;

    void prepararPasso(0).then(() => {
      if (!cancelado) d.drive(0);
    });

    return () => {
      cancelado = true;
      d.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- roda ao abrir/fechar
  }, [aberto]);

  return null;
}
