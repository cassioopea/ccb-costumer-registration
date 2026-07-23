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

export const isProd = () => env.SINQIA_ENV === "prod";
