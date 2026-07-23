import { request } from "undici";
import {
  analyzeEnvelope,
  sinqiaEnvelopeSchema,
  type CadastrarClienteRequest,
  type EnvelopeAnalysis,
  type SinqiaEnvelope,
} from "@cadastro-lote/shared";
import { env, loginUrl, cadastroUrl } from "./env.js";

/**
 * Cliente HTTP da API Sinqia (BJ21M05).
 *
 * Fluxo de 2 passos:
 *  1. GET /user com Basic Auth → o token volta no HEADER de resposta "Auth".
 *  2. POST /cadastrarCliente com Bearer <token>.
 *
 * SEGURANÇA:
 *  - Credenciais recebidas por parâmetro, usadas só na sessão, nunca logadas.
 *  - Token nunca é logado por completo (só um prefixo mascarado, se necessário).
 */

export class SinqiaAuthError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
  ) {
    super(message);
    this.name = "SinqiaAuthError";
  }
}

/** Faz login e devolve o token lido do header "Auth". */
export async function login(username: string, password: string): Promise<string> {
  const basic = Buffer.from(`${username}:${password}`).toString("base64");

  const res = await request(loginUrl(), {
    method: "GET",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/json",
    },
    headersTimeout: env.REQUEST_TIMEOUT_MS,
    bodyTimeout: env.REQUEST_TIMEOUT_MS,
  });

  // Drena o body para liberar a conexão (não precisamos do conteúdo).
  await res.body.text().catch(() => undefined);

  if (res.statusCode === 401 || res.statusCode === 403) {
    throw new SinqiaAuthError(
      "Login recusado (usuário/senha inválidos ou sem permissão).",
      res.statusCode,
    );
  }
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new SinqiaAuthError(
      `Falha no login (HTTP ${res.statusCode}). Verifique VPN/host/credenciais.`,
      res.statusCode,
    );
  }

  // Header case-insensitive; undici entrega em minúsculas.
  const authHeader = res.headers["auth"];
  const token = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  if (!token) {
    throw new SinqiaAuthError(
      "Login OK, mas o header 'Auth' não veio na resposta. Contate a Sinqia/BRQ.",
      res.statusCode,
    );
  }
  return token;
}

export interface CadastroResult {
  httpStatus: number;
  envelope: SinqiaEnvelope | null;
  analysis: EnvelopeAnalysis;
  /** Corpo bruto quando não foi possível parsear o envelope. */
  rawBody?: string;
}

/** Envia UMA requisição de cadastro. Não faz retry aqui (a orquestração cuida). */
export async function cadastrarCliente(
  token: string,
  body: CadastrarClienteRequest,
): Promise<CadastroResult> {
  const res = await request(cadastroUrl(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    headersTimeout: env.REQUEST_TIMEOUT_MS,
    bodyTimeout: env.REQUEST_TIMEOUT_MS,
  });

  const text = await res.body.text().catch(() => "");
  let envelope: SinqiaEnvelope | null = null;
  let rawBody: string | undefined;

  if (text) {
    try {
      const json = JSON.parse(text);
      const parsed = sinqiaEnvelopeSchema.safeParse(json);
      envelope = parsed.success ? parsed.data : (json as SinqiaEnvelope);
    } catch {
      rawBody = text.slice(0, 2000);
    }
  }

  const analysis = analyzeEnvelope(res.statusCode, envelope);
  return { httpStatus: res.statusCode, envelope, analysis, rawBody };
}

/** Erro de token expirado (HTTP 401) para a orquestração decidir relogar. */
export class TokenExpiredError extends Error {
  constructor() {
    super("Token expirado (HTTP 401).");
    this.name = "TokenExpiredError";
  }
}
