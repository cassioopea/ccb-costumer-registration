import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { env } from "./env.js";

/**
 * Base LOCAL da aplicação (SQLite embutido, node:sqlite — zero dependência).
 *
 * Papel: persistir o que a Sinqia não devolve depois (valores exatos no
 * momento da criação) e os EVENTOS do sistema (trilha para logs e, no futuro,
 * aprovações de requisição).
 *
 * MIGRAÇÃO FUTURA PARA POSTGRES (projeto já previsto): o SQL daqui é
 * deliberadamente portável — tipos TEXT/INTEGER/REAL, timestamps ISO-8601 em
 * TEXT, sem pragmas exóticos — e todo acesso passa por estas funções; trocar
 * o driver é um trabalho contido neste arquivo.
 *
 * Falha de banco NUNCA derruba o fluxo de negócio: quem grava usa try/catch
 * e segue em frente (a Sinqia é a fonte da verdade; a base local é apoio).
 */

const caminho = path.resolve(env.SQLITE_PATH);
mkdirSync(path.dirname(caminho), { recursive: true });

const db = new DatabaseSync(caminho);
db.exec("PRAGMA journal_mode = WAL;");

db.exec(`
  CREATE TABLE IF NOT EXISTS propostas_criadas (
    ambiente   TEXT    NOT NULL,
    nr_prosp   INTEGER NOT NULL,
    cpf        TEXT    NOT NULL,
    nome       TEXT    NOT NULL DEFAULT '',
    cd_conv    TEXT,
    cd_prod    INTEGER,
    vl_finan   REAL,
    vl_liquid  REAL,
    vl_tac     REAL,
    vl_presta  REAL,
    qt_prest   INTEGER,
    origem     TEXT    NOT NULL,
    criado_em  TEXT    NOT NULL,
    PRIMARY KEY (ambiente, nr_prosp)
  );

  CREATE TABLE IF NOT EXISTS eventos (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    ts       TEXT NOT NULL,
    ambiente TEXT NOT NULL,
    usuario  TEXT NOT NULL DEFAULT '',
    tipo     TEXT NOT NULL,
    detalhe  TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS idx_eventos_tipo_ts ON eventos (tipo, ts);

  -- Persona dos clientes. A REGRA é: PF = tomador, PJ = não-tomador; esta
  -- tabela guarda só as EXCEÇÕES marcadas pelo operador (PJ promovida a
  -- tomadora, ou PF despromovida). A Sinqia não tem esse conceito.
  CREATE TABLE IF NOT EXISTS personas (
    ambiente      TEXT    NOT NULL,
    documento     TEXT    NOT NULL,
    tp_pessoa     TEXT    NOT NULL,
    tomador       INTEGER NOT NULL,
    usuario       TEXT    NOT NULL DEFAULT '',
    atualizado_em TEXT    NOT NULL,
    PRIMARY KEY (ambiente, documento)
  );

  -- Onboarding POR USUÁRIO: se já viu/concluiu o tour, itens do checklist
  -- marcados e hints dispensados. Estado na base (não no browser) para valer
  -- entre navegadores; cross-machine de verdade chega com o Postgres central.
  CREATE TABLE IF NOT EXISTS onboarding_estado (
    ambiente          TEXT NOT NULL,
    usuario           TEXT NOT NULL,
    tour_concluido    INTEGER NOT NULL DEFAULT 0,
    checklist_itens   TEXT NOT NULL DEFAULT '{}',
    hints_dispensados TEXT NOT NULL DEFAULT '[]',
    atualizado_em     TEXT NOT NULL,
    PRIMARY KEY (ambiente, usuario)
  );
`);

export interface PropostaCriadaRegistro {
  nrProsp: number;
  cpf: string;
  nome: string;
  cdConv: string | null;
  cdProd: number | null;
  vlFinan: number | null;
  vlLiquid: number | null;
  vlTac: number | null;
  vlPresta: number | null;
  qtPrest: number | null;
  /** "lote" | "individual". */
  origem: string;
}

/** Grava a proposta no momento da criação (valores exatos do calcProsp). */
export function registrarPropostaCriada(p: PropostaCriadaRegistro): void {
  db.prepare(
    `INSERT OR REPLACE INTO propostas_criadas
       (ambiente, nr_prosp, cpf, nome, cd_conv, cd_prod, vl_finan, vl_liquid,
        vl_tac, vl_presta, qt_prest, origem, criado_em)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    env.SINQIA_ENV,
    p.nrProsp,
    p.cpf,
    p.nome,
    p.cdConv,
    p.cdProd,
    p.vlFinan,
    p.vlLiquid,
    p.vlTac,
    p.vlPresta,
    p.qtPrest,
    p.origem,
    new Date().toISOString(),
  );
}

/** Trilha de eventos do sistema (logs; base das futuras aprovações). */
export function registrarEvento(
  tipo: string,
  usuario: string,
  detalhe: Record<string, unknown> = {},
): void {
  db.prepare(`INSERT INTO eventos (ts, ambiente, usuario, tipo, detalhe) VALUES (?, ?, ?, ?, ?)`).run(
    new Date().toISOString(),
    env.SINQIA_ENV,
    usuario,
    tipo,
    JSON.stringify(detalhe),
  );
}

export interface PersonaOverride {
  documento: string;
  tpPessoa: string;
  tomador: boolean;
}

/**
 * Define/atualiza a persona de um cliente. Quando a marcação volta ao padrão
 * da regra (PF tomador, PJ não), a exceção é removida — a tabela guarda só
 * desvios, nunca o óbvio.
 */
export function definirPersona(
  documento: string,
  tpPessoa: string,
  tomador: boolean,
  usuario: string,
): void {
  const padrao = tpPessoa.toUpperCase() === "F";
  if (tomador === padrao) {
    db.prepare(`DELETE FROM personas WHERE ambiente = ? AND documento = ?`).run(
      env.SINQIA_ENV,
      documento,
    );
    return;
  }
  db.prepare(
    `INSERT OR REPLACE INTO personas
       (ambiente, documento, tp_pessoa, tomador, usuario, atualizado_em)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(env.SINQIA_ENV, documento, tpPessoa.toUpperCase(), tomador ? 1 : 0, usuario, new Date().toISOString());
}

/** Todas as exceções de persona do ambiente ativo (base ~centenas — tranquilo). */
export function listarPersonas(): PersonaOverride[] {
  const linhas = db
    .prepare(`SELECT documento, tp_pessoa, tomador FROM personas WHERE ambiente = ?`)
    .all(env.SINQIA_ENV) as Array<{ documento: string; tp_pessoa: string; tomador: number }>;
  return linhas.map((l) => ({
    documento: l.documento,
    tpPessoa: l.tp_pessoa,
    tomador: l.tomador === 1,
  }));
}

/** Ajuste do funil: +PJs promovidas a tomadoras, −PFs despromovidas. */
export function ajustePersonasTomadores(): { pjTomadoras: number; pfNaoTomadoras: number } {
  const linha = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN tp_pessoa = 'J' AND tomador = 1 THEN 1 ELSE 0 END), 0) AS pj,
         COALESCE(SUM(CASE WHEN tp_pessoa = 'F' AND tomador = 0 THEN 1 ELSE 0 END), 0) AS pf
       FROM personas WHERE ambiente = ?`,
    )
    .get(env.SINQIA_ENV) as { pj: number; pf: number } | undefined;
  return { pjTomadoras: linha?.pj ?? 0, pfNaoTomadoras: linha?.pf ?? 0 };
}

export interface OnboardingEstado {
  /** true = usuário já tem registro (não é mais primeiro acesso). */
  existe: boolean;
  tourConcluido: boolean;
  checklistItens: Record<string, boolean>;
  hintsDispensados: string[];
}

/** Estado de onboarding do usuário no ambiente ativo. */
export function getOnboarding(usuario: string): OnboardingEstado {
  const linha = db
    .prepare(
      `SELECT tour_concluido, checklist_itens, hints_dispensados
         FROM onboarding_estado WHERE ambiente = ? AND usuario = ?`,
    )
    .get(env.SINQIA_ENV, usuario) as
    | { tour_concluido: number; checklist_itens: string; hints_dispensados: string }
    | undefined;

  if (!linha) {
    return { existe: false, tourConcluido: false, checklistItens: {}, hintsDispensados: [] };
  }
  const parse = <T>(s: string, fallback: T): T => {
    try {
      return JSON.parse(s) as T;
    } catch {
      return fallback;
    }
  };
  return {
    existe: true,
    tourConcluido: linha.tour_concluido === 1,
    checklistItens: parse(linha.checklist_itens, {}),
    hintsDispensados: parse(linha.hints_dispensados, []),
  };
}

/**
 * Salva (merge) o estado de onboarding. Só os campos presentes no patch são
 * tocados; o restante é preservado. Marcar checklist/hints é incremental.
 */
export function salvarOnboarding(
  usuario: string,
  patch: {
    tourConcluido?: boolean;
    checklistItens?: Record<string, boolean>;
    hintsDispensados?: string[];
  },
): OnboardingEstado {
  const atual = getOnboarding(usuario);
  const proximo: OnboardingEstado = {
    existe: true,
    tourConcluido: patch.tourConcluido ?? atual.tourConcluido,
    checklistItens: { ...atual.checklistItens, ...(patch.checklistItens ?? {}) },
    hintsDispensados: patch.hintsDispensados
      ? [...new Set([...atual.hintsDispensados, ...patch.hintsDispensados])]
      : atual.hintsDispensados,
  };
  db.prepare(
    `INSERT OR REPLACE INTO onboarding_estado
       (ambiente, usuario, tour_concluido, checklist_itens, hints_dispensados, atualizado_em)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    env.SINQIA_ENV,
    usuario,
    proximo.tourConcluido ? 1 : 0,
    JSON.stringify(proximo.checklistItens),
    JSON.stringify(proximo.hintsDispensados),
    new Date().toISOString(),
  );
  return proximo;
}

export interface LiquidoAgregado {
  somaLiquid: number;
  somaFinan: number;
  /** Quantas das propostas pedidas têm registro local. */
  encontrados: number;
}

/**
 * Soma o líquido/financiado REGISTRADOS localmente para um conjunto de
 * propostas (as efetivadas do dashboard). Cobre só o que a ferramenta criou —
 * a cobertura vai junto para o front ser honesto sobre isso.
 */
export function somarValoresRegistrados(nrProsps: number[]): LiquidoAgregado {
  if (nrProsps.length === 0) return { somaLiquid: 0, somaFinan: 0, encontrados: 0 };
  const marcadores = nrProsps.map(() => "?").join(",");
  const linha = db
    .prepare(
      `SELECT COALESCE(SUM(vl_liquid), 0) AS soma_liquid,
              COALESCE(SUM(vl_finan), 0)  AS soma_finan,
              COUNT(*)                     AS encontrados
         FROM propostas_criadas
        WHERE ambiente = ? AND nr_prosp IN (${marcadores})`,
    )
    .get(env.SINQIA_ENV, ...nrProsps) as
    | { soma_liquid: number; soma_finan: number; encontrados: number }
    | undefined;
  return {
    somaLiquid: linha?.soma_liquid ?? 0,
    somaFinan: linha?.soma_finan ?? 0,
    encontrados: linha?.encontrados ?? 0,
  };
}
