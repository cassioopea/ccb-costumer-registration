/**
 * @homolog — Smoke de ambiente e conectividade (checkpoint A).
 *
 * 1. Confirma que o BFF aponta para HOMOLOGAÇÃO (env=hml, host hml, BJ21M05).
 *    Qualquer indício de produção ABORTA antes de qualquer login.
 * 2. Autentica os operadores A e B na Sinqia (janela comercial aberta).
 *
 * Os logins nunca aparecem: toda saída passa por `redigir` (<OPERADOR_A/B>).
 */
import { API, get, loginAmbos, evidencia, agora, log } from "./lib.mjs";

const health = await (await fetch(`${API}/api/health`)).json();
const envInfo = await (await fetch(`${API}/api/env`)).json();

const base = String(health.baseUrl ?? "");
const ehHml = health.env === "hml" && envInfo.isProd === false && /hml/i.test(base);
if (!ehHml) {
  console.error("ABORTADO — o BFF não está apontando para homologação.");
  console.error(JSON.stringify({ env: health.env, isProd: envInfo.isProd, baseUrl: base }, null, 2));
  process.exit(2);
}
log(`Ambiente CONFIRMADO: env=${health.env} isProd=${envInfo.isProd} baseUrl=${base}`);

const logins = await loginAmbos();
for (const perfil of ["A", "B"]) {
  const r = logins[perfil];
  log(
    `login ${perfil} (var SINQIA_HOMOLOG_USER_${perfil}): HTTP ${r.status} ` +
      `${r.ok ? "OK" : "FALHOU"} — token ${r.tokenFormato ?? "-"}` +
      (r.tokenTtlSegundos ? ` TTL ${r.tokenTtlSegundos}s (~${Math.round(r.tokenTtlSegundos / 60)} min)` : "") +
      (r.erro ? ` — ${r.erro}` : ""),
  );
}

const distintos =
  logins.A.ok &&
  logins.B.ok &&
  logins.A.username?.trim().toLowerCase() !== logins.B.username?.trim().toLowerCase();
log(`operadores distintos (maker-checker viável): ${distintos ? "SIM" : "NÃO"}`);

// Sessão viva de cada um (prova que as duas jars de cookie funcionam).
const sessaoA = await get("A", "/api/session");
const sessaoB = await get("B", "/api/session");
log(`GET /api/session A=${sessaoA.status} B=${sessaoB.status}`);

const arquivo = evidencia("00-smoke-ambiente", {
  quando: agora(),
  ambiente: { env: health.env, isProd: envInfo.isProd, baseUrl: base },
  flagsNoMomentoDoSmoke: envInfo.aprovacao,
  logins: { A: logins.A, B: logins.B },
  operadoresDistintos: distintos,
  sessaoRehidratada: {
    A: { status: sessaoA.status, username: sessaoA.json?.username ?? null },
    B: { status: sessaoB.status, username: sessaoB.json?.username ?? null },
  },
});
log(`evidência: ${arquivo}`);
process.exit(logins.A.ok && logins.B.ok && distintos ? 0 : 1);
