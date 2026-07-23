import { z } from "zod";
import { clienteSchema } from "./cliente.schema.js";
import { stepEnum } from "./enums.js";

/**
 * Request completo do endpoint `cadastrarCliente`.
 *
 * Estrutura: { cliente: {...}, idBiometria, idIntegracaoCadastro,
 *              idOrigemRequest, idRetConsistencias, step }
 *
 * Os campos de controle ficam no NÍVEL RAIZ (fora de `cliente`) e são TODOS
 * opcionais — o payload PF validado em HML não envia nenhum deles e funciona.
 *  - idIntegracaoCadastro: ex. "N" — integra independente de consistência.
 *  - idRetConsistencias: flag que indica se retorna mensagens de consistência.
 *  - step: "FI" finaliza e envia ao Motor de Crédito (configurável por lote).
 */
export const cadastrarClienteRequestSchema = z.object({
  cliente: clienteSchema,
  idBiometria: z.string().optional(),
  idIntegracaoCadastro: z.string().optional(),
  idOrigemRequest: z.string().optional(),
  idRetConsistencias: z.string().optional(),
  step: z.union([stepEnum, z.string()]).optional(),
});

export type CadastrarClienteRequest = z.infer<typeof cadastrarClienteRequestSchema>;

/**
 * Opções de controle do lote, aplicadas a TODAS as linhas na montagem do request.
 * A UI expõe essas escolhas; o backend as injeta no nível raiz de cada request.
 */
export const batchControlSchema = z.object({
  /** Enviar "FI" para finalizar e mandar ao Motor de Crédito. Default: não finalizar. */
  finalizar: z.boolean().default(false),
  idIntegracaoCadastro: z.string().optional(),
  idRetConsistencias: z.string().optional(),
  idBiometria: z.string().optional(),
  idOrigemRequest: z.string().optional(),
});

export type BatchControl = z.infer<typeof batchControlSchema>;
