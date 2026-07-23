import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { env } from "./env.js";
import { registerRoutes } from "./routes.js";

async function main() {
  const app = Fastify({
    logger: {
      level: "info",
      // Redação de segurança: nunca logar credenciais/token.
      redact: {
        paths: [
          "req.headers.authorization",
          'req.headers["proxy-authorization"]',
          "password",
          "token",
        ],
        censor: "***",
      },
    },
    // O log padrão do Fastify registra req/res mas NÃO o corpo (multipart não vaza).
    // A redação acima cobre os headers de Authorization.
  });

  await app.register(cors, {
    origin: env.WEB_ORIGIN,
    methods: ["GET", "POST"],
  });

  await app.register(multipart, {
    limits: {
      fileSize: 25 * 1024 * 1024, // 25 MB
      files: 1,
    },
  });

  await registerRoutes(app);

  try {
    await app.listen({ port: env.PORT, host: "127.0.0.1" });
    app.log.info(
      `API pronta em http://127.0.0.1:${env.PORT} — ambiente ${env.SINQIA_ENV.toUpperCase()} (${env.SINQIA_BASE_URL})`,
    );
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

void main();
