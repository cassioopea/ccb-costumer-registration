import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

/**
 * Sessão do operador.
 *
 * O token nunca chega ao browser — fica no backend, referenciado por um cookie
 * httpOnly. Aqui só trafegam metadados (usuário, validade) para a UI.
 */

export interface SessionInfo {
  env: string;
  username: string;
  /** "jwt" = sabemos a validade exata; "opaco" = a Sinqia não informa. */
  tokenFormato: "jwt" | "opaco";
  tokenTtlSegundos: number | null;
  tokenExpiraEm: number | null;
  /** Menor prazo entre inatividade, teto absoluto e expiração do token (epoch ms). */
  expiraEm: number;
  restanteMs: number;
  idleMs: number;
  absolutoMs: number;
}

/** Marcador que o backend manda em 401 quando a sessão morreu. */
const CODE_SESSAO_EXPIRADA = "SESSAO_EXPIRADA";

/** Erro de sessão expirada — o wrapper de fetch levanta, a UI reage. */
export class SessaoExpiradaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessaoExpiradaError";
  }
}

type Listener = (motivo: string) => void;
const listeners = new Set<Listener>();

/** Avisa a aplicação que a sessão caiu (abre o modal de reautenticação). */
function notificarExpiracao(motivo: string) {
  for (const l of listeners) l(motivo);
}

/**
 * Trata a resposta de uma chamada autenticada.
 *
 * Em 401 com `code: SESSAO_EXPIRADA`, dispara o modal em vez de deixar cada
 * tela inventar seu próprio tratamento — e levanta `SessaoExpiradaError` para
 * quem chamou abortar sem mostrar erro genérico.
 */
export async function lerResposta<T>(res: Response, fallback: string): Promise<T> {
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* resposta sem corpo JSON */
  }

  if (res.status === 401 && json?.code === CODE_SESSAO_EXPIRADA) {
    const msg = json?.error ?? "Sessão expirada.";
    notificarExpiracao(msg);
    throw new SessaoExpiradaError(msg);
  }

  if (!res.ok) throw new Error(json?.error ?? `${fallback} (HTTP ${res.status}).`);
  return json as T;
}

/* ------------------------------------------------------------------ */
/* Chamadas de sessão                                                  */
/* ------------------------------------------------------------------ */

export async function apiLogin(username: string, password: string): Promise<SessionInfo> {
  const res = await fetch("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.error ?? `Falha no login (HTTP ${res.status}).`);
  return json as SessionInfo;
}

export async function apiLogout(): Promise<void> {
  await fetch("/api/logout", { method: "POST" }).catch(() => undefined);
}

/** Sessão corrente, ou null se não houver. Usado para sobreviver ao F5. */
export async function apiSession(): Promise<SessionInfo | null> {
  const res = await fetch("/api/session");
  if (res.status === 401) return null;
  if (!res.ok) return null;
  return (await res.json()) as SessionInfo;
}

/* ------------------------------------------------------------------ */
/* Contexto                                                            */
/* ------------------------------------------------------------------ */

interface SessionContextValue {
  session: SessionInfo | null;
  /** Carregando a sessão inicial (evita piscar a tela de login no F5). */
  carregando: boolean;
  /** Mensagem do motivo da expiração — não-nula abre o modal. */
  expiradaMotivo: string | null;
  entrar: (username: string, password: string) => Promise<void>;
  sair: () => Promise<void>;
  /** Reautentica mantendo o usuário atual. Fecha o modal em caso de sucesso. */
  reautenticar: (password: string) => Promise<void>;
  dispensarExpiracao: () => void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [expiradaMotivo, setExpiradaMotivo] = useState<string | null>(null);

  // Rehidrata no primeiro render: o cookie httpOnly sobrevive ao reload.
  useEffect(() => {
    let vivo = true;
    void apiSession().then((s) => {
      if (!vivo) return;
      setSession(s);
      setCarregando(false);
    });
    return () => {
      vivo = false;
    };
  }, []);

  // Qualquer chamada que receba 401 avisa por aqui.
  useEffect(() => {
    const listener: Listener = (motivo) => setExpiradaMotivo(motivo);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  const entrar = useCallback(async (username: string, password: string) => {
    const s = await apiLogin(username, password);
    setSession(s);
    setExpiradaMotivo(null);
  }, []);

  const sair = useCallback(async () => {
    await apiLogout();
    setSession(null);
    setExpiradaMotivo(null);
  }, []);

  const reautenticar = useCallback(
    async (password: string) => {
      if (!session) throw new Error("Sem sessão para reautenticar.");
      const s = await apiLogin(session.username, password);
      setSession(s);
      setExpiradaMotivo(null);
    },
    [session],
  );

  const dispensarExpiracao = useCallback(() => {
    // Desistiu de reautenticar: volta para a tela de login.
    setExpiradaMotivo(null);
    setSession(null);
  }, []);

  const value = useMemo(
    () => ({
      session,
      carregando,
      expiradaMotivo,
      entrar,
      sair,
      reautenticar,
      dispensarExpiracao,
    }),
    [session, carregando, expiradaMotivo, entrar, sair, reautenticar, dispensarExpiracao],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession precisa estar dentro de <SessionProvider>.");
  return ctx;
}

/* ------------------------------------------------------------------ */
/* Utilitários de validade                                             */
/* ------------------------------------------------------------------ */

/** "12 min" / "1 h 05 min" — formato curto para o header. */
export function formatarRestante(ms: number): string {
  if (ms <= 0) return "expirada";
  const totalMin = Math.floor(ms / 60_000);
  if (totalMin < 60) return `${totalMin} min`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h} h ${String(m).padStart(2, "0")} min`;
}

/**
 * Sessão perto de expirar (< 5 min).
 *
 * Importa porque não há renovação automática: um lote de 60–80 linhas iniciado
 * com o token quase vencido pode não terminar, e as linhas restantes ficariam
 * como NÃO ENVIADO. Os diálogos de confirmação avisam nesse caso.
 */
export const MARGEM_CURTA_MS = 5 * 60_000;

export function sessaoPertoDeExpirar(session: SessionInfo | null): boolean {
  if (!session) return false;
  return session.expiraEm - Date.now() < MARGEM_CURTA_MS;
}

/** Recalcula o tempo restante a cada 30 s para o contador do header. */
export function useRestante(session: SessionInfo | null): number {
  const [agora, setAgora] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setAgora(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  if (!session) return 0;
  return Math.max(0, session.expiraEm - agora);
}
