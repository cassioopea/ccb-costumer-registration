import { randomBytes } from "node:crypto";

/**
 * Sessões em memória.
 *
 * SEGURANÇA — o que fica guardado e o que NÃO fica:
 *  - guarda: id da sessão, usuário e o TOKEN da Sinqia;
 *  - NUNCA guarda a senha. Como a API Sinqia não tem refresh token, isso implica
 *    que não há renovação automática: quando o token morre, o operador
 *    reautentica (a UI pede só a senha). Decisão consciente para não manter
 *    credencial em memória.
 *
 * Nada disso vai para disco ou log. Reiniciar o backend apaga todas as sessões.
 */

/** Expira por inatividade — qualquer requisição renova a janela. */
export const IDLE_MS = 30 * 60_000; // 30 min
/** Teto absoluto: mesmo em uso contínuo, obriga login novo depois disso. */
export const ABSOLUTE_MS = 8 * 3_600_000; // 8 h

export interface Session {
  id: string;
  username: string;
  /** Token da Sinqia (header `Auth`). Nunca sai daqui para o browser. */
  token: string;
  /** Expiração do token em epoch ms — só quando é JWT com `exp`. */
  tokenExp: number | null;
  createdAt: number;
  lastSeenAt: number;
}

/** Por que uma sessão não pôde ser usada — a UI usa para explicar ao operador. */
export type MotivoInvalida = "inexistente" | "inatividade" | "limite" | "token";

const MOTIVO_TEXTO: Record<MotivoInvalida, string> = {
  inexistente: "Sessão não encontrada. Entre novamente.",
  inatividade: "Sessão expirada por inatividade (30 min). Entre novamente.",
  limite: "Sessão atingiu o limite de 8 horas. Entre novamente.",
  token: "O token da Sinqia expirou. Entre novamente.",
};

export function motivoTexto(motivo: MotivoInvalida): string {
  return MOTIVO_TEXTO[motivo];
}

/* ------------------------------------------------------------------ */
/* Formato do token                                                    */
/* ------------------------------------------------------------------ */

export interface TokenInfo {
  formato: "jwt" | "opaco";
  /** epoch ms — presente só em JWT com `exp` numérico. */
  exp: number | null;
  iat: number | null;
  /** `exp - iat` em segundos: o TTL configurado pela Sinqia. */
  ttlSegundos: number | null;
}

/** base64url → JSON, tolerante a padding ausente. Nunca lança. */
function decodeSegment(seg: string): Record<string, unknown> | null {
  try {
    const b64 = seg.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const json = Buffer.from(padded, "base64").toString("utf8");
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Descobre se o token é JWT e, se for, extrai `exp`/`iat`.
 *
 * Ler claims NÃO exige o segredo (só validar a assinatura exigiria) — por isso
 * dá para saber o tempo de vida exato quando a Sinqia emite JWT. Token opaco:
 * não há como deduzir a validade; aí valem só os limites locais + reação ao 401.
 *
 * Defensivo por contrato: qualquer desvio devolve "opaco" em vez de lançar.
 */
export function describeToken(token: string): TokenInfo {
  const opaco: TokenInfo = { formato: "opaco", exp: null, iat: null, ttlSegundos: null };
  if (!token) return opaco;

  const partes = token.replace(/^Bearer\s+/i, "").split(".");
  if (partes.length !== 3) return opaco;

  const payload = decodeSegment(partes[1]);
  if (!payload) return opaco;

  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const expSeg = num(payload.exp);
  const iatSeg = num(payload.iat);

  // Um JWT sem `exp` é JWT, mas não diz a validade.
  return {
    formato: "jwt",
    exp: expSeg !== null ? expSeg * 1000 : null,
    iat: iatSeg !== null ? iatSeg * 1000 : null,
    ttlSegundos: expSeg !== null && iatSeg !== null ? expSeg - iatSeg : null,
  };
}

/* ------------------------------------------------------------------ */
/* Store                                                              */
/* ------------------------------------------------------------------ */

const sessions = new Map<string, Session>();

export function createSession(username: string, token: string, agora = Date.now()): Session {
  // 32 bytes de entropia: o id é credencial de acesso, não identificador.
  const id = randomBytes(32).toString("hex");
  const { exp } = describeToken(token);
  const session: Session = {
    id,
    username,
    token,
    tokenExp: exp,
    createdAt: agora,
    lastSeenAt: agora,
  };
  sessions.set(id, session);
  return session;
}

export type ResultadoSessao =
  | { ok: true; session: Session }
  | { ok: false; motivo: MotivoInvalida };

/**
 * Recupera e valida a sessão, renovando a janela de inatividade.
 *
 * `agora` é injetável para os testes offline — sem isso não daria para exercitar
 * expiração sem esperar 30 minutos.
 */
export function getSession(
  id: string | undefined,
  agora = Date.now(),
): ResultadoSessao {
  if (!id) return { ok: false, motivo: "inexistente" };
  const s = sessions.get(id);
  if (!s) return { ok: false, motivo: "inexistente" };

  if (agora - s.lastSeenAt > IDLE_MS) {
    sessions.delete(id);
    return { ok: false, motivo: "inatividade" };
  }
  if (agora - s.createdAt > ABSOLUTE_MS) {
    sessions.delete(id);
    return { ok: false, motivo: "limite" };
  }
  if (s.tokenExp !== null && agora >= s.tokenExp) {
    sessions.delete(id);
    return { ok: false, motivo: "token" };
  }

  s.lastSeenAt = agora;
  return { ok: true, session: s };
}

export function destroySession(id: string | undefined): void {
  if (id) sessions.delete(id);
}

/** Quantas sessões vivas — usado nos testes e em diagnóstico. */
export function contarSessoes(): number {
  return sessions.size;
}

/** Só para os testes: garante ponto de partida limpo. */
export function limparSessoes(): void {
  sessions.clear();
}

/**
 * Dados da sessão que podem ir para o browser.
 * O token NÃO entra aqui — ele nunca sai do backend.
 */
export function sessionPublica(s: Session, agora = Date.now()) {
  const info = describeToken(s.token);
  const expiraPorInatividade = s.lastSeenAt + IDLE_MS;
  const expiraPorLimite = s.createdAt + ABSOLUTE_MS;
  // A sessão morre no primeiro dos três prazos.
  const prazos = [expiraPorInatividade, expiraPorLimite];
  if (s.tokenExp !== null) prazos.push(s.tokenExp);
  const expiraEm = Math.min(...prazos);

  return {
    username: s.username,
    tokenFormato: info.formato,
    tokenTtlSegundos: info.ttlSegundos,
    tokenExpiraEm: s.tokenExp,
    expiraEm,
    restanteMs: Math.max(0, expiraEm - agora),
    idleMs: IDLE_MS,
    absolutoMs: ABSOLUTE_MS,
  };
}

export type SessionPublica = ReturnType<typeof sessionPublica>;

/** Varredura periódica: não deixa sessão morta ocupando memória. */
const sweeper = setInterval(() => {
  const agora = Date.now();
  for (const [id, s] of sessions) {
    const expirou =
      agora - s.lastSeenAt > IDLE_MS ||
      agora - s.createdAt > ABSOLUTE_MS ||
      (s.tokenExp !== null && agora >= s.tokenExp);
    if (expirou) sessions.delete(id);
  }
}, 60_000);
// Não segura o processo vivo.
sweeper.unref();
