import { z } from "zod";

/**
 * Envelope de resposta da API Sinqia.
 *
 * CRÍTICO: HTTP 200 NÃO garante sucesso. É preciso inspecionar `status`,
 * `globalMessage` e `messages[]` para decidir OK/ERRO por linha.
 */
export const sinqiaMessageSchema = z
  .object({
    message: z.string().optional(),
    source: z.string().optional(),
    type: z.string().optional(),
  })
  .passthrough();

export type SinqiaMessage = z.infer<typeof sinqiaMessageSchema>;

export const sinqiaEnvelopeSchema = z
  .object({
    className: z.string().optional(),
    globalMessage: z.string().optional(),
    id: z.number().optional(),
    messages: z.array(sinqiaMessageSchema).optional(),
    status: z.string().optional(),
    timestamp: z.string().optional(),
  })
  .passthrough();

export type SinqiaEnvelope = z.infer<typeof sinqiaEnvelopeSchema>;

/** Tipos de mensagem que reprovam o cadastro. Ajustável conforme comportamento real. */
const ERROR_MESSAGE_TYPES = new Set(["E", "ERROR", "ERRO", "F", "FATAL"]);

/**
 * Valores de `status` do envelope que indicam sucesso confirmado.
 * "OK" observado em cadastro real bem-sucedido em HML (globalMessage
 * "Cadastro do cliente salvo/atualizado com sucesso.", messages type "Sucesso").
 */
const SUCCESS_ENVELOPE_STATUS = new Set(["OK"]);

/**
 * Resultado da análise do envelope: decide OK/ERRO e coleta as mensagens.
 */
export interface EnvelopeAnalysis {
  ok: boolean;
  /** status do envelope (string, ex. "100"). */
  envelopeStatus?: string;
  globalMessage?: string;
  /** Mensagens de consistência concatenadas para o relatório. */
  messagesText: string;
  messages: SinqiaMessage[];
  /** Motivo derivado quando ok=false. */
  reason?: string;
}

/**
 * Analisa o envelope + status HTTP e decide se a linha foi SUCESSO ou FALHA.
 *
 * Heurística (conservadora — na dúvida, marca ERRO para o operador revisar):
 *  1. HTTP fora de 2xx → ERRO.
 *  2. Presença de mensagens com type de erro (E/ERROR/...) → ERRO.
 *  3. globalMessage que aparente erro → ERRO.
 *  4. Caso contrário → OK.
 *
 * `status` do envelope é sempre registrado no relatório, mesmo sem regra fixa
 * (o valor "100" observado ainda não tem semântica documentada pela Sinqia).
 */
export function analyzeEnvelope(
  httpStatus: number,
  envelope: SinqiaEnvelope | null | undefined,
): EnvelopeAnalysis {
  const messages = envelope?.messages ?? [];
  const messagesText = messages
    .map((m) => {
      const parts = [m.type, m.source, m.message].filter(Boolean);
      return parts.join(" | ");
    })
    .filter(Boolean)
    .join(" ;; ");

  const base: Omit<EnvelopeAnalysis, "ok" | "reason"> = {
    envelopeStatus: envelope?.status,
    globalMessage: envelope?.globalMessage,
    messagesText,
    messages,
  };

  if (httpStatus < 200 || httpStatus >= 300) {
    return { ...base, ok: false, reason: `HTTP ${httpStatus}` };
  }

  // Sinal positivo confirmado: status "OK" = registro salvo (comportamento real HML).
  const st = (envelope?.status ?? "").trim().toUpperCase();
  if (SUCCESS_ENVELOPE_STATUS.has(st)) {
    return { ...base, ok: true };
  }

  const hasErrorTyped = messages.some(
    (m) => m.type && ERROR_MESSAGE_TYPES.has(m.type.trim().toUpperCase()),
  );
  if (hasErrorTyped) {
    return { ...base, ok: false, reason: "Mensagem de consistência de erro" };
  }

  const gm = (envelope?.globalMessage ?? "").toLowerCase();
  if (gm && /(erro|inconsist|inv[aá]lid|falh|reprov|n[aã]o foi poss)/.test(gm)) {
    return { ...base, ok: false, reason: `globalMessage: ${envelope?.globalMessage}` };
  }

  return { ...base, ok: true };
}
