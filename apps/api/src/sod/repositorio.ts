import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  ESTADOS_BLOQUEIO_MOVIMENTACAO,
  ESTADOS_REQUISICAO,
  montarPlacar,
  type EstadoRequisicao,
  type PlacarLote,
  type TipoAcaoSod,
} from "@cadastro-lote/shared";

/**
 * Esteira de Aprovação (SoD) — TODO o acesso a dados da camada de requisições
 * passa por aqui (padrão repositório, mesmo espírito do db.ts).
 *
 * Diferenças deliberadas em relação ao db.ts:
 *  - FÁBRICA em vez de singleton: o banco/ambiente entram por parâmetro, o que
 *    permite aos testes abrir, fechar e REABRIR o arquivo (cenário de reinício)
 *    sem depender de env. O runtime injeta env.SQLITE_PATH/SINQIA_ENV nas rotas.
 *  - Falha de banco AQUI PROPAGA: a requisição persistida é o próprio controle
 *    (SoD regulatório), não apoio — sem registro, a ação não existe.
 *
 * SQL deliberadamente portável (TEXT/INTEGER, ISO-8601 em TEXT) para a migração
 * PostgreSQL + Docker já planejada; exceções marcadas com MIGRATION-NOTE.
 */

export interface RequisicaoSod {
  id: string;
  ambiente: string;
  tipo: TipoAcaoSod;
  /** Payload integral da ação (RN08), exatamente como recebido. */
  payload: Record<string, unknown>;
  /**
   * CPF/CNPJ (dígitos) extraído do payload na criação — coluna da guarda de
   * duplicidade (RN02, decisão "Opção A" do PM na US-02). Null nos tipos sem
   * documento e nas requisições anteriores à coluna.
   */
  documento: string | null;
  /** Login Sinqia normalizado do criador (RN05). */
  requisitante: string;
  estado: EstadoRequisicao;
  /** Último decisor (aprovador/reprovador/quem descartou) — normalizado. */
  decididoPor: string | null;
  /** Motivo da última reprovação/descarte (RN07). Histórico completo na auditoria. */
  motivo: string | null;
  /** Resposta/erro integral da execução na Sinqia — preenchido na US-03. */
  resultado: Record<string, unknown> | null;
  criadoEm: string;
  atualizadoEm: string;
}

export interface EventoAuditoriaSod {
  id: number;
  ambiente: string;
  /** Null quando a tentativa rejeitada não referencia requisição existente. */
  requisicaoId: string | null;
  ator: string;
  acao: string;
  detalhe: Record<string, unknown>;
  resultado: string;
  ts: string;
}

/** Evento ainda sem id/ambiente/ts — o repositório completa ao inserir. */
export type NovoEventoAuditoria = Omit<EventoAuditoriaSod, "id" | "ambiente">;

export interface FiltrosRequisicao {
  estado?: EstadoRequisicao;
  tipo?: TipoAcaoSod;
  requisitante?: string;
  /**
   * Ordenação por criado_em. Default "desc" ("Minhas requisições");
   * o painel de pendências (US-03) usa "asc" — a mais antiga primeiro (RN01).
   */
  ordem?: "asc" | "desc";
  limit: number;
  offset: number;
}

export interface FiltrosAuditoria {
  ator?: string;
  requisicaoId?: string;
  /** ISO-8601 inclusivo. */
  de?: string;
  /** ISO-8601 inclusivo. */
  ate?: string;
  limit: number;
  offset: number;
}

/** Ação da trilha de auditoria para mudança EFETIVA de feature flag (US-05, RN05). */
export const ACAO_FLAG_ALTERADA = "flag_alterada";

/**
 * Item de uma requisição-LOTE (US-06): estado próprio espelhando a máquina
 * individual, payload integral por item e resultado Sinqia integral. `tipo` é
 * o tipo INDIVIDUAL executável do item (ex.: `tomador.cadastrar`) — é ele que
 * resolve o executor e a chave de duplicidade.
 */
export interface ItemLoteSod {
  id: string;
  requisicaoId: string;
  /** Posição no arquivo (1-based) — a ordem de execução (RN04). */
  ordem: number;
  tipo: TipoAcaoSod;
  payload: Record<string, unknown>;
  /** Chave de duplicidade do item (documento normalizado). */
  documento: string | null;
  /**
   * Vínculo tomador→proposta do lote COMPOSTO (US-07, RN03): id do item de
   * `tomador.cadastrar` DESTE MESMO lote do qual esta proposta depende. A
   * proposta só executa após `executada` do tomador; tomador falho/reprovado
   * derruba a proposta sem tocar a Sinqia. Coluna própria (não payload) de
   * propósito: o vínculo é CONSULTÁVEL — a US-10 decide a elegibilidade de
   * retry por ele (RN05: retry de proposta exige tomador executado; retry de
   * tomador reabilita as propostas em falha vinculadas). Null = item sem
   * dependência (tomador, ou proposta de tomador já existente — RN04).
   */
  dependeDeItemId: string | null;
  estado: EstadoRequisicao;
  /** Motivo da reprovação (exceção ou reprovação do lote). */
  motivo: string | null;
  /** Resposta/erro integral da execução Sinqia deste item. */
  resultado: Record<string, unknown> | null;
  criadoEm: string;
  atualizadoEm: string;
}

/**
 * Movimentação de proposta ATIVA (US-08/US-09) — a visão ÚNICA do bloqueio
 * por proposta, cobrindo as DUAS moradas: requisição individual
 * (`proposta.movimentar` em sod_requisicoes) e item de lote
 * (`proposta.movimentar` em sod_lote_itens, US-09). É contra esta visão que
 * a criação individual E a de lote validam; o Painel de Propostas desenha os
 * indicadores a partir dela.
 */
export interface MovimentacaoAtivaSod {
  /** Id da REQUISIÇÃO que segura o bloqueio (a individual, ou o LOTE do item). */
  id: string;
  /** Preenchidos quando o bloqueio vem de um ITEM de lote (US-09). */
  itemId: string | null;
  itemOrdem: number | null;
  /** Estado que segura o bloqueio (da requisição individual ou do ITEM). */
  estado: EstadoRequisicao;
  /** Nº da proposta (dígitos) — a chave do bloqueio. */
  documento: string;
  /** Criador da requisição (individual ou lote) — normalizado. */
  requisitante: string;
  criadoEm: string;
  /** Payload da individual ou do item — ambos carregam `movimentacao`. */
  payload: Record<string, unknown>;
  resultado: Record<string, unknown> | null;
}

/** Estado corrente de uma flag por tipo (US-05) — para o CLI operacional. */
export interface FlagSod {
  tipo: TipoAcaoSod;
  ativa: boolean;
  atualizadoEm: string;
}

/** Abre (ou cria) o banco e garante o schema da esteira SoD. */
export function abrirBancoSod(caminho: string): DatabaseSync {
  const resolvido = path.resolve(caminho);
  mkdirSync(path.dirname(resolvido), { recursive: true });
  const db = new DatabaseSync(resolvido);
  // MIGRATION-NOTE: PRAGMAs são exclusivos do SQLite — no PostgreSQL caem fora
  // (WAL/busy não existem; o pool do driver cuida da concorrência).
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  criarSchemaSod(db);
  return db;
}

/** Idempotente, mesmo padrão do db.ts (não há sistema de migrations no repo). */
export function criarSchemaSod(db: DatabaseSync): void {
  const estados = ESTADOS_REQUISICAO.map((e) => `'${e}'`).join(", ");
  db.exec(`
    CREATE TABLE IF NOT EXISTS sod_requisicoes (
      id            TEXT PRIMARY KEY,
      ambiente      TEXT NOT NULL,
      tipo          TEXT NOT NULL,
      payload       TEXT NOT NULL,
      documento     TEXT,
      requisitante  TEXT NOT NULL,
      estado        TEXT NOT NULL CHECK (estado IN (${estados})),
      decidido_por  TEXT,
      motivo        TEXT,
      resultado     TEXT,
      criado_em     TEXT NOT NULL,
      atualizado_em TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sod_req_estado ON sod_requisicoes (ambiente, estado);
    CREATE INDEX IF NOT EXISTS idx_sod_req_tipo ON sod_requisicoes (ambiente, tipo);
    CREATE INDEX IF NOT EXISTS idx_sod_req_requisitante ON sod_requisicoes (ambiente, requisitante);
  `);

  // Bases criadas pela US-01 não têm a coluna `documento` — adiciona se faltar.
  // MIGRATION-NOTE: PRAGMA table_info é SQLite; no PostgreSQL a checagem vira
  // information_schema.columns (ou ALTER TABLE ... ADD COLUMN IF NOT EXISTS).
  const colunas = db.prepare(`PRAGMA table_info(sod_requisicoes)`).all() as Array<{
    name: string;
  }>;
  if (!colunas.some((c) => c.name === "documento")) {
    db.exec(`ALTER TABLE sod_requisicoes ADD COLUMN documento TEXT`);
  }

  // Guarda de duplicidade (RN02) NO BANCO: no máximo UMA requisição pendente
  // por (ambiente, tipo, documento). Índice parcial — sintaxe idêntica no
  // PostgreSQL; linhas com documento NULL ficam fora da restrição.
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sod_req_doc_pendente
      ON sod_requisicoes (ambiente, tipo, documento)
      WHERE estado = 'pendente' AND documento IS NOT NULL;
  `);

  // Bloqueio de movimentação por proposta (US-08, RN03) NO BANCO: no máximo
  // UMA requisição de movimentação ATIVA (pendente/executando/FALHA — falha
  // segura o bloqueio até retry/descarte na US-10) por (ambiente, documento =
  // nº da proposta). É esta restrição que decide a corrida de criação
  // simultânea (Cenário 3): a segunda INSERT aborta aqui. Índice parcial com
  // sintaxe idêntica no PostgreSQL.
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sod_req_mov_ativa
      ON sod_requisicoes (ambiente, documento)
      WHERE tipo = 'proposta.movimentar'
        AND estado IN ('pendente', 'aprovada/executando', 'falha')
        AND documento IS NOT NULL;
  `);

  db.exec(`

    -- MIGRATION-NOTE: AUTOINCREMENT vira GENERATED ALWAYS AS IDENTITY no
    -- PostgreSQL; payload/detalhe/resultado (TEXT com JSON) viram JSONB.
    CREATE TABLE IF NOT EXISTS sod_auditoria (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      ambiente      TEXT NOT NULL,
      requisicao_id TEXT,
      ator          TEXT NOT NULL,
      acao          TEXT NOT NULL,
      detalhe       TEXT NOT NULL DEFAULT '{}',
      resultado     TEXT NOT NULL,
      ts            TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sod_aud_requisicao ON sod_auditoria (ambiente, requisicao_id);
    CREATE INDEX IF NOT EXISTS idx_sod_aud_ator_ts ON sod_auditoria (ambiente, ator, ts);
    CREATE INDEX IF NOT EXISTS idx_sod_aud_ts ON sod_auditoria (ambiente, ts);
  `);

  // Feature flags da Esteira de Aprovação (US-05, RN02/RN07): fonte DEFINITIVA
  // do "tipo sob aprovação", por (ambiente, tipo). AUSÊNCIA de linha = flag
  // INATIVA (RN07 — estado padrão), então o go-live não precisa de seed.
  // MIGRATION-NOTE: `ativa INTEGER` (0/1) vira BOOLEAN no PostgreSQL; o resto
  // (PK composta, upsert ON CONFLICT) tem sintaxe idêntica.
  db.exec(`
    CREATE TABLE IF NOT EXISTS sod_flags (
      ambiente      TEXT NOT NULL,
      tipo          TEXT NOT NULL,
      ativa         INTEGER NOT NULL CHECK (ativa IN (0, 1)),
      atualizado_em TEXT NOT NULL,
      PRIMARY KEY (ambiente, tipo)
    );
  `);

  // Itens de requisição-LOTE (US-06): tabela filha com estado próprio por
  // item. A guarda de duplicidade de itens (RN06, dimensões intra-arquivo e
  // entre lotes) vive NO BANCO, no mesmo padrão da individual: no máximo UM
  // item pendente por (ambiente, tipo, documento) — como todos os itens de um
  // lote nascem `pendente` na mesma transação, documento repetido no arquivo
  // também aborta aqui. Índice parcial com sintaxe idêntica no PostgreSQL.
  db.exec(`
    CREATE TABLE IF NOT EXISTS sod_lote_itens (
      id            TEXT PRIMARY KEY,
      ambiente      TEXT NOT NULL,
      requisicao_id TEXT NOT NULL REFERENCES sod_requisicoes(id),
      ordem         INTEGER NOT NULL,
      tipo          TEXT NOT NULL,
      payload       TEXT NOT NULL,
      documento     TEXT,
      estado        TEXT NOT NULL CHECK (estado IN (${estados})),
      motivo        TEXT,
      resultado     TEXT,
      criado_em     TEXT NOT NULL,
      atualizado_em TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sod_itens_requisicao
      ON sod_lote_itens (ambiente, requisicao_id, ordem);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sod_itens_doc_pendente
      ON sod_lote_itens (ambiente, tipo, documento)
      WHERE estado = 'pendente' AND documento IS NOT NULL;
  `);

  // Vínculo tomador→proposta do lote COMPOSTO (US-07): FK autorreferente com
  // profundidade fixa 1 (proposta → tomador do MESMO lote) — nenhuma consulta
  // recursiva/CTE é necessária, aqui ou no PostgreSQL. Bases criadas pela
  // US-06 não têm a coluna — adiciona se faltar (mesmo padrão de `documento`).
  // MIGRATION-NOTE: PRAGMA table_info é SQLite; no PostgreSQL a checagem vira
  // information_schema.columns (ou ALTER TABLE ... ADD COLUMN IF NOT EXISTS,
  // com REFERENCES sod_lote_itens(id)).
  const colunasItens = db.prepare(`PRAGMA table_info(sod_lote_itens)`).all() as Array<{
    name: string;
  }>;
  if (!colunasItens.some((c) => c.name === "depende_de_item_id")) {
    db.exec(
      `ALTER TABLE sod_lote_itens ADD COLUMN depende_de_item_id TEXT REFERENCES sod_lote_itens(id)`,
    );
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sod_itens_dependencia
      ON sod_lote_itens (ambiente, depende_de_item_id)
      WHERE depende_de_item_id IS NOT NULL;
  `);

  // Bloqueio de movimentação por proposta ESTENDIDO aos itens de lote (US-09):
  // a MESMA definição da US-08 (pendente/executando/FALHA seguram o bloqueio),
  // agora também sobre sod_lote_itens — no máximo UM item de movimentação
  // ativo por (ambiente, documento = nº da proposta). Este índice decide a
  // corrida lote×lote no próprio banco; a corrida individual×lote atravessa
  // duas tabelas (nenhum índice cobre) e é decidida pela pré-checagem do
  // domínio, que é SÍNCRONA entre checagem e INSERT (node:sqlite não cede o
  // event loop — nenhuma requisição concorrente intercala no processo).
  // MIGRATION-NOTE: índice parcial com sintaxe idêntica no PostgreSQL; lá a
  // guarda individual×lote precisa de trava explícita (ex.: advisory lock por
  // documento na criação) porque as transações passam a ser concorrentes.
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sod_itens_mov_ativa
      ON sod_lote_itens (ambiente, documento)
      WHERE tipo = 'proposta.movimentar'
        AND estado IN ('pendente', 'aprovada/executando', 'falha')
        AND documento IS NOT NULL;
  `);

  // Cinto de segurança do append-only (RN06): além de a camada não expor
  // update/delete, o PRÓPRIO BANCO os rejeita.
  // MIGRATION-NOTE: RAISE(ABORT) é sintaxe SQLite — no PostgreSQL vira uma
  // trigger function PL/pgSQL com RAISE EXCEPTION (ou REVOKE UPDATE/DELETE).
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_sod_auditoria_sem_update
    BEFORE UPDATE ON sod_auditoria
    BEGIN
      SELECT RAISE(ABORT, 'sod_auditoria é append-only: UPDATE proibido');
    END;
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_sod_auditoria_sem_delete
    BEFORE DELETE ON sod_auditoria
    BEGIN
      SELECT RAISE(ABORT, 'sod_auditoria é append-only: DELETE proibido');
    END;
  `);
}

interface LinhaRequisicao {
  id: string;
  ambiente: string;
  tipo: string;
  payload: string;
  documento: string | null;
  requisitante: string;
  estado: string;
  decidido_por: string | null;
  motivo: string | null;
  resultado: string | null;
  criado_em: string;
  atualizado_em: string;
}

interface LinhaItemLote {
  id: string;
  ambiente: string;
  requisicao_id: string;
  ordem: number;
  tipo: string;
  payload: string;
  documento: string | null;
  depende_de_item_id: string | null;
  estado: string;
  motivo: string | null;
  resultado: string | null;
  criado_em: string;
  atualizado_em: string;
}

interface LinhaEvento {
  id: number;
  ambiente: string;
  requisicao_id: string | null;
  ator: string;
  acao: string;
  detalhe: string;
  resultado: string;
  ts: string;
}

function paraRequisicao(l: LinhaRequisicao): RequisicaoSod {
  return {
    id: l.id,
    ambiente: l.ambiente,
    tipo: l.tipo as TipoAcaoSod,
    payload: JSON.parse(l.payload) as Record<string, unknown>,
    documento: l.documento,
    requisitante: l.requisitante,
    estado: l.estado as EstadoRequisicao,
    decididoPor: l.decidido_por,
    motivo: l.motivo,
    resultado: l.resultado ? (JSON.parse(l.resultado) as Record<string, unknown>) : null,
    criadoEm: l.criado_em,
    atualizadoEm: l.atualizado_em,
  };
}

function paraItemLote(l: LinhaItemLote): ItemLoteSod {
  return {
    id: l.id,
    requisicaoId: l.requisicao_id,
    ordem: l.ordem,
    tipo: l.tipo as TipoAcaoSod,
    payload: JSON.parse(l.payload) as Record<string, unknown>,
    documento: l.documento,
    dependeDeItemId: l.depende_de_item_id ?? null,
    estado: l.estado as EstadoRequisicao,
    motivo: l.motivo,
    resultado: l.resultado ? (JSON.parse(l.resultado) as Record<string, unknown>) : null,
    criadoEm: l.criado_em,
    atualizadoEm: l.atualizado_em,
  };
}

/** Visão de bloqueio (US-08/09) a partir de uma requisição INDIVIDUAL ativa. */
function movAtivaDeRequisicao(r: RequisicaoSod): MovimentacaoAtivaSod {
  return {
    id: r.id,
    itemId: null,
    itemOrdem: null,
    estado: r.estado,
    documento: r.documento ?? "",
    requisitante: r.requisitante,
    criadoEm: r.criadoEm,
    payload: r.payload,
    resultado: r.resultado,
  };
}

/** Visão de bloqueio (US-09) a partir de um ITEM de lote ativo (join com o lote). */
function movAtivaDeItem(l: LinhaItemLote & { lote_requisitante: string }): MovimentacaoAtivaSod {
  const item = paraItemLote(l);
  return {
    id: item.requisicaoId,
    itemId: item.id,
    itemOrdem: item.ordem,
    estado: item.estado,
    documento: item.documento ?? "",
    requisitante: l.lote_requisitante,
    criadoEm: item.criadoEm,
    payload: item.payload,
    resultado: item.resultado,
  };
}

function paraEvento(l: LinhaEvento): EventoAuditoriaSod {
  return {
    id: l.id,
    ambiente: l.ambiente,
    requisicaoId: l.requisicao_id,
    ator: l.ator,
    acao: l.acao,
    detalhe: JSON.parse(l.detalhe) as Record<string, unknown>,
    resultado: l.resultado,
    ts: l.ts,
  };
}

/**
 * Cria o repositório sobre uma conexão aberta. Toda operação é limitada ao
 * `ambiente` informado (mesma segregação HML/prod das tabelas existentes).
 */
export function criarSodRepositorio(db: DatabaseSync, ambiente: string) {
  // MIGRATION-NOTE: BEGIN IMMEDIATE é SQLite (trava de escrita imediata);
  // no PostgreSQL basta BEGIN — o UPDATE condicional já garante a atomicidade.
  function emTransacao<T>(fn: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try {
      const r = fn();
      db.exec("COMMIT");
      return r;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }

  function inserirEventoInterno(evento: NovoEventoAuditoria): void {
    db.prepare(
      `INSERT INTO sod_auditoria (ambiente, requisicao_id, ator, acao, detalhe, resultado, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      ambiente,
      evento.requisicaoId,
      evento.ator,
      evento.acao,
      JSON.stringify(evento.detalhe),
      evento.resultado,
      evento.ts,
    );
  }

  return {
    /**
     * Insere requisição + evento de criação na MESMA transação.
     *
     * Duplicidade (RN02): se já houver pendente do mesmo (tipo, documento), o
     * índice único parcial aborta o INSERT — detectável com
     * `ehViolacaoDuplicidadePendente`. Nada é gravado nesse caso.
     */
    criarRequisicao(
      req: Pick<RequisicaoSod, "id" | "tipo" | "payload" | "documento" | "requisitante" | "criadoEm">,
      evento: NovoEventoAuditoria,
    ): void {
      emTransacao(() => {
        db.prepare(
          `INSERT INTO sod_requisicoes
             (id, ambiente, tipo, payload, documento, requisitante, estado, criado_em, atualizado_em)
           VALUES (?, ?, ?, ?, ?, ?, 'pendente', ?, ?)`,
        ).run(
          req.id,
          ambiente,
          req.tipo,
          JSON.stringify(req.payload),
          req.documento,
          req.requisitante,
          req.criadoEm,
          req.criadoEm,
        );
        inserirEventoInterno(evento);
      });
    },

    obterRequisicao(id: string): RequisicaoSod | null {
      const linha = db
        .prepare(`SELECT * FROM sod_requisicoes WHERE ambiente = ? AND id = ?`)
        .get(ambiente, id) as LinhaRequisicao | undefined;
      return linha ? paraRequisicao(linha) : null;
    },

    /** Requisição pendente do (tipo, documento) — a referência da guarda RN02. */
    pendentePorDocumento(tipo: TipoAcaoSod, documento: string): RequisicaoSod | null {
      const linha = db
        .prepare(
          `SELECT * FROM sod_requisicoes
            WHERE ambiente = ? AND tipo = ? AND documento = ? AND estado = 'pendente'
            LIMIT 1`,
        )
        .get(ambiente, tipo, documento) as LinhaRequisicao | undefined;
      return linha ? paraRequisicao(linha) : null;
    },

    /**
     * Movimentação ATIVA da proposta (US-08, RN03): pendente, executando ou
     * em FALHA — a mesma definição dos índices de bloqueio. Fonte ÚNICA
     * (US-09): cobre a requisição individual E o item de lote; a individual
     * vem primeiro só por determinismo (os índices garantem no máximo uma de
     * cada). `documento` = nº da proposta em dígitos.
     */
    movimentacaoAtivaPorDocumento(documento: string): MovimentacaoAtivaSod | null {
      const estados = ESTADOS_BLOQUEIO_MOVIMENTACAO.map(() => "?").join(", ");
      const individual = db
        .prepare(
          `SELECT * FROM sod_requisicoes
            WHERE ambiente = ? AND tipo = 'proposta.movimentar'
              AND documento = ? AND estado IN (${estados})
            LIMIT 1`,
        )
        .get(ambiente, documento, ...ESTADOS_BLOQUEIO_MOVIMENTACAO) as
        | LinhaRequisicao
        | undefined;
      if (individual) return movAtivaDeRequisicao(paraRequisicao(individual));
      const item = db
        .prepare(
          `SELECT i.*, r.requisitante AS lote_requisitante
             FROM sod_lote_itens i
             JOIN sod_requisicoes r ON r.id = i.requisicao_id
            WHERE i.ambiente = ? AND i.tipo = 'proposta.movimentar'
              AND i.documento = ? AND i.estado IN (${estados})
            LIMIT 1`,
        )
        .get(ambiente, documento, ...ESTADOS_BLOQUEIO_MOVIMENTACAO) as
        | (LinhaItemLote & { lote_requisitante: string })
        | undefined;
      return item ? movAtivaDeItem(item) : null;
    },

    /**
     * TODAS as movimentações ativas do ambiente, em uma consulta — alimenta o
     * indicador do Painel de Propostas (RN05, agregado: nunca uma chamada por
     * proposta) e a elegibilidade da criação em massa (US-09). Fonte ÚNICA:
     * individuais + itens de lote, na mesma lista.
     */
    listarMovimentacoesAtivas(): MovimentacaoAtivaSod[] {
      const estados = ESTADOS_BLOQUEIO_MOVIMENTACAO.map(() => "?").join(", ");
      const individuais = db
        .prepare(
          `SELECT * FROM sod_requisicoes
            WHERE ambiente = ? AND tipo = 'proposta.movimentar' AND estado IN (${estados})`,
        )
        .all(ambiente, ...ESTADOS_BLOQUEIO_MOVIMENTACAO) as unknown as LinhaRequisicao[];
      const itens = db
        .prepare(
          `SELECT i.*, r.requisitante AS lote_requisitante
             FROM sod_lote_itens i
             JOIN sod_requisicoes r ON r.id = i.requisicao_id
            WHERE i.ambiente = ? AND i.tipo = 'proposta.movimentar' AND i.estado IN (${estados})`,
        )
        .all(ambiente, ...ESTADOS_BLOQUEIO_MOVIMENTACAO) as unknown as Array<
        LinhaItemLote & { lote_requisitante: string }
      >;
      return [
        ...individuais.map((l) => movAtivaDeRequisicao(paraRequisicao(l))),
        ...itens.map(movAtivaDeItem),
      ].sort((a, b) => (a.criadoEm < b.criadoEm ? -1 : a.criadoEm > b.criadoEm ? 1 : 0));
    },

    /**
     * Conta requisições que exigem ação do usuário (RN04 / US-11).
     * MIGRATION-NOTE: Se a performance no PostgreSQL degradar, um índice composto
     * (ambiente, estado, requisitante) pode ser necessário, embora o índice
     * existente `idx_sod_req_estado` costume bastar devido à seletividade.
     */
    contarPendenciasBadge(ator: string): number {
      const sql = `
        SELECT COUNT(*) AS n 
          FROM sod_requisicoes 
         WHERE ambiente = ? 
           AND estado IN ('pendente', 'falha') 
           AND requisitante != ?
      `;
      const row = db.prepare(sql).get(ambiente, ator) as { n: number };
      return row.n;
    },

    listarRequisicoes(f: FiltrosRequisicao): { itens: RequisicaoSod[]; total: number } {
      const clausulas = ["ambiente = ?"];
      const params: Array<string | number> = [ambiente];
      if (f.estado) {
        clausulas.push("estado = ?");
        params.push(f.estado);
      }
      if (f.tipo) {
        clausulas.push("tipo = ?");
        params.push(f.tipo);
      }
      if (f.requisitante) {
        clausulas.push("requisitante = ?");
        params.push(f.requisitante);
      }
      const where = clausulas.join(" AND ");
      const total = (
        db.prepare(`SELECT COUNT(*) AS n FROM sod_requisicoes WHERE ${where}`).get(...params) as {
          n: number;
        }
      ).n;
      // Direção validada pelo tipo (nunca interpolação de entrada externa).
      const direcao = f.ordem === "asc" ? "ASC" : "DESC";
      const linhas = db
        .prepare(
          `SELECT * FROM sod_requisicoes WHERE ${where}
           ORDER BY criado_em ${direcao}, id LIMIT ? OFFSET ?`,
        )
        .all(...params, f.limit, f.offset) as unknown as LinhaRequisicao[];
      return { itens: linhas.map(paraRequisicao), total };
    },

    /** Criadores distintos (para o filtro "criador" do painel de pendências). */
    requisitantes(f: { estado?: EstadoRequisicao } = {}): string[] {
      const clausulas = ["ambiente = ?"];
      const params: string[] = [ambiente];
      if (f.estado) {
        clausulas.push("estado = ?");
        params.push(f.estado);
      }
      const linhas = db
        .prepare(
          `SELECT DISTINCT requisitante FROM sod_requisicoes
            WHERE ${clausulas.join(" AND ")} ORDER BY requisitante`,
        )
        .all(...params) as unknown as Array<{ requisitante: string }>;
      return linhas.map((l) => l.requisitante);
    },

    /**
     * A feature flag do tipo está ativa? (US-05, RN02.) Leitura em RUNTIME —
     * cada requisição HTTP consulta o valor corrente; mudança de flag vale na
     * requisição seguinte, sem restart. Ausência de linha = INATIVA (RN07).
     */
    flagAtiva(tipo: TipoAcaoSod): boolean {
      const linha = db
        .prepare(`SELECT ativa FROM sod_flags WHERE ambiente = ? AND tipo = ?`)
        .get(ambiente, tipo) as { ativa: number } | undefined;
      return linha ? linha.ativa === 1 : false;
    },

    /** Flags registradas no ambiente (para o CLI `sod:flag status`). */
    listarFlags(): FlagSod[] {
      const linhas = db
        .prepare(
          `SELECT tipo, ativa, atualizado_em FROM sod_flags WHERE ambiente = ? ORDER BY tipo`,
        )
        .all(ambiente) as unknown as Array<{ tipo: string; ativa: number; atualizado_em: string }>;
      return linhas.map((l) => ({
        tipo: l.tipo as TipoAcaoSod,
        ativa: l.ativa === 1,
        atualizadoEm: l.atualizado_em,
      }));
    },

    /**
     * Muda a flag do tipo, com auditoria NA MESMA transação (US-05, RN05):
     * a comparação com o estado anterior acontece dentro da transação, então
     * só mudança EFETIVA grava (upsert + evento `flag_alterada` com estado
     * anterior, novo, ator e timestamp). Repetir o mesmo valor não grava nada.
     */
    definirFlag(params: {
      tipo: TipoAcaoSod;
      ativa: boolean;
      ator: string;
      agora: string;
    }): { mudou: boolean; anterior: boolean } {
      return emTransacao(() => {
        const linha = db
          .prepare(`SELECT ativa FROM sod_flags WHERE ambiente = ? AND tipo = ?`)
          .get(ambiente, params.tipo) as { ativa: number } | undefined;
        const anterior = linha ? linha.ativa === 1 : false;
        if (anterior === params.ativa) return { mudou: false, anterior };

        db.prepare(
          `INSERT INTO sod_flags (ambiente, tipo, ativa, atualizado_em)
           VALUES (?, ?, ?, ?)
           ON CONFLICT (ambiente, tipo)
           DO UPDATE SET ativa = excluded.ativa, atualizado_em = excluded.atualizado_em`,
        ).run(ambiente, params.tipo, params.ativa ? 1 : 0, params.agora);
        inserirEventoInterno({
          requisicaoId: null,
          ator: params.ator,
          acao: ACAO_FLAG_ALTERADA,
          detalhe: { tipo: params.tipo, anterior, novo: params.ativa },
          resultado: "ok",
          ts: params.agora,
        });
        return { mudou: true, anterior };
      });
    },

    /**
     * Transição ATÔMICA "primeira decisão vence": o UPDATE só acontece se o
     * estado ainda for `de` (guarda no WHERE). Devolve false se outra decisão
     * chegou antes — nada é gravado nesse caso (nem o evento).
     */
    transicionar(params: {
      id: string;
      de: EstadoRequisicao;
      para: EstadoRequisicao;
      decididoPor?: string;
      motivo?: string;
      resultado?: Record<string, unknown>;
      agora: string;
      evento: NovoEventoAuditoria;
    }): boolean {
      return emTransacao(() => {
        const r = db
          .prepare(
            `UPDATE sod_requisicoes
                SET estado = ?,
                    decidido_por = COALESCE(?, decidido_por),
                    motivo = COALESCE(?, motivo),
                    resultado = COALESCE(?, resultado),
                    atualizado_em = ?
              WHERE ambiente = ? AND id = ? AND estado = ?`,
          )
          .run(
            params.para,
            params.decididoPor ?? null,
            params.motivo ?? null,
            params.resultado ? JSON.stringify(params.resultado) : null,
            params.agora,
            ambiente,
            params.id,
            params.de,
          );
        if (r.changes !== 1) return false;
        inserirEventoInterno(params.evento);
        return true;
      });
    },

    /* ------------------- Requisição-LOTE (US-06) ------------------- */

    /**
     * Insere o LOTE + todos os itens + evento de criação na MESMA transação
     * (tudo ou nada). Documento repetido — no arquivo ou pendente em outro
     * lote — aborta pelo índice único parcial (`idx_sod_itens_doc_pendente`),
     * detectável com `ehViolacaoDuplicidadeItemPendente`.
     */
    criarRequisicaoLote(
      req: Pick<RequisicaoSod, "id" | "tipo" | "payload" | "requisitante" | "criadoEm">,
      itens: Array<
        Pick<ItemLoteSod, "id" | "ordem" | "tipo" | "payload" | "documento"> &
          Partial<Pick<ItemLoteSod, "dependeDeItemId">>
      >,
      evento: NovoEventoAuditoria,
    ): void {
      emTransacao(() => {
        db.prepare(
          `INSERT INTO sod_requisicoes
             (id, ambiente, tipo, payload, documento, requisitante, estado, criado_em, atualizado_em)
           VALUES (?, ?, ?, ?, NULL, ?, 'pendente', ?, ?)`,
        ).run(
          req.id,
          ambiente,
          req.tipo,
          JSON.stringify(req.payload),
          req.requisitante,
          req.criadoEm,
          req.criadoEm,
        );
        const insereItem = db.prepare(
          `INSERT INTO sod_lote_itens
             (id, ambiente, requisicao_id, ordem, tipo, payload, documento, depende_de_item_id, estado, criado_em, atualizado_em)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pendente', ?, ?)`,
        );
        // Itens em ordem: tomadores (sem dependência) antes das propostas que
        // os referenciam — a FK autorreferente exige o pai já inserido.
        for (const item of itens) {
          insereItem.run(
            item.id,
            ambiente,
            req.id,
            item.ordem,
            item.tipo,
            JSON.stringify(item.payload),
            item.documento,
            item.dependeDeItemId ?? null,
            req.criadoEm,
            req.criadoEm,
          );
        }
        inserirEventoInterno(evento);
      });
    },

    /** Itens do lote na ordem do arquivo — a ordem de execução (RN04). */
    itensDoLote(requisicaoId: string): ItemLoteSod[] {
      const linhas = db
        .prepare(
          `SELECT * FROM sod_lote_itens WHERE ambiente = ? AND requisicao_id = ? ORDER BY ordem`,
        )
        .all(ambiente, requisicaoId) as unknown as LinhaItemLote[];
      return linhas.map(paraItemLote);
    },

    obterItem(id: string): ItemLoteSod | null {
      const linha = db
        .prepare(`SELECT * FROM sod_lote_itens WHERE ambiente = ? AND id = ?`)
        .get(ambiente, id) as LinhaItemLote | undefined;
      return linha ? paraItemLote(linha) : null;
    },

    /** Item PENDENTE de qualquer lote com o (tipo, documento) — dimensão 3 da RN06. */
    itemPendentePorDocumento(tipo: TipoAcaoSod, documento: string): ItemLoteSod | null {
      const linha = db
        .prepare(
          `SELECT * FROM sod_lote_itens
            WHERE ambiente = ? AND tipo = ? AND documento = ? AND estado = 'pendente'
            LIMIT 1`,
        )
        .get(ambiente, tipo, documento) as LinhaItemLote | undefined;
      return linha ? paraItemLote(linha) : null;
    },

    /** Placar do lote (RN01): contagem de itens por estado, direto do banco. */
    placarDoLote(requisicaoId: string): PlacarLote {
      const linhas = db
        .prepare(
          `SELECT estado, COUNT(*) AS n FROM sod_lote_itens
            WHERE ambiente = ? AND requisicao_id = ? GROUP BY estado`,
        )
        .all(ambiente, requisicaoId) as unknown as Array<{ estado: EstadoRequisicao; n: number }>;
      return montarPlacar(linhas);
    },

    /**
     * Placar de DOIS NÍVEIS do lote composto (US-07): um placar por tipo de
     * item (tomadores × propostas). Lote de um tipo só devolve uma entrada.
     */
    placarPorTipo(requisicaoId: string): Partial<Record<TipoAcaoSod, PlacarLote>> {
      const linhas = db
        .prepare(
          `SELECT tipo, estado, COUNT(*) AS n FROM sod_lote_itens
            WHERE ambiente = ? AND requisicao_id = ? GROUP BY tipo, estado`,
        )
        .all(ambiente, requisicaoId) as unknown as Array<{
        tipo: TipoAcaoSod;
        estado: EstadoRequisicao;
        n: number;
      }>;
      const porTipo: Partial<Record<TipoAcaoSod, PlacarLote>> = {};
      for (const tipo of new Set(linhas.map((l) => l.tipo))) {
        porTipo[tipo] = montarPlacar(linhas.filter((l) => l.tipo === tipo));
      }
      return porTipo;
    },

    /** Itens que DEPENDEM de um item (propostas vinculadas a um tomador — US-07/US-10). */
    itensDependentes(itemId: string): ItemLoteSod[] {
      const linhas = db
        .prepare(
          `SELECT * FROM sod_lote_itens
            WHERE ambiente = ? AND depende_de_item_id = ? ORDER BY ordem`,
        )
        .all(ambiente, itemId) as unknown as LinhaItemLote[];
      return linhas.map(paraItemLote);
    },

    /**
     * Transição ATÔMICA de UM item ("primeira vence", mesmo padrão da
     * requisição): o UPDATE só acontece se o estado ainda for `de` — é esta
     * guarda que garante a idempotência por item (RN05): um item que já saiu
     * de `pendente` nunca é reivindicado de novo por outra execução.
     */
    transicionarItem(params: {
      id: string;
      de: EstadoRequisicao;
      para: EstadoRequisicao;
      motivo?: string;
      resultado?: Record<string, unknown>;
      agora: string;
      evento: NovoEventoAuditoria;
    }): boolean {
      return emTransacao(() => {
        const r = db
          .prepare(
            `UPDATE sod_lote_itens
                SET estado = ?,
                    motivo = COALESCE(?, motivo),
                    resultado = COALESCE(?, resultado),
                    atualizado_em = ?
              WHERE ambiente = ? AND id = ? AND estado = ?`,
          )
          .run(
            params.para,
            params.motivo ?? null,
            params.resultado ? JSON.stringify(params.resultado) : null,
            params.agora,
            ambiente,
            params.id,
            params.de,
          );
        if (r.changes !== 1) return false;
        inserirEventoInterno(params.evento);
        return true;
      });
    },

    /**
     * Aplica a DECISÃO do lote atomicamente (RN03): transição do lote com
     * "primeira decisão vence" + transições dos itens indicados + auditoria,
     * tudo na MESMA transação. Perdeu a corrida do lote → false, nada gravado.
     * Item fora do estado esperado → exceção (rollback total) — não existe
     * decisão meio aplicada.
     */
    aplicarDecisaoLote(params: {
      id: string;
      de: EstadoRequisicao;
      para: EstadoRequisicao;
      decididoPor?: string;
      motivo?: string;
      agora: string;
      eventoLote: NovoEventoAuditoria;
      itens: Array<{
        id: string;
        de: EstadoRequisicao;
        para: EstadoRequisicao;
        motivo?: string;
        resultado?: Record<string, unknown>;
        evento: NovoEventoAuditoria;
      }>;
    }): boolean {
      return emTransacao(() => {
        const r = db
          .prepare(
            `UPDATE sod_requisicoes
                SET estado = ?,
                    decidido_por = COALESCE(?, decidido_por),
                    motivo = COALESCE(?, motivo),
                    atualizado_em = ?
              WHERE ambiente = ? AND id = ? AND estado = ?`,
          )
          .run(
            params.para,
            params.decididoPor ?? null,
            params.motivo ?? null,
            params.agora,
            ambiente,
            params.id,
            params.de,
          );
        if (r.changes !== 1) return false;
        inserirEventoInterno(params.eventoLote);

        const atualizaItem = db.prepare(
          `UPDATE sod_lote_itens
              SET estado = ?, motivo = COALESCE(?, motivo),
                  resultado = COALESCE(?, resultado), atualizado_em = ?
            WHERE ambiente = ? AND id = ? AND estado = ?`,
        );
        for (const item of params.itens) {
          const ri = atualizaItem.run(
            item.para,
            item.motivo ?? null,
            item.resultado ? JSON.stringify(item.resultado) : null,
            params.agora,
            ambiente,
            item.id,
            item.de,
          );
          if (ri.changes !== 1) {
            throw new Error(
              `Item ${item.id} não estava em "${item.de}" ao aplicar a decisão do lote ${params.id} — decisão revertida.`,
            );
          }
          inserirEventoInterno(item.evento);
        }
        return true;
      });
    },

    /**
     * Auditoria: APENAS inserir e consultar (RN06). Este objeto não tem — e
     * nunca deve ganhar — métodos de update/delete de eventos.
     */
    inserirEvento(evento: NovoEventoAuditoria): void {
      inserirEventoInterno(evento);
    },

    eventosDaRequisicao(requisicaoId: string): EventoAuditoriaSod[] {
      const linhas = db
        .prepare(
          `SELECT * FROM sod_auditoria WHERE ambiente = ? AND requisicao_id = ? ORDER BY id`,
        )
        .all(ambiente, requisicaoId) as unknown as LinhaEvento[];
      return linhas.map(paraEvento);
    },

    listarEventos(f: FiltrosAuditoria): { itens: EventoAuditoriaSod[]; total: number } {
      const clausulas = ["ambiente = ?"];
      const params: Array<string | number> = [ambiente];
      if (f.ator) {
        clausulas.push("ator = ?");
        params.push(f.ator);
      }
      if (f.requisicaoId) {
        clausulas.push("requisicao_id = ?");
        params.push(f.requisicaoId);
      }
      if (f.de) {
        clausulas.push("ts >= ?");
        params.push(f.de);
      }
      if (f.ate) {
        clausulas.push("ts <= ?");
        params.push(f.ate);
      }
      const where = clausulas.join(" AND ");
      const total = (
        db.prepare(`SELECT COUNT(*) AS n FROM sod_auditoria WHERE ${where}`).get(...params) as {
          n: number;
        }
      ).n;
      const linhas = db
        .prepare(`SELECT * FROM sod_auditoria WHERE ${where} ORDER BY id LIMIT ? OFFSET ?`)
        .all(...params, f.limit, f.offset) as unknown as LinhaEvento[];
      return { itens: linhas.map(paraEvento), total };
    },
  };
}

export type SodRepositorio = ReturnType<typeof criarSodRepositorio>;

/**
 * O INSERT perdeu a corrida da guarda de duplicidade (RN02)? Duas submissões
 * simultâneas do mesmo documento: a primeira insere, a segunda cai aqui.
 * MIGRATION-NOTE: a detecção é pela mensagem do SQLite ("UNIQUE constraint
 * failed" citando o índice); no PostgreSQL vira o código 23505 (unique_violation).
 */
export function ehViolacaoDuplicidadePendente(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : "";
  // A mensagem cita o índice ou as colunas dele, conforme a versão do SQLite.
  return (
    msg.includes("UNIQUE constraint failed") &&
    (msg.includes("idx_sod_req_doc_pendente") || msg.includes("sod_requisicoes.documento"))
  );
}

/**
 * O INSERT perdeu a corrida do BLOQUEIO de movimentação (US-08, Cenário 3):
 * duas requisições simultâneas para a MESMA proposta — a primeira insere, a
 * segunda cai aqui (índice `idx_sod_req_mov_ativa`). A mensagem do SQLite
 * cita as colunas do índice, as mesmas da guarda de pendentes — quem chama
 * já sabe o tipo (`proposta.movimentar`), então a distinção é do chamador.
 * MIGRATION-NOTE: no PostgreSQL vira o código 23505 (unique_violation).
 */
export function ehViolacaoBloqueioMovimentacao(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : "";
  return (
    msg.includes("UNIQUE constraint failed") &&
    (msg.includes("idx_sod_req_mov_ativa") || msg.includes("sod_requisicoes.documento"))
  );
}

/**
 * O INSERT de itens perdeu a corrida da guarda de duplicidade do LOTE (RN06):
 * outro lote (ou o próprio arquivo, com documento repetido) inseriu um item
 * pendente do mesmo (tipo, documento) primeiro.
 * MIGRATION-NOTE: detecção pela mensagem do SQLite; no PostgreSQL vira o
 * código 23505 (unique_violation), como na guarda individual.
 */
export function ehViolacaoDuplicidadeItemPendente(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : "";
  return (
    msg.includes("UNIQUE constraint failed") &&
    (msg.includes("idx_sod_itens_doc_pendente") || msg.includes("sod_lote_itens.documento"))
  );
}

/**
 * O INSERT de itens perdeu a corrida do BLOQUEIO de movimentação (US-09):
 * outro lote inseriu item ativo de movimentação da MESMA proposta primeiro
 * (índice `idx_sod_itens_mov_ativa`). A mensagem do SQLite pode citar o
 * índice ou as colunas dele (as mesmas da guarda de pendentes de itens).
 * MIGRATION-NOTE: no PostgreSQL vira o código 23505 (unique_violation).
 */
export function ehViolacaoBloqueioMovimentacaoItem(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : "";
  return (
    msg.includes("UNIQUE constraint failed") &&
    (msg.includes("idx_sod_itens_mov_ativa") || msg.includes("sod_lote_itens.documento"))
  );
}
