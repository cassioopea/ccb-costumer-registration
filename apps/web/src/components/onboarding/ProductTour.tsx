import { useEffect } from "react";
import { driver, type DriveStep } from "driver.js";
import "driver.js/dist/driver.css";
import { capituloPorId, type CapituloTour, type PassoTour } from "@/lib/onboarding-roteiro";
import { useTour } from "@/lib/tour";
import { IndiceTour } from "./IndiceTour";

/**
 * Motor do tour guiado sobre as telas REAIS, com driver.js vestido de Opea.
 *
 * Um driver POR CAPÍTULO. Toda transição — clique, teclado ou entrada direta
 * pelo índice — passa pelo mesmo pipeline:
 *
 *   navegar(destino) → executar(ação da tela) → esperar o elemento → ancorar
 *
 * Quando o alvo não aparece (flag de aprovação inativa, fila vazia, base ainda
 * carregando), o passo cai no fallback declarado no roteiro: vira card
 * centralizado (com texto alternativo, se houver) ou é pulado. Nunca ancora em
 * nada silenciosamente — em desenvolvimento, o alvo ausente vira aviso no
 * console (insumo do QA roteirizado da Fase 4).
 *
 * Textos, ordem e capítulos vivem em `lib/onboarding-roteiro.ts`.
 */

/**
 * Espera o `data-tour` existir E estar visível (as telas montam com `hidden`).
 *
 * Procura entre TODOS os candidatos, não só o primeiro: as telas do app ficam
 * todas montadas, então uma âncora repetida em duas telas devolveria a cópia
 * escondida e o passo cairia no fallback com o alvo certo bem à vista.
 */
function esperarElemento(seletor: string, timeout = 3000): Promise<HTMLElement | null> {
  return new Promise((resolve) => {
    const inicio = Date.now();
    const tenta = () => {
      const candidatos = document.querySelectorAll<HTMLElement>(`[data-tour="${seletor}"]`);
      const el = [...candidatos].find((c) => c.offsetParent !== null);
      if (el) {
        resolve(el);
        return;
      }
      if (Date.now() - inicio > timeout) {
        resolve(null);
        return;
      }
      requestAnimationFrame(tenta);
    };
    tenta();
  });
}

/** Passo → step do driver.js. `semAlvo` degrada para card centralizado. */
function montarStep(passo: PassoTour, semAlvo: boolean): DriveStep {
  return {
    element: !semAlvo && passo.seletor ? `[data-tour="${passo.seletor}"]` : undefined,
    popover: {
      title: passo.titulo,
      description: semAlvo ? (passo.textoSemAlvo ?? passo.texto) : passo.texto,
      side: passo.lado,
    },
  };
}

/** Folga entre o recorte e o alvo. 6px espremia o conteúdo contra a borda. */
const PADDING_PADRAO = 10;
/** Só entra quando não dá para ler o raio do alvo (passo sem elemento). */
const RAIO_PADRAO = 24;

/**
 * Cantos CONCÊNTRICOS com o do alvo: raio do recorte = raio do elemento +
 * folga, então os arcos partilham centro. Ler o raio do próprio elemento vale
 * mais do que fixar um número — um Card (18px), um botão (6px) e um bloco sem
 * arredondamento pedem recortes diferentes, e um raio grande num alvo baixo e
 * largo (uma linha de filtro, um cabeçalho de coluna) deforma o recorte.
 */
function raioConcentrico(el: HTMLElement | null, padding: number): number {
  if (!el) return RAIO_PADRAO;
  const bruto = getComputedStyle(el).borderTopLeftRadius;
  const proprio = Number.parseFloat(bruto);
  return (Number.isFinite(proprio) ? proprio : 0) + padding;
}

export function ProductTour({ onConcluirTudo }: { onConcluirTudo: () => void }) {
  const {
    capituloAtual,
    modo,
    passoInicial,
    navegar,
    executarAcao,
    concluirCapitulo,
    proximoCapitulo,
    iniciarCapitulo,
    voltarAoIndice,
    salvarPosicao,
    limparPosicao,
    fechar,
  } = useTour();

  useEffect(() => {
    if (!capituloAtual) return;
    const encontrado = capituloPorId(capituloAtual);
    if (!encontrado) {
      fechar();
      return;
    }
    // As funções abaixo são declarações hoisted: a narrowing do `if` acima não
    // sobrevive dentro delas, então fixamos a referência já estreitada.
    const capitulo: CapituloTour = encontrado;

    const passos = capitulo.passos;
    let cancelado = false;
    /** Índice do passo ancorado; -1 = o driver ainda não foi iniciado. */
    let indice = -1;
    /** Trava contra avanço duplo enquanto a preparação assíncrona roda. */
    let ocupado = false;
    /** Distingue destroy nosso (fim/encadeamento) de saída do usuário (Esc/X). */
    let saidaProgramada = false;

    const steps: DriveStep[] = passos.map((p) => montarStep(p, false));

    const d = driver({
      showProgress: true,
      allowClose: true,
      overlayColor: "rgba(38, 3, 25, 0.55)", // vinho profundo da marca
      stagePadding: PADDING_PADRAO,
      stageRadius: RAIO_PADRAO,
      popoverClass: "opea-tour",
      // Afasta o popover do recorte — com o padrão (10) ele encostava na borda
      // do destaque em alvos largos.
      popoverOffset: 16,
      nextBtnText: "Próximo",
      prevBtnText: "Anterior",
      doneBtnText: "Concluir",
      progressText: `${capitulo.titulo} · {{current}} de {{total}}`,
      steps,
      // ←/→ passam por estes mesmos hooks no driver.js 1.8 — o pipeline de
      // preparação vale para clique e teclado.
      onNextClick: () => void ir(indice + 1, 1),
      onPrevClick: () => void ir(indice - 1, -1),
      onDoneClick: () => void ir(passos.length, 1),
      onCloseClick: () => encerrar("saiu"),
      onDestroyed: () => {
        // Esc dispara o destroy interno da lib sem passar por onCloseClick.
        if (!saidaProgramada && !cancelado) fechar();
      },
      onPopoverRender: (popover) => {
        injetarAcoesDoRodape(popover.footer);
      },
    });

    /** Botões extras no rodapé: índice e pular capítulo. */
    function injetarAcoesDoRodape(footer: HTMLElement) {
      if (footer.querySelector(".opea-tour-acoes")) return;
      const caixa = document.createElement("div");
      caixa.className = "opea-tour-acoes";

      const indiceBtn = document.createElement("button");
      indiceBtn.type = "button";
      indiceBtn.textContent = "Índice";
      indiceBtn.title = "Voltar ao índice dos capítulos";
      indiceBtn.addEventListener("click", () => encerrar("indice"));

      const pularBtn = document.createElement("button");
      pularBtn.type = "button";
      pularBtn.textContent = "Pular capítulo";
      pularBtn.title = "Segue para o próximo capítulo sem marcar este como visto";
      pularBtn.addEventListener("click", () => encerrar("pulou"));

      caixa.append(indiceBtn, pularBtn);
      footer.prepend(caixa);
    }

    /** Ancora o passo `i` (já preparado) e salva a posição. */
    function aplicar(i: number, semAlvo: boolean, alvo: HTMLElement | null) {
      const passo = passos[i];
      const padding = passo.padding ?? PADDING_PADRAO;
      // O passo é trocado NO LUGAR e publicado por setConfig. Não use
      // `setSteps` aqui: ele chama `resetState()` por dentro, o que apaga a
      // referência do popover ativo — o popover anterior fica órfão no DOM e
      // a tela acumula um card por passo visitado. `setConfig` não mexe no
      // estado. (Verificado no driver.js 1.8.)
      steps[i] = montarStep(passo, semAlvo);
      d.setConfig({
        ...d.getConfig(),
        stagePadding: padding,
        stageRadius: passo.raio ?? raioConcentrico(semAlvo ? null : alvo, padding),
        steps,
      });
      if (indice < 0) d.drive(i);
      else d.moveTo(i);
      indice = i;
      salvarPosicao({ capitulo: capitulo.id, passo: i });
    }

    /**
     * Vai para o passo `alvo`, preparando a tela antes de ancorar. Passo sem
     * alvo visível cai no fallback do roteiro; `direcao` mantém o sentido da
     * navegação quando um passo é pulado.
     */
    async function ir(alvo: number, direcao: 1 | -1) {
      if (ocupado || cancelado) return;
      ocupado = true;
      try {
        const atual = passos[indice];
        if (atual?.limpar) await executarAcao(atual.limpar);
        if (cancelado) return;

        let i = alvo;
        while (i >= 0 && i < passos.length) {
          const passo = passos[i];
          navegar(passo.destino);
          if (passo.acao) await executarAcao(passo.acao);
          if (cancelado) return;

          let semAlvo = false;
          let elemento: HTMLElement | null = null;
          if (passo.seletor) {
            const el = await esperarElemento(passo.seletor);
            if (cancelado) return;
            elemento = el;
            if (!el) {
              if (import.meta.env.DEV) {
                console.warn(
                  `[tour] alvo ausente em "${capitulo.id}/${passo.id}": [data-tour="${passo.seletor}"]`,
                );
              }
              if (passo.aoFaltar === "pular") {
                i += direcao;
                continue;
              }
              semAlvo = true;
            }
          }
          aplicar(i, semAlvo, elemento);
          return;
        }
        // Passou do fim: capítulo concluído. (Antes do início o driver.js nem
        // chama o hook, então só o sentido "adiante" encerra aqui.)
        encerrar("fim");
      } finally {
        ocupado = false;
      }
    }

    /** Fim de capítulo — por conclusão, pulo, volta ao índice ou saída. */
    function encerrar(motivo: "fim" | "pulou" | "indice" | "saiu") {
      saidaProgramada = true;
      const atual = passos[indice];
      if (atual?.limpar) void executarAcao(atual.limpar);
      d.destroy();

      if (motivo === "fim") concluirCapitulo(capitulo.id);

      if (motivo === "saiu") return fechar(); // posição fica salva: dá para retomar
      if (motivo === "indice") return voltarAoIndice();

      // "fim" e "pulou" encadeiam o percurso completo.
      if (modo === "completo") {
        const proximo = proximoCapitulo(capitulo.id);
        if (proximo) return iniciarCapitulo(proximo, "completo", 0);
        limparPosicao();
        onConcluirTudo();
        return fechar();
      }
      return voltarAoIndice();
    }

    void ir(Math.min(Math.max(passoInicial, 0), passos.length - 1), 1);

    return () => {
      cancelado = true;
      saidaProgramada = true;
      d.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- roda ao trocar de capítulo
  }, [capituloAtual, passoInicial]);

  return <IndiceTour />;
}
