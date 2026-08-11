import { normalizarLogin, ROTULO_TIPO_ACAO, type TipoAcaoSod } from "@cadastro-lote/shared";
import { env } from "./../env.js";
import { abrirBancoSod, criarSodRepositorio } from "./repositorio.js";
import { criarSodServico } from "./dominio.js";
import { CHAVE_APROVACAO, resolverTipoComFlag, TIPOS_COM_FLAG } from "./flags.js";

/**
 * Esteira de Aprovação (SoD) — CLI operacional das feature flags (US-05).
 *
 * SEM tela de gestão (RN03): este script é o ÚNICO caminho de mudança. Grava
 * na mesma base que o servidor lê em runtime — a mudança vale na requisição
 * seguinte, sem restart. Toda mudança EFETIVA gera evento `flag_alterada` na
 * trilha de auditoria (RN05), com o login informado em --por.
 *
 * Uso (no workspace apps/api, respeitando o .env ativo):
 *   npm run sod:flag -- status
 *   npm run sod:flag -- <tipo|chave> <on|off> --por <login>
 *
 * Exemplos:
 *   npm run sod:flag -- tomador.cadastrar on --por cassio.barbosa
 *   npm run sod:flag -- aprovacao.criacao_proposta_individual off --por cassio.barbosa
 *
 * MIGRATION-NOTE: o script abre o SQLite local (env.SQLITE_PATH). No
 * PostgreSQL/Docker ele passa a conectar pela connection string do serviço e
 * roda de dentro do contêiner (docker exec) ou de um host com acesso ao banco
 * — a semântica (upsert + auditoria transacional) não muda.
 */

function uso(mensagem?: string): never {
  if (mensagem) console.error(`ERRO: ${mensagem}\n`);
  console.error(
    [
      "Uso:",
      "  npm run sod:flag -- status",
      "  npm run sod:flag -- <tipo|chave> <on|off> --por <login>",
      "",
      "Tipos com flag (Onda 1):",
      ...TIPOS_COM_FLAG.map((t) => `  ${t}  (chave: ${CHAVE_APROVACAO[t]})`),
    ].join("\n"),
  );
  process.exit(1);
}

/** Comando já validado — toda falha de uso acontece ANTES de abrir o banco. */
type Comando =
  | { acao: "status" }
  | { acao: "definir"; tipo: TipoAcaoSod; ativa: boolean; ator: string };

function parseArgs(args: string[]): Comando {
  if (args.length === 0) uso();
  if (args[0] === "status") return { acao: "status" };

  const tipo = resolverTipoComFlag(args[0]);
  if (!tipo) uso(`"${args[0]}" não é um tipo com flag nesta fase.`);

  const valor = (args[1] ?? "").trim().toLowerCase();
  if (valor !== "on" && valor !== "off") uso(`Informe "on" ou "off" (recebi "${args[1] ?? ""}").`);

  const idxPor = args.indexOf("--por");
  const ator = idxPor >= 0 ? normalizarLogin(args[idxPor + 1] ?? "") : "";
  if (!ator) uso("--por <login> é obrigatório: a mudança de flag é auditada (RN05).");

  return { acao: "definir", tipo, ativa: valor === "on", ator };
}

const comando = parseArgs(process.argv.slice(2));

const db = abrirBancoSod(env.SQLITE_PATH);
try {
  const servico = criarSodServico(criarSodRepositorio(db, env.SINQIA_ENV));

  if (comando.acao === "status") {
    const registradas = new Map(servico.listarFlags().map((f) => [f.tipo, f]));
    console.log(`Flags da Esteira de Aprovação — ambiente ${env.SINQIA_ENV.toUpperCase()}`);
    for (const tipo of TIPOS_COM_FLAG) {
      const f = registradas.get(tipo);
      const estado = f?.ativa ? "ATIVA" : "inativa";
      const quando = f ? ` (última mudança: ${f.atualizadoEm})` : " (padrão — nunca alterada)";
      console.log(`  ${tipo.padEnd(24)} ${estado}${quando}`);
    }
  } else {
    const { tipo, ativa, ator } = comando;
    const r = servico.definirFlag(tipo, ativa, ator);
    const rotulo = ROTULO_TIPO_ACAO[tipo];
    if (!r.mudou) {
      console.log(
        `Sem mudança: "${rotulo}" (${tipo}) já estava ${ativa ? "ATIVA" : "inativa"} no ambiente ` +
          `${env.SINQIA_ENV.toUpperCase()} — nada gravado, nada auditado (RN05: só mudança efetiva).`,
      );
    } else {
      console.log(
        `Flag alterada: "${rotulo}" (${tipo}) ${r.anterior ? "ATIVA" : "inativa"} → ` +
          `${ativa ? "ATIVA" : "inativa"} no ambiente ${env.SINQIA_ENV.toUpperCase()}, por ${ator}. ` +
          `Mudança auditada; vale na próxima requisição (sem restart).`,
      );
    }
  }
} finally {
  db.close();
}
