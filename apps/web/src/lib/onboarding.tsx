import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { getOnboarding, salvarOnboarding, type OnboardingEstado } from "@/lib/api";
import { SessaoExpiradaError, useSession } from "@/lib/session";

/**
 * Estado de onboarding do usuário (tour, checklist, hints) vindo da base
 * local — nunca do browser. Carrega ao logar; expõe ações que persistem e
 * atualizam o estado local de forma otimista.
 */
interface OnboardingContexto {
  estado: OnboardingEstado | null;
  /** true enquanto não sabemos o estado (evita piscar o dialog de 1º acesso). */
  carregando: boolean;
  /** É o primeiro acesso? (sem registro E tour não concluído.) */
  primeiroAcesso: boolean;
  concluirTour: () => void;
  marcarChecklist: (id: string) => void;
  hintDispensado: (id: string) => boolean;
  dispensarHint: (id: string) => void;
}

const Ctx = createContext<OnboardingContexto | null>(null);

export function OnboardingProvider({ children }: { children: ReactNode }) {
  const { session } = useSession();
  const [estado, setEstado] = useState<OnboardingEstado | null>(null);
  const [carregando, setCarregando] = useState(true);

  // Carrega quando há sessão; zera ao sair.
  useEffect(() => {
    if (!session) {
      setEstado(null);
      setCarregando(false);
      return;
    }
    let vivo = true;
    setCarregando(true);
    void getOnboarding()
      .then((e) => {
        if (vivo) setEstado(e);
      })
      .catch(() => {
        // Sem onboarding (ex.: erro de base) não trava o app: assume "já viu".
        if (vivo) setEstado({ existe: true, tourConcluido: true, checklistItens: {}, hintsDispensados: [] });
      })
      .finally(() => {
        if (vivo) setCarregando(false);
      });
    return () => {
      vivo = false;
    };
  }, [session]);

  /** Persiste um patch e aplica o retorno; erro de sessão é silencioso. */
  const persistir = useCallback(
    async (patch: Parameters<typeof salvarOnboarding>[0]) => {
      // Atualização otimista para a UI responder na hora.
      setEstado((prev) =>
        prev
          ? {
              ...prev,
              existe: true,
              tourConcluido: patch.tourConcluido ?? prev.tourConcluido,
              checklistItens: { ...prev.checklistItens, ...(patch.checklistItens ?? {}) },
              hintsDispensados: patch.hintsDispensados
                ? [...new Set([...prev.hintsDispensados, ...patch.hintsDispensados])]
                : prev.hintsDispensados,
            }
          : prev,
      );
      try {
        const e = await salvarOnboarding(patch);
        setEstado(e);
      } catch (err) {
        if (!(err instanceof SessaoExpiradaError)) {
          /* mantém o otimista; a base tenta de novo na próxima ação */
        }
      }
    },
    [],
  );

  const valor: OnboardingContexto = {
    estado,
    carregando,
    primeiroAcesso: !carregando && !!estado && !estado.existe && !estado.tourConcluido,
    concluirTour: () => void persistir({ tourConcluido: true }),
    marcarChecklist: (id) => {
      if (estado?.checklistItens[id]) return; // já feito, não repete o PUT
      void persistir({ checklistItens: { [id]: true } });
    },
    hintDispensado: (id) => !!estado?.hintsDispensados.includes(id),
    dispensarHint: (id) => void persistir({ hintsDispensados: [id] }),
  };

  return <Ctx.Provider value={valor}>{children}</Ctx.Provider>;
}

export function useOnboarding(): OnboardingContexto {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useOnboarding fora do OnboardingProvider");
  return ctx;
}
