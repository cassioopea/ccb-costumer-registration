import { z } from "zod";

/**
 * Enums recorrentes do modelo Sinqia (BJ21M05).
 * Fonte: modelo Swagger + payloads validados na API (Postman collection).
 *
 * Regra geral: os campos que usam esses enums são OPCIONAIS no schema.
 * O enum só valida o valor QUANDO ele é enviado. "Na dúvida, deixar opcional"
 * (orientação BRQ) — mas quando o valor existe, ele precisa ser um dos aceitos.
 */

/** Ação sobre um objeto/array: Incluir / Alterar / Excluir / Consultar. Cadastro novo = "IN". */
export const idAcaoEnum = z.enum(["IN", "AL", "EX", "CO"]);
export type IdAcao = z.infer<typeof idAcaoEnum>;

/** Rótulos das ações para a UI (mesma ordem do enum). */
export const IDACAO_LABELS: Record<IdAcao, string> = {
  IN: "Incluir (cadastro novo)",
  AL: "Alterar (atualizar cadastro existente)",
  EX: "Excluir (remover cadastro)",
  CO: "Consultar (somente leitura)",
};

/**
 * idIntegracaoCadastro: "S" integra automaticamente com o módulo de cadastro,
 * "N" não integra. Trafega como STRING no nível raiz do request.
 */
export const idIntegracaoCadastroEnum = z.enum(["S", "N"]);
export type IdIntegracaoCadastro = z.infer<typeof idIntegracaoCadastroEnum>;

/** Tipo de relação de trabalho (dadosProfissionais). */
export const tpRelacaoTrabEnum = z.enum(["C", "T", "E", "S", "A", "O"]);

/** Capital da empresa (dadosPj): Nacional / Estrangeiro / Misto. Vem como STRING. */
export const cdCapitalEnum = z.enum(["N", "E", "M"]);

/** Tipo de sócio (socios[], PJ). */
export const tpSocioEnum = z.enum([
  "F", "J", "P", "R", "A", "G", "C", "T", "O", "D", "M", "I", "SA", "BF", "DI",
]);

/**
 * Enums numéricos. Modelados como number literal unions.
 * `cdSetor` (dadosPj), `idGrinst`/`idEtnia` (dadosPf), `idConsti` (dadosPj).
 */
export const cdSetorEnum = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);

export const idGrinstEnum = z.union([
  z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5),
  z.literal(6), z.literal(7), z.literal(8), z.literal(9), z.literal(10),
]);

export const idEtniaEnum = z.union([
  z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6),
]);

export const idConstiEnum = z.union([
  z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6),
  z.literal(7), z.literal(8), z.literal(9), z.literal(10), z.literal(11),
]);

/** idContAcio: vem como STRING no payload validado ("1"). Enum [1,2] do modelo → strings. */
export const idContAcioEnum = z.enum(["1", "2"]);

/**
 * idUniao (união estável, dadosPf): aceita "1" (Sim) ou "2" (Não).
 * Confirmado por mensagem de consistência da Sinqia em HML
 * ("Indicador de união estável inválido... Valores aceitos: 1 (Sim), 2 (Não)").
 */
export const idUniaoEnum = z.enum(["1", "2"]);

/** step do cadastro: "FI" finaliza e envia ao Motor de Crédito. */
export const stepEnum = z.enum(["FI"]);
