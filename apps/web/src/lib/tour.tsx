import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  CAPITULOS_ATIVOS,
  capituloPorId,
  type AcaoTourNome,
  type DestinoTour,
} from "@/lib/onboarding-roteiro";
import { useOnboarding } from "@/lib/onboarding";
import { useSession } from "@/lib/session";

/**
 * Controlador do tour guiado — estado, progresso e o registro de AÇÕES DE TELA.
 *
 * O tour não reimplementa comportamento de tela: cada página registra o que
 * sabe fazer (`useAcaoTour("painel.selecionarPrimeiraFila", fn)`) e o passo do
 * roteiro apenas declara o nome da ação. Abrir uma modal no tour é, então, a
 * mesma abertura do uso real — nada de lógica duplicada nem de regra de
 * negócio dentro do onboarding.
 *
 * Progresso (decisão do checkpoint da Fase 0, "Opção A"):
 *  - capítulo CONCLUÍDO vive na base, por usuário, dentro de `checklistItens`
 *    com a chave reservada `tour:cap:<id>` (o campo já é JSON livre — nenhuma
 *    migração de banco);
 *  - a posição fina (passo dentro do capítulo) é descartável e fica no
 *    localStorage, por usuário e ambiente.
 */

/** Prefixo reservado no checklist — não colide com os itens de primeiros passos. */
const PREFIXO_CAPITULO = "tour:cap:";

const chaveCapitulo = (id: string) => `${PREFIXO_CAPITULO}${id}`;

/** Posição retomável: em que passo de qual capítulo o usuário parou. */
export interface PosicaoTour {
  capitulo: string;
  passo: number;
}

/** Como o tour foi aberto: percurso completo ou um capítulo avulso. */
export type ModoTour = "completo" | "capitulo";

export type AcaoTourFn = () => void | Promise<void>;

interface TourContexto {
  /** Índice aberto (escolha de capítulo). */
  indiceAberto: boolean;
  /** Capítulo em execução; null quando o tour não está percorrendo. */
  capituloAtual: string | null;
  modo: ModoTour;
  /** Passo em que o capítulo deve começar (retomada). */
  passoInicial: number;
  /** Ids de capítulos já concluídos por este usuário. */
  concluidos: Set<string>;
  /** Onde o usuário parou, se houver retomada pendente. */
  retomada: PosicaoTour | null;

  /** Abre o índice (sem argumento) ou entra direto num capítulo. */
  abrir: (capituloId?: string) => void;
  /** Retoma de onde parou; cai no índice se não houver posição salva. */
  retomar: () => void;
  /** Fecha tudo (Esc, X, fim do percurso). */
  fechar: () => void;
  /** Volta ao índice a partir de um capítulo em execução. */
  voltarAoIndice: () => void;
  /** Inicia um capítulo (usado pelo índice e pelo encadeamento do percurso). */
  iniciarCapitulo: (capituloId: string, modo: ModoTour, passo?: number) => void;
  /** Marca o capítulo como concluído (persiste na base). */
  concluirCapitulo: (capituloId: string) => void;
  /** Próximo capítulo do percurso completo; null se era o último. */
  proximoCapitulo: (capituloId: string) => string | null;

  /** Leva a UI ao destino do passo (implementado pelo App — ver `useNavegacaoTour`). */
  navegar: (destino: DestinoTour) => void;
  /** O App registra aqui como levar a UI a um destino (ver `useNavegacaoTour`). */
  registrarNavegacao: (fn: (destino: DestinoTour) => void) => void;
  /** Executa uma ação registrada por uma tela; false se ninguém registrou. */
  executarAcao: (nome: AcaoTourNome) => Promise<boolean>;
  /** Registra/desregistra a ação de uma tela (use o hook `useAcaoTour`). */
  registrarAcao: (nome: AcaoTourNome, fn: AcaoTourFn) => () => void;

  /** Salva a posição fina (localStorage). */
  salvarPosicao: (pos: PosicaoTour) => void;
  /** Descarta a posição fina — fim de percurso ou saída consciente. */
  limparPosicao: () => void;
}

const Ctx = createContext<TourContexto | null>(null);

export function TourProvider({ children }: { children: ReactNode }) {
  const { session } = useSession();
  const { estado, marcarChecklist } = useOnboarding();

  /**
   * Quem sabe trocar de módulo/tela é o App — ele se registra por
   * `useNavegacaoTour`. O provider fica acima dele, então a ligação é por
   * referência, não por prop.
   */
  const navegarRef = useRef<(destino: DestinoTour) => void>(() => {});

  const [indiceAberto, setIndiceAberto] = useState(false);
  const [capituloAtual, setCapituloAtual] = useState<string | null>(null);
  const [modo, setModo] = useState<ModoTour>("completo");
  const [passoInicial, setPassoInicial] = useState(0);

  /** Ações registradas pelas telas — ref, para não re-renderizar a árvore. */
  const acoes = useRef(new Map<AcaoTourNome, AcaoTourFn>());

  const chavePosicao = useMemo(
    () => `opea.tour.pos:${session?.username ?? "anon"}`,
    [session?.username],
  );

  const [retomada, setRetomada] = useState<PosicaoTour | null>(null);

  // Lê a posição salva ao (re)logar. localStorage é best-effort: se o
  // capítulo saiu do roteiro, a retomada simplesmente não existe.
  useEffect(() => {
    try {
      const bruto = localStorage.getItem(chavePosicao);
      if (!bruto) {
        setRetomada(null);
        return;
      }
      const pos = JSON.parse(bruto) as PosicaoTour;
      const cap = capituloPorId(pos.capitulo);
      setRetomada(cap && pos.passo > 0 && pos.passo < cap.passos.length ? pos : null);
    } catch {
      setRetomada(null);
    }
  }, [chavePosicao]);

  /**
   * Capítulos concluídos. MIGRAÇÃO: quem já tinha `tourConcluido` do roteiro
   * antigo entra com todos os capítulos vistos — não reabre o convite de 1º
   * acesso e continua podendo refazer capítulo a capítulo.
   */
  const concluidos = useMemo(() => {
    const set = new Set<string>();
    if (!estado) return set;
    if (estado.tourConcluido) {
      for (const c of CAPITULOS_ATIVOS) set.add(c.id);
    }
    for (const [chave, feito] of Object.entries(estado.checklistItens)) {
      if (feito && chave.startsWith(PREFIXO_CAPITULO)) set.add(chave.slice(PREFIXO_CAPITULO.length));
    }
    return set;
  }, [estado]);

  const salvarPosicao = useCallback(
    (pos: PosicaoTour) => {
      setRetomada(pos);
      try {
        localStorage.setItem(chavePosicao, JSON.stringify(pos));
      } catch {
        /* modo privado / cota — o tour funciona sem retomada */
      }
    },
    [chavePosicao],
  );

  const limparPosicao = useCallback(() => {
    setRetomada(null);
    try {
      localStorage.removeItem(chavePosicao);
    } catch {
      /* idem */
    }
  }, [chavePosicao]);

  const iniciarCapitulo = useCallback(
    (capituloId: string, m: ModoTour, passo = 0) => {
      setModo(m);
      setPassoInicial(passo);
      setCapituloAtual(capituloId);
      setIndiceAberto(false);
    },
    [],
  );

  const abrir = useCallback(
    (capituloId?: string) => {
      if (capituloId) {
        iniciarCapitulo(capituloId, "capitulo", 0);
        return;
      }
      setCapituloAtual(null);
      setIndiceAberto(true);
    },
    [iniciarCapitulo],
  );

  const retomar = useCallback(() => {
    if (retomada && capituloPorId(retomada.capitulo)) {
      iniciarCapitulo(retomada.capitulo, "completo", retomada.passo);
      return;
    }
    abrir();
  }, [abrir, iniciarCapitulo, retomada]);

  const fechar = useCallback(() => {
    setCapituloAtual(null);
    setIndiceAberto(false);
  }, []);

  const voltarAoIndice = useCallback(() => {
    setCapituloAtual(null);
    setIndiceAberto(true);
  }, []);

  const concluirCapitulo = useCallback(
    (capituloId: string) => {
      marcarChecklist(chaveCapitulo(capituloId));
    },
    [marcarChecklist],
  );

  const proximoCapitulo = useCallback((capituloId: string) => {
    const i = CAPITULOS_ATIVOS.findIndex((c) => c.id === capituloId);
    if (i < 0 || i + 1 >= CAPITULOS_ATIVOS.length) return null;
    return CAPITULOS_ATIVOS[i + 1].id;
  }, []);

  const registrarAcao = useCallback((nome: AcaoTourNome, fn: AcaoTourFn) => {
    acoes.current.set(nome, fn);
    return () => {
      if (acoes.current.get(nome) === fn) acoes.current.delete(nome);
    };
  }, []);

  const executarAcao = useCallback(async (nome: AcaoTourNome) => {
    const fn = acoes.current.get(nome);
    if (!fn) {
      if (import.meta.env.DEV) console.warn(`[tour] ação não registrada: ${nome}`);
      return false;
    }
    try {
      await fn();
      return true;
    } catch (e) {
      if (import.meta.env.DEV) console.warn(`[tour] ação ${nome} falhou`, e);
      return false;
    }
  }, []);

  const valor: TourContexto = {
    indiceAberto,
    capituloAtual,
    modo,
    passoInicial,
    concluidos,
    retomada,
    abrir,
    retomar,
    fechar,
    voltarAoIndice,
    iniciarCapitulo,
    concluirCapitulo,
    proximoCapitulo,
    navegar: (destino) => navegarRef.current(destino),
    registrarNavegacao: (fn) => {
      navegarRef.current = fn;
    },
    executarAcao,
    registrarAcao,
    salvarPosicao,
    limparPosicao,
  };

  return <Ctx.Provider value={valor}>{children}</Ctx.Provider>;
}

export function useTour(): TourContexto {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useTour fora do TourProvider");
  return ctx;
}

/**
 * O App registra como levar a UI a um destino do roteiro. Fica no corpo do
 * componente que detém o estado de navegação (Shell), abaixo do TourProvider.
 */
export function useNavegacaoTour(fn: (destino: DestinoTour) => void): void {
  const { registrarNavegacao } = useTour();
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    registrarNavegacao((destino) => fnRef.current(destino));
  }, [registrarNavegacao]);
}

/**
 * Registra uma ação de tela para o tour. Chame no corpo da página, ao lado dos
 * handlers que ela já tem:
 *
 *   useAcaoTour("painel.selecionarPrimeiraFila", () => selecionarFila(filas[0]?.nrStatus));
 *
 * A função é sempre a mais recente (guardada em ref), então pode fechar sobre
 * estado sem re-registrar a cada render.
 */
export function useAcaoTour(nome: AcaoTourNome, fn: AcaoTourFn): void {
  const { registrarAcao } = useTour();
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    return registrarAcao(nome, () => fnRef.current());
  }, [nome, registrarAcao]);
}
