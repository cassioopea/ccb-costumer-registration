import { config as loadDotenv } from "dotenv";
import { z } from "zod";

// Carrega .env do diretório do app (apps/api/.env).
loadDotenv();

const envSchema = z.object({
  SINQIA_ENV: z.enum(["hml", "prod"]).default("hml"),
  SINQIA_BASE_URL: z
    .string({ required_error: "SINQIA_BASE_URL é obrigatória (host da Sinqia — ver .env.example)" })
    .url("SINQIA_BASE_URL deve ser uma URL válida"),
  SINQIA_LOGIN_PATH: z.string().default("/BJ21M05/user"),
  SINQIA_CADASTRO_PATH: z
    .string()
    .default("/BJ21M05/BJ21M05/BJ21SS0501F/cadastrarCliente"),
  /**
   * Rotas de situação de cliente. O Swagger mostra os paths como `/v1/cliente` e
   * `/situacao/alterar-situacao-cliente`; o prefixo do módulo segue o padrão do
   * login (`/BJ21M05/user`) mas NÃO foi confirmado contra a API real — por isso
   * ficam sobrescrevíveis por env.
   */
  SINQIA_CLIENTES_PATH: z.string().default("/BJ21M05/v1/cliente"),
  SINQIA_SITUACAO_PATH: z
    .string()
    .default("/BJ21M05/situacao/alterar-situacao-cliente"),
  /**
   * Campos obrigatórios do cadastro. O Swagger exibe
   * `/BJ21M05/BJ21SS0501F/consultarCamposObrigatorios`; somando o context root
   * `/BJ21M05` (mesmo padrão do login `/user` → `/BJ21M05/user` e do
   * cadastrarCliente) chega-se ao path abaixo.
   */
  SINQIA_CAMPOS_OBRIG_PATH: z
    .string()
    .default("/BJ21M05/BJ21M05/BJ21SS0501F/consultarCamposObrigatorios"),
  /**
   * Módulo Propostas (Esteira de Originação). Paths extraídos da collection
   * gravada do Portal de Crédito — usados a partir da Fase 2 (cálculo).
   */
  SINQIA_CALCPROSP_PATH: z
    .string()
    .default("/BJ21M05/BJ21M05/BJ21SS0501C/calcProsp"),
  SINQIA_PRIMEIRO_VENC_PATH: z
    .string()
    .default("/BJ21M05/v1/calculos/primeiro-vencimento"),
  SINQIA_PROPOSTA_PATH: z
    .string()
    .default("/BJ21M05/BJ21M05/BJ21SS0501H/cadastrarProposta"),
  /** buscarCliente: o parâmetro `nrClient` recebe o CPF (nome engana). */
  SINQIA_BUSCAR_CLIENTE_PATH: z
    .string()
    .default("/BJ21M05/BJ21M05/BJ21SS0502J/buscarCliente"),
  /**
   * Step do workflow enviado no cadastrarProposta. "GA" é o observado no
   * payload gravado que funcionou no Portal de Crédito. // [a validar] qual
   * step deixa a proposta em "Contrato em Assinatura" — ajustável sem código.
   */
  SINQIA_PROPOSTA_STEP: z.string().default("GA"),
  /** Consulta de propostas por cliente e detalhe da proposta. */
  SINQIA_PROPOSTAS_CPF_PATH: z
    .string()
    .default("/BJ21M05/BJ21M05/BJ21SS0501E/consultarPropostasPorCpfcnpj"),
  SINQIA_DADOS_PROPOSTA_PATH: z
    .string()
    .default("/BJ21M05/BJ21M05/BJ21SS0502Z/consultarDadosProposta"),
  /**
   * Lookups de tela — os MESMOS endpoints que o Portal de Crédito usa
   * (confirmado na gravação do DevTools): convênios por classificação (C e P),
   * filiais por convênio, e produtos filtrados por característica + convênio.
   * O /v1/convenios/producao (tentativa anterior) não traz todos os convênios.
   */
  SINQIA_PRODUTOS_PATH: z
    .string()
    .default("/BJ21M05/BJ21M05/BJ21SS0502J/consultarProdutosGeral"),
  SINQIA_CONVENIOS_PATH: z
    .string()
    .default("/BJ21M05/BJ21M05/BJ21SS0501D/consultarConvenioEmprestimosPorTpClacv"),
  SINQIA_FILIAIS_PATH: z
    .string()
    .default("/BJ21M05/BJ21M05/BJ21SS0501P/consultarFilialByCdConv"),
  /**
   * Painel de propostas — endpoints que o Portal usa (gravação DevTools de
   * 2026-08-06): listagem geral com filtros/cursor, histórico da proposta e
   * filas do workflow com contagem.
   */
  SINQIA_PAINEL_PATH: z
    .string()
    .default("/BJ21M05/BJ21M05/BJ21SS0501E/consultarPropostaPainel"),
  SINQIA_HISTORICO_PROPOSTA_PATH: z
    .string()
    .default("/BJ21M05/BJ21M05/BJ21SS0501E/consultarHistoricoProposta"),
  SINQIA_STATUS_WF_PATH: z
    .string()
    .default("/BJ21M05/BJ21M05/BJ21SS0502O/consultarStatusWf"),
  /** Transferência de status: destinos permitidos + o movimento em si. */
  SINQIA_STATUS_TRANSF_PATH: z
    .string()
    .default("/BJ21M05/BJ21M05/BJ21SS0502X/consultarStatusTransf"),
  SINQIA_TRANSF_STATUS_PATH: z
    .string()
    .default("/BJ21M05/BJ21M05/BJ21SS0502L/transfStatus"),
  /**
   * Instituição/agência do workflow (consultarStatusWf). Preferimos os claims
   * do JWT do login; estes valores são o fallback (observados no Portal — a
   * instituição Opea é a mesma em HML e produção).
   */
  SINQIA_NR_INST: z.coerce.number().int().default(1309),
  SINQIA_NR_AGEN: z.coerce.number().int().default(19),
  /**
   * Esteira de Aprovação (SoD) — toggle da chave
   * `aprovacao.cadastro_tomador_individual` (US-02, RN05): com "1"/"true", o
   * cadastro individual de tomador cria requisição pendente em vez de chamar
   * a Sinqia. DESLIGADO por padrão. A interpretação do valor vive em
   * sod/flags.ts; vira feature flag definitiva (com auditoria) na US-05.
   */
  APROVACAO_CADASTRO_TOMADOR_INDIVIDUAL: z.string().default("0"),
  /** Base local (SQLite embutido) — métricas, eventos e futuras aprovações. */
  SQLITE_PATH: z.string().default("./data/esteira.db"),
  PORT: z.coerce.number().int().positive().default(3333),
  WEB_ORIGIN: z.string().default("http://localhost:5173"),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  RETRY_COUNT: z.coerce.number().int().min(0).max(5).default(1),
});

function loadEnv() {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    // Falha rápida com mensagem clara.
    console.error("❌ Configuração de ambiente inválida:\n" + issues);
    process.exit(1);
  }
  return parsed.data;
}

export const env = loadEnv();

/** Monta a URL final de forma centralizada — nada concatenado à mão pelo código. */
export function sinqiaUrl(path: string): string {
  const base = env.SINQIA_BASE_URL.replace(/\/+$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;
  return base + p;
}

export const loginUrl = () => sinqiaUrl(env.SINQIA_LOGIN_PATH);
export const cadastroUrl = () => sinqiaUrl(env.SINQIA_CADASTRO_PATH);
export const clientesUrl = () => sinqiaUrl(env.SINQIA_CLIENTES_PATH);
export const situacaoUrl = () => sinqiaUrl(env.SINQIA_SITUACAO_PATH);
export const camposObrigatoriosUrl = () => sinqiaUrl(env.SINQIA_CAMPOS_OBRIG_PATH);
export const calcProspUrl = () => sinqiaUrl(env.SINQIA_CALCPROSP_PATH);
export const buscarClienteUrl = () => sinqiaUrl(env.SINQIA_BUSCAR_CLIENTE_PATH);
export const produtosUrl = () => sinqiaUrl(env.SINQIA_PRODUTOS_PATH);
export const propostasPorCpfUrl = () => sinqiaUrl(env.SINQIA_PROPOSTAS_CPF_PATH);
export const dadosPropostaUrl = () => sinqiaUrl(env.SINQIA_DADOS_PROPOSTA_PATH);
export const conveniosUrl = () => sinqiaUrl(env.SINQIA_CONVENIOS_PATH);
export const filiaisUrl = () => sinqiaUrl(env.SINQIA_FILIAIS_PATH);
export const painelUrl = () => sinqiaUrl(env.SINQIA_PAINEL_PATH);
export const historicoPropostaUrl = () => sinqiaUrl(env.SINQIA_HISTORICO_PROPOSTA_PATH);
export const statusWfUrl = () => sinqiaUrl(env.SINQIA_STATUS_WF_PATH);
export const statusTransfUrl = () => sinqiaUrl(env.SINQIA_STATUS_TRANSF_PATH);
export const transfStatusUrl = () => sinqiaUrl(env.SINQIA_TRANSF_STATUS_PATH);
export const primeiroVencimentoUrl = () => sinqiaUrl(env.SINQIA_PRIMEIRO_VENC_PATH);
export const propostaUrl = () => sinqiaUrl(env.SINQIA_PROPOSTA_PATH);

export const isProd = () => env.SINQIA_ENV === "prod";
