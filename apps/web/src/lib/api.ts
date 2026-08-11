// Cliente da API local. Usa caminhos relativos /api (proxy do Vite → backend).
//
// AUTENTICAÇÃO: nenhuma função aqui recebe usuário/senha. A sessão viaja no
// cookie httpOnly que o backend setou no login, enviado automaticamente pelo
// fetch e pelo EventSource (mesma origem, via proxy do Vite).

import type {
  DuplicidadesLote,
  EmissaoRow,
  EstadoRequisicao,
  ExcecaoLote,
  PlacarLote,
  TipoAcaoSod,
} from "@cadastro-lote/shared";
import { lerResposta } from "./session";

/** Ações aceitas pela Sinqia: Incluir / Alterar / Excluir / Consultar. */
export type IdAcao = "IN" | "AL" | "EX" | "CO";

/** Estado do formulário de controle do lote (com "" para "não escolhido"). */
export interface BatchControlInput {
  finalizar: boolean;
  /** "S" (default) integra automaticamente com o módulo de cadastro; "N" não integra. */
  idIntegracaoCadastro: "S" | "N";
  /** Ação aplicada a todas as linhas. "" = usar o que vier do arquivo. */
  idAcao: IdAcao | "";
  idRetConsistencias?: string;
  idBiometria?: string;
  idOrigemRequest?: string;
}

/**
 * Forma enviada ao backend: já sem os "" (campos não escolhidos são omitidos).
 * Ver `sanitizeControl` em CadastroLote.tsx.
 */
export type BatchControlPayload = Record<string, unknown>;

export interface ValidateRow {
  index: number;
  nome: string;
  documento: string;
  tipo: "PF" | "PJ" | "?";
  errors: string[];
}

export interface ValidateResponse {
  env: string;
  total: number;
  totalErros: number;
  valido: boolean;
  rows: ValidateRow[];
  preview: Array<{ index: number; payload?: unknown; error?: string }>;
  /** Esteira de Aprovação (US-06): true = o lote virará requisição pendente. */
  aprovacao?: boolean;
  /** Duplicidade tridimensional (RN06), apontada ANTES do envio. */
  duplicidades?: DuplicidadesLote;
}

export interface RowResult {
  index: number;
  nome: string;
  documento: string;
  tipo: "PF" | "PJ" | "?";
  /** NAO_ENVIADO = sessão expirou antes desta linha ser tentada. */
  status: "OK" | "ERRO" | "PULADO" | "NAO_ENVIADO";
  httpStatus: number | null;
  envelopeStatus?: string;
  globalMessage?: string;
  messages: string;
  detail?: string;
}

export interface EnvInfo {
  env: string;
  isProd: boolean;
  baseUrl: string;
  /** Toggles da Esteira de Aprovação (SoD) — a UI adapta CTAs e mensagens. */
  aprovacao?: {
    cadastroTomadorIndividual: boolean;
    criacaoPropostaIndividual?: boolean;
    cadastroTomadorLote?: boolean;
    criacaoPropostaLote?: boolean;
    movimentacaoProposta?: boolean;
    movimentacaoPropostaMassa?: boolean;
    situacaoTomador?: boolean;
    situacaoTomadorLote?: boolean;
  };
}

export const TEMPLATE_URL = "/api/template.csv";
/** Modelo CSV do lote de propostas — mesmas colunas do Emissoes.xlsx (US-07). */
export const TEMPLATE_PROPOSTAS_URL = "/api/propostas/template.csv";

export async function getEnv(): Promise<EnvInfo> {
  const res = await fetch("/api/env");
  if (!res.ok) throw new Error("Não foi possível consultar o ambiente do backend.");
  return res.json();
}

function buildForm(file: File, control: BatchControlPayload): FormData {
  const fd = new FormData();
  fd.append("control", JSON.stringify(control));
  fd.append("file", file);
  return fd;
}

export async function validate(
  file: File,
  control: BatchControlPayload,
): Promise<ValidateResponse> {
  const res = await fetch("/api/validate", {
    method: "POST",
    body: buildForm(file, control),
  });
  return lerResposta<ValidateResponse>(res, "Falha na validação");
}

export async function startImport(
  file: File,
  control: BatchControlPayload,
): Promise<{
  jobId?: string;
  total: number;
  validas?: number;
  puladas?: number;
  env: string;
  /** Esteira de Aprovação (US-06): true = virou requisição-lote pendente. */
  aprovacao?: boolean;
  requisicao?: { id: string; estado: string; criadoEm: string; totalItens: number };
}> {
  const res = await fetch("/api/import", {
    method: "POST",
    body: buildForm(file, control),
  });
  return lerResposta(res, "Falha ao iniciar o lote");
}

export interface StreamHandlers {
  onSnapshot?: (data: {
    total: number;
    processed: number;
    success: number;
    error: number;
    skipped: number;
    results: RowResult[];
    done: boolean;
  }) => void;
  onRow?: (row: RowResult) => void;
  onProgress?: (p: {
    processed: number;
    total: number;
    success: number;
    error: number;
    skipped: number;
    naoEnviado?: number;
  }) => void;
  /** Sessão morreu no meio: o restante ficou como NAO_ENVIADO. */
  onSessaoExpirada?: (d: { message: string }) => void;
  onFatal?: (d: { message: string }) => void;
  onDone?: (d: { total: number; success: number; error: number }) => void;
  onError?: (e: Event) => void;
}

/* ------------------------------------------------------------------ */
/* Cadastro individual                                                 */
/* ------------------------------------------------------------------ */

export interface CamposObrigatoriosResponse {
  httpStatus: number;
  /** Caminhos achatados exigidos pela Sinqia. */
  paths: string[];
  formato: "lista-strings" | "lista-objetos" | "modelo-cliente" | "desconhecido" | "sem-registro";
  /** Corpo cru — exibido na tela enquanto o formato real não está confirmado. */
  bruto?: unknown;
  rawBody?: string;
}

/** Consulta os campos obrigatórios do cadastro (GET, somente leitura). */
export async function getCamposObrigatorios(): Promise<CamposObrigatoriosResponse> {
  const res = await fetch("/api/campos-obrigatorios");
  return lerResposta<CamposObrigatoriosResponse>(res, "Falha ao consultar campos obrigatórios");
}

export interface CadastrarUmResponse {
  env: string;
  /** false = reprovou na validação local; `errors` traz os motivos por campo. */
  valido: boolean;
  errors?: string[];
  tipo: "PF" | "PJ" | "?";
  dryRun?: boolean;
  /** Payload montado — só no dry-run. */
  payload?: unknown;
  status?: "OK" | "ERRO";
  httpStatus?: number;
  envelopeStatus?: string;
  globalMessage?: string;
  messages?: string;
  detail?: string;
  /** Esteira de Aprovação: true = virou requisição pendente (nada foi à Sinqia). */
  aprovacao?: boolean;
  requisicao?: { id: string; estado: string; criadoEm: string };
}

/**
 * Valida (e opcionalmente cadastra) UM cliente a partir do formulário.
 * `campos` é o mapa achatado, igual a uma linha de CSV.
 */
export async function cadastrarUm(
  campos: Record<string, string>,
  control: BatchControlPayload,
  dryRun: boolean,
): Promise<CadastrarUmResponse> {
  const res = await fetch("/api/cadastrar", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ campos, control, dryRun }),
  });
  return lerResposta<CadastrarUmResponse>(res, "Falha no cadastro");
}

/* ------------------------------------------------------------------ */
/* Esteira de Aprovação (SoD) — requisições                            */
/* ------------------------------------------------------------------ */

export interface RequisicaoSod {
  id: string;
  ambiente: string;
  tipo: TipoAcaoSod;
  /** Payload integral da ação — no cadastro: { campos, control, request }. */
  payload: Record<string, unknown>;
  /** CPF/CNPJ (dígitos) extraído na criação — null nos tipos sem documento. */
  documento: string | null;
  /** Login Sinqia normalizado do criador. */
  requisitante: string;
  estado: EstadoRequisicao;
  decididoPor: string | null;
  /** Motivo da reprovação/descarte, quando houver. */
  motivo: string | null;
  resultado: Record<string, unknown> | null;
  criadoEm: string;
  atualizadoEm: string;
}

export interface EventoAuditoriaSod {
  id: number;
  ambiente: string;
  requisicaoId: string | null;
  ator: string;
  acao: string;
  detalhe: Record<string, unknown>;
  resultado: string;
  ts: string;
}

/**
 * Lista as requisições criadas pelo usuário LOGADO (o backend força o filtro
 * pela identidade da sessão — `minhas=1`).
 */
export async function listarMinhasRequisicoes(f: {
  estado?: string;
  tipo?: string;
  limit: number;
  offset: number;
}): Promise<{ itens: RequisicaoSod[]; total: number }> {
  const qs = new URLSearchParams({
    minhas: "1",
    limit: String(f.limit),
    offset: String(f.offset),
  });
  if (f.estado) qs.set("estado", f.estado);
  if (f.tipo) qs.set("tipo", f.tipo);
  const res = await fetch(`/api/sod/requisicoes?${qs}`);
  return lerResposta(res, "Falha ao listar as requisições");
}

/**
 * Item de lote em visão ENXUTA (US-06): estado, resumo e desfecho público —
 * o payload/resposta integral vem de `obterItemLote`. É o shape que o polling
 * de progresso consome.
 */
export interface ItemLoteResumo {
  id: string;
  ordem: number;
  tipo: TipoAcaoSod;
  estado: EstadoRequisicao;
  documento: string | null;
  /** Vínculo do lote COMPOSTO (US-07): id do item de tomador do qual esta proposta depende. */
  dependeDeItemId?: string | null;
  /** Motivo da reprovação do item (exceção ou reprovação do lote). */
  motivo: string | null;
  resumo: { nome?: string; documento?: string; tipo?: string };
  resultado: {
    desfecho?: "executada" | "falha";
    httpStatus?: number | null;
    mensagens?: string;
    detalhe?: string;
    causa?: string;
    duracaoMs?: number;
  } | null;
  atualizadoEm: string;
}

export interface DetalheRequisicao {
  requisicao: RequisicaoSod;
  historico: EventoAuditoriaSod[];
  /** Presentes apenas em requisições de LOTE (US-06). */
  itens?: ItemLoteResumo[];
  placar?: PlacarLote;
  /** Dois níveis (US-07): placar por tipo de item (tomadores × propostas). */
  placarPorTipo?: Partial<Record<TipoAcaoSod, PlacarLote>>;
}

/** Detalhe: requisição + histórico; lotes trazem itens + placar (US-06). */
export async function detalharRequisicao(id: string): Promise<DetalheRequisicao> {
  const res = await fetch(`/api/sod/requisicoes/${encodeURIComponent(id)}`);
  return lerResposta(res, "Falha ao consultar a requisição");
}

/** Detalhe INTEGRAL de um item de lote (payload + resposta Sinqia completa). */
export async function obterItemLote(
  requisicaoId: string,
  itemId: string,
): Promise<{
  item: {
    id: string;
    ordem: number;
    estado: EstadoRequisicao;
    payload: Record<string, unknown>;
    motivo: string | null;
    resultado: Record<string, unknown> | null;
  };
}> {
  const res = await fetch(
    `/api/sod/requisicoes/${encodeURIComponent(requisicaoId)}/itens/${encodeURIComponent(itemId)}`,
  );
  return lerResposta(res, "Falha ao consultar o item do lote");
}

/**
 * Cancela uma requisição PENDENTE criada pelo próprio usuário. Se ela já foi
 * decidida (concorrência), o backend responde 409 com o estado atual.
 */
export async function cancelarRequisicao(id: string): Promise<{ requisicao: RequisicaoSod }> {
  const res = await fetch(`/api/sod/requisicoes/${encodeURIComponent(id)}/decisao`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decisao: "cancelar" }),
  });
  return lerResposta(res, "Falha ao cancelar a requisição");
}

/**
 * Impacto de uma requisição de SITUAÇÃO, consultado ANTES da decisão (US-12).
 * Somente leitura, na sessão de quem decide. `aplicavel: false` quando o tipo
 * não tem impacto ou quando é uma ATIVAÇÃO (nada a avisar).
 */
export interface ImpactoSituacao {
  aplicavel: boolean;
  motivo?: "tipo_sem_impacto" | "payload_sem_situacao" | "ativacao";
  cdSituacao?: number;
  totalEmAndamento?: number;
  tomadores?: Array<{
    documento: string;
    nome: string;
    emAndamento: number;
    propostas: Array<{ nrProsp: number; nrStatus: number | null; dsStatus: string }>;
    erro?: string;
  }>;
  total?: number;
  consultados?: number;
  parcial?: boolean;
}

export async function consultarImpactoSituacao(id: string): Promise<ImpactoSituacao> {
  const res = await fetch(`/api/sod/requisicoes/${encodeURIComponent(id)}/impacto`);
  return lerResposta(res, "Falha ao consultar o impacto da alteração");
}

/* --- Painel de pendências (US-03, lado do aprovador) --- */

/** Contagem do badge (US-11): total decidível + quebra por estado. */
export interface ContagemPendencias {
  /** Total (pendentes + falhas) — o número do badge da navegação. */
  count: number;
  pendentes: number;
  falhas: number;
}

/**
 * Retorna a contagem de pendências e falhas tratáveis (US-11).
 * A quebra por estado alimenta os chips da fila: sem ela, a tela abre em
 * "Pendentes" e o operador não vê que existe falha esperando decisão.
 */
export async function contarPendenciasBadge(): Promise<ContagemPendencias> {
  const res = await fetch("/api/sod/pendencias-badge");
  const r = await lerResposta<{ count: number; pendentes?: number; falhas?: number }>(
    res,
    "Falha ao contar pendências",
  );
  return { count: r.count, pendentes: r.pendentes ?? 0, falhas: r.falhas ?? 0 };
}

/**
 * Requisições de todos os operadores, da mais antiga para a mais nova,
 * filtrando por estado (pendente ou falha), tipo e criador.
 */
export async function listarPendencias(f: {
  tipo?: string;
  requisitante?: string;
  estado?: "pendente" | "falha";
  limit: number;
  offset: number;
}): Promise<{ itens: RequisicaoSod[]; total: number }> {
  const qs = new URLSearchParams({
    estado: f.estado || "pendente",
    ordem: "asc",
    limit: String(f.limit),
    offset: String(f.offset),
  });
  if (f.tipo) qs.set("tipo", f.tipo);
  if (f.requisitante) qs.set("requisitante", f.requisitante);
  const res = await fetch(`/api/sod/requisicoes?${qs}`);
  return lerResposta(res, "Falha ao listar as pendências");
}

/** Criadores distintos das requisições — alimenta o filtro "criador". */
export async function listarRequisitantesPendentes(estado: "pendente" | "falha" = "pendente"): Promise<string[]> {
  const res = await fetch(`/api/sod/requisitantes?estado=${estado}`);
  const json = await lerResposta<{ requisitantes: string[] }>(
    res,
    "Falha ao listar os criadores",
  );
  return json.requisitantes;
}

/** Resumo público do desfecho de uma execução (aprovação US-03). */
export interface ExecucaoResumo {
  desfecho: "executada" | "falha";
  httpStatus: number | null;
  /** Mensagens da Sinqia — no sucesso, identificam o tomador criado. */
  mensagens: string;
  detalhe?: string;
}

/**
 * Decide uma requisição pendente. Aprovar EXECUTA na Sinqia na sessão do
 * usuário logado (B2') e devolve o desfecho em `execucao`; reprovar exige
 * motivo e nunca chama a Sinqia. Concorrência → 409 com estado atual +
 * quem decidiu (mensagem do erro).
 */
export async function decidirRequisicao(
  id: string,
  decisao: "aprovar" | "reprovar",
  motivo?: string,
): Promise<{ requisicao: RequisicaoSod; execucao?: ExecucaoResumo }> {
  const res = await fetch(`/api/sod/requisicoes/${encodeURIComponent(id)}/decisao`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decisao, ...(motivo !== undefined ? { motivo } : {}) }),
  });
  return lerResposta(res, "Falha ao aplicar a decisão");
}

/**
 * Decide um LOTE (US-06): direção-base + exceções por item com motivo
 * (bidirecional). Os itens aprovados executam em background na sessão do
 * usuário logado — acompanhe pelo polling do detalhe (`execucao.emAndamento`).
 */
export async function decidirLote(
  id: string,
  decisao: "aprovar" | "reprovar",
  opts: { motivo?: string; excecoes?: ExcecaoLote[] } = {},
): Promise<{
  requisicao: RequisicaoSod;
  placar: PlacarLote;
  execucao?: { emAndamento: boolean; aprovados: number };
}> {
  const res = await fetch(`/api/sod/requisicoes/${encodeURIComponent(id)}/decisao`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      decisao,
      ...(opts.motivo !== undefined ? { motivo: opts.motivo } : {}),
      ...(opts.excecoes && opts.excecoes.length > 0 ? { excecoes: opts.excecoes } : {}),
    }),
  });
  return lerResposta(res, "Falha ao aplicar a decisão do lote");
}

/**
 * Retry manual de uma requisição em falha (US-10).
 */
export async function reprocessarFalha(
  id: string,
): Promise<{ requisicao: RequisicaoSod; execucao?: ExecucaoResumo }> {
  const res = await fetch(`/api/sod/requisicoes/${encodeURIComponent(id)}/retry`, {
    method: "POST",
  });
  return lerResposta(res, "Falha ao reprocessar a requisição");
}

/**
 * Descarte de uma requisição em falha (US-10). Motivo obrigatório.
 */
export async function descartarFalha(
  id: string,
  motivo: string,
): Promise<{ requisicao: RequisicaoSod }> {
  const res = await fetch(`/api/sod/requisicoes/${encodeURIComponent(id)}/descarte`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ motivo }),
  });
  return lerResposta(res, "Falha ao descartar a requisição");
}

/**
 * Conveniência de lote: reprocessar todas as falhas elegíveis do lote (US-10).
 */
export async function reprocessarFalhasLote(
  id: string,
): Promise<{
  requisicao: RequisicaoSod;
  placar: PlacarLote;
  execucao?: { emAndamento: boolean; aprovados: number };
}> {
  const res = await fetch(`/api/sod/requisicoes/${encodeURIComponent(id)}/retry-lote`, {
    method: "POST",
  });
  return lerResposta(res, "Falha ao reprocessar o lote");
}

/**
 * Retry manual de um item de lote em falha (US-10).
 */
export async function reprocessarItemLote(
  requisicaoId: string,
  itemId: string,
): Promise<{
  requisicao: RequisicaoSod;
  placar: PlacarLote;
  execucao?: { emAndamento: boolean; aprovados: number };
}> {
  const res = await fetch(`/api/sod/requisicoes/${encodeURIComponent(requisicaoId)}/itens/${encodeURIComponent(itemId)}/retry`, {
    method: "POST",
  });
  return lerResposta(res, "Falha ao reprocessar o item");
}

/**
 * Descarte de um item de lote em falha (US-10).
 */
export async function descartarItemLote(
  requisicaoId: string,
  itemId: string,
  motivo: string,
): Promise<{ requisicao: RequisicaoSod; placar: PlacarLote }> {
  const res = await fetch(`/api/sod/requisicoes/${encodeURIComponent(requisicaoId)}/itens/${encodeURIComponent(itemId)}/descarte`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ motivo }),
  });
  return lerResposta(res, "Falha ao descartar o item");
}


/* ------------------------------------------------------------------ */
/* Situação de cliente                                                 */
/* ------------------------------------------------------------------ */

export interface ClienteResumo {
  nrCliente: number | null;
  nome: string;
  documento: string;
  tipoPessoa: string;
  cdSituacao: number | null;
  dsSituacao: string;
  raw: Record<string, unknown>;
}

export interface TodosClientesResponse {
  env: string;
  items: ClienteResumo[];
  /** Bateu no teto do backend — a lista pode estar incompleta. */
  truncado: boolean;
  paginas: number;
  totalElements: number | null;
  /** Presente quando a Sinqia devolveu algo que não era JSON. */
  rawBody?: string;
}

/**
 * Carrega TODOS os clientes de uma vez (o backend varre as páginas).
 * O filtro por número/nome/documento acontece localmente sobre esse conjunto.
 */
export async function listarTodosClientes(
  tipoPessoa?: string,
): Promise<TodosClientesResponse> {
  const res = await fetch("/api/clientes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tipoPessoa }),
  });
  return lerResposta<TodosClientesResponse>(res, "Falha ao listar clientes");
}

/* --- Propostas do cliente (consulta, somente leitura) --- */

export interface PropostaResumo {
  nrProp: number;
  nrClient: number | null;
  dtProp: number | null;
  cdProd: number | null;
  vlFinan: number | null;
  vlPrest: number | null;
  vlTotal: number | null;
  vlLiquid: number | null;
  qtPrest: number | null;
  dtVct1ap: number | null;
}

/** Lista as propostas de um cliente pelo CPF/CNPJ. */
export async function listarPropostasCliente(
  documento: string,
): Promise<{ env: string; propostas: PropostaResumo[] }> {
  const res = await fetch(`/api/clientes/${encodeURIComponent(documento)}/propostas`);
  return lerResposta(res, "Falha ao consultar as propostas do cliente");
}

export interface ParcelaProposta {
  nrPresta: number;
  tpParc: number;
  dtVctpre: number;
  vlPrinc: number;
  vlJuros: number;
  vlPresta: number;
  vlSaldoDevedor?: number;
}

export interface DadosProposta {
  principal?: Record<string, unknown>;
  parcelas?: ParcelaProposta[];
  [k: string]: unknown;
}

/** Detalhe completo de uma proposta (principal + parcelas). */
export async function getDadosProposta(
  nrProsp: number,
): Promise<{ env: string; nrProsp: number; dados: DadosProposta }> {
  const res = await fetch(`/api/propostas-dados/${nrProsp}`);
  return lerResposta(res, "Falha ao consultar os dados da proposta");
}

export interface SituacaoAlvo {
  nrCliente: number;
  nome: string;
  documento: string;
  situacaoAnterior: string;
}

export interface SituacaoRowResult {
  nrCliente: number;
  nome: string;
  documento: string;
  situacaoAnterior: string;
  situacaoNova: string;
  /** NAO_ENVIADO = sessão expirou antes deste cliente ser tentado. */
  status: "OK" | "ERRO" | "NAO_ENVIADO";
  httpStatus: number | null;
  envelopeStatus?: string;
  globalMessage?: string;
  messages: string;
  detail?: string;
}

/**
 * Inicia a alteração de situação.
 *
 * Duas respostas possíveis, e quem chama precisa distinguir: fluxo DIRETO
 * devolve `jobId` (progresso por SSE); com a Esteira de Aprovação ativa (US-12)
 * devolve `aprovacao: true` + a requisição pendente criada, e **não existe
 * jobId** — abrir o SSE nesse caso pede `/api/situacao/stream/undefined` e o
 * operador vê um erro de backend, apesar de a requisição ter sido criada.
 */
export async function startAlterarSituacao(
  cdSituacao: number,
  alvos: SituacaoAlvo[],
): Promise<{
  jobId?: string;
  total?: number;
  env: string;
  aprovacao?: boolean;
  requisicao?: { id: string; estado: string; criadoEm: string; totalItens?: number };
}> {
  const res = await fetch("/api/situacao", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cdSituacao, alvos }),
  });
  return lerResposta(res, "Falha ao iniciar a alteração");
}

export interface SituacaoStreamHandlers {
  onSnapshot?: (d: {
    total: number;
    processed: number;
    success: number;
    error: number;
    results: SituacaoRowResult[];
    done: boolean;
  }) => void;
  onRow?: (row: SituacaoRowResult) => void;
  onProgress?: (p: {
    processed: number;
    total: number;
    success: number;
    error: number;
    naoEnviado?: number;
  }) => void;
  onFatal?: (d: { message: string }) => void;
  /** Sessão morreu no meio: o restante ficou como NAO_ENVIADO. */
  onSessaoExpirada?: (d: { message: string }) => void;
  onDone?: (d: { total: number; success: number; error: number }) => void;
  onError?: (e: Event) => void;
}

/** Abre o SSE de progresso da alteração de situação. Retorna função para fechar. */
export function streamSituacao(jobId: string, handlers: SituacaoStreamHandlers): () => void {
  const es = new EventSource(`/api/situacao/stream/${jobId}`);

  const on = (name: string, cb?: (d: any) => void) => {
    if (!cb) return;
    es.addEventListener(name, (ev) => {
      try {
        cb(JSON.parse((ev as MessageEvent).data));
      } catch {
        /* ignora payload malformado */
      }
    });
  };

  on("snapshot", handlers.onSnapshot);
  on("row", handlers.onRow);
  on("progress", handlers.onProgress);
  on("fatal", handlers.onFatal);
  on("sessao-expirada", handlers.onSessaoExpirada);
  on("done", (d) => {
    handlers.onDone?.(d);
    es.close();
  });

  es.onerror = (e) => handlers.onError?.(e);

  return () => es.close();
}

/* ------------------------------------------------------------------ */
/* Propostas (Backoffice de Originação)                                    */
/* ------------------------------------------------------------------ */

export interface ParseEmissoesResult {
  env: string;
  arquivo: string;
  total: number;
  porSituacao: Array<[string, number]>;
  avisos: string[];
  rows: EmissaoRow[];
}

/** Parse + pré-visualização do Emissoes.xlsx (não toca na Sinqia). */
export async function parseEmissoes(file: File): Promise<ParseEmissoesResult> {
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetch("/api/propostas/parse", { method: "POST", body: fd });
  return lerResposta<ParseEmissoesResult>(res, "Falha ao ler a planilha");
}

/** Parâmetros do cálculo já convertidos (a tela guarda como string). */
export interface CalculoParamsPayload {
  txJuros: number;
  cdProd: number;
  idCarCtr: number;
  /** AAAAMMDD. */
  dtContra: number;
}

export interface Divergencia {
  campo: string;
  excel: number;
  calculado: number;
}

export interface CalculoRowResult {
  linha: number;
  nome: string;
  cpf: string;
  nrClient: number | null;
  status: "OK" | "DIVERGENCIA" | "ERRO" | "NAO_ENVIADO";
  httpStatus: number | null;
  vlPrestaExcel: number | null;
  vlPrestaCalc: number | null;
  vlFinanciadoExcel: number | null;
  vlFinanciadoCalc: number | null;
  vlLiquidoExcel: number | null;
  vlLiquidCalc: number | null;
  vlIof: number | null;
  vlTotal: number | null;
  txCetAm: number | null;
  qtPrest: number | null;
  divergencias: Divergencia[];
  /** Request exato enviado ao calcProsp — é o que a revisão mostra. */
  request: Record<string, unknown>;
  messages: string;
  detail?: string;
}

/** Dispara o cálculo em lote (calcProsp por linha — nada é criado). */
export async function startCalcular(
  rows: EmissaoRow[],
  params: CalculoParamsPayload,
): Promise<{ jobId: string; total: number; ignoradas: number; env: string }> {
  const res = await fetch("/api/propostas/calcular", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rows, params }),
  });
  return lerResposta(res, "Falha ao iniciar o cálculo");
}

export interface CalculoStreamHandlers {
  onSnapshot?: (d: {
    total: number;
    processed: number;
    success: number;
    error: number;
    divergencia?: number;
    naoEnviado?: number;
    results: CalculoRowResult[];
    done: boolean;
  }) => void;
  onRow?: (row: CalculoRowResult) => void;
  onProgress?: (p: {
    processed: number;
    total: number;
    success: number;
    error: number;
    divergencia?: number;
    naoEnviado?: number;
  }) => void;
  onSessaoExpirada?: (d: { message: string }) => void;
  onFatal?: (d: { message: string }) => void;
  onDone?: (d: { total: number; success: number; error: number }) => void;
  onError?: (e: Event) => void;
}

/* --- Lookups dos parâmetros do lote (produto/convênio/loja) --- */

export interface LookupOption {
  codigo: number;
  descricao: string;
}

export interface LookupsResponse {
  env: string;
  produtos: LookupOption[];
  convenios: LookupOption[];
  filiais: LookupOption[];
  avisos: string[];
}

/* --- Onboarding (estado por usuário, na base local) --- */

export interface OnboardingEstado {
  env?: string;
  /** false = primeiro acesso (sem registro ainda). */
  existe: boolean;
  tourConcluido: boolean;
  checklistItens: Record<string, boolean>;
  hintsDispensados: string[];
}

export async function getOnboarding(): Promise<OnboardingEstado> {
  const res = await fetch("/api/onboarding");
  return lerResposta(res, "Falha ao consultar o onboarding");
}

/** Merge parcial: só os campos enviados são tocados. */
export async function salvarOnboarding(patch: {
  tourConcluido?: boolean;
  checklistItens?: Record<string, boolean>;
  hintsDispensados?: string[];
}): Promise<OnboardingEstado> {
  const res = await fetch("/api/onboarding", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  return lerResposta(res, "Falha ao salvar o onboarding");
}

/* --- Painel de propostas (somente leitura) --- */

export interface PropostaPainel {
  nrProsp: number;
  nrStatus: number | null;
  dsStatus: string;
  nrWf: number | null;
  dtEntrad: number | null;
  hrEntrad: number | null;
  nrCpfCnpj: string;
  nmClient: string;
  dtSolic: number | null;
  cdProd: number | null;
  dsProd: string;
  cdConv: number | null;
  nmConv: string;
  cdFilial: number | null;
  nmFilial: string;
  vlSolic: number | null;
  idCarctr: number | null;
  nrContra: number | null;
}

export interface PainelCursor {
  dtConsulta: string;
  hrConsulta: string;
  idSentido: "POS" | "ANT";
}

export interface PainelFiltros {
  nrPropos?: string;
  nrCPFCNPJ?: string;
  nmClient?: string;
  /** AAAAMMDD como string. */
  dtPerIni?: string;
  dtPerFim?: string;
  nrStatus?: number;
  cdProdut?: number;
  /** Convênio de produção (cdConvProd). */
  cdConvProd?: number;
}

/** Listagem geral de propostas (todas, com filtros e cursor de paginação). */
export async function painelPropostas(input: {
  filtros?: PainelFiltros;
  size?: number;
  cursor?: PainelCursor;
}): Promise<{
  env: string;
  propostas: PropostaPainel[];
  proximoCursor: PainelCursor | null;
}> {
  const res = await fetch("/api/propostas/painel", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return lerResposta(res, "Falha ao consultar o painel de propostas");
}

export interface FilaWf {
  nrWf: number;
  nrStatus: number;
  dsStatus: string;
  qtFilhos: number;
}

/** Filas do workflow com a contagem de propostas em cada status. */
export async function getFilasPropostas(): Promise<{ env: string; filas: FilaWf[] }> {
  const res = await fetch("/api/propostas/filas");
  return lerResposta(res, "Falha ao consultar as filas do workflow");
}

export interface VisaoGeralFila extends FilaWf {
  /** Contagem respeitando o filtro de convênio (null = varredura estourou o teto). */
  noFiltro: number | null;
  /** Propostas paradas na etapa acima da régua de SLA (null = não varrida). */
  atrasadas: number | null;
}

export interface SerieValorMes {
  cdConv: number | null;
  nmConv: string;
  total: number;
}

export interface ValorOriginadoResumo {
  /** De onde sai o R$ — hoje, vlSolic (valor solicitado). */
  moeda: string;
  originadoMesAtual: number;
  originadoMesAnterior: number;
  ticketMedio: number | null;
  ticketMediana: number | null;
  /** Quantos contratos efetivados sustentam os números (denominador). */
  contratos: number;
  /** Soma do líquido REGISTRADO localmente (só criações pela ferramenta). */
  liquidoLiberado: number | null;
  liquidoCobertura: number;
  porMes: Array<{ mes: string; series: SerieValorMes[] }>;
}

export interface FunilResumo {
  /** null quando o filtro de convênio está ativo (degrau não comparável). */
  tomadores: number | null;
  propostas: number;
  /** Aproximação por estado atual (≥ aprovado p/ desembolso). */
  aprovadas: number;
  efetivadas: number;
}

export interface VelocidadeResumo {
  /** Quantas efetivadas entraram no cálculo (amostra do histórico). */
  base: number;
  capAtingido: boolean;
  cicloMedioDias: number | null;
  cicloMedianaDias: number | null;
  tempoPorEtapa: Array<{ dsStatus: string; mediaHoras: number; n: number }>;
  throughputSemanas: Array<{ semana: string; total: number }>;
}

export interface VisaoGeralResponse {
  env: string;
  convenio: number | null;
  slaHoras: number;
  /** true = a varredura bateu no teto de consultas; contagens podem faltar. */
  parcial: boolean;
  totalAtrasadas: number;
  filas: VisaoGeralFila[];
  valor: ValorOriginadoResumo;
  funil: FunilResumo;
  velocidade: VelocidadeResumo;
  geradoEm: string;
}

/** Dashboard agregado da esteira — filtrável por convênio, com SLA por etapa. */
export async function getVisaoGeralEsteira(
  convenio?: number,
  forcar = false,
): Promise<VisaoGeralResponse> {
  const qs = new URLSearchParams();
  if (convenio !== undefined) qs.set("convenio", String(convenio));
  if (forcar) qs.set("forcar", "1");
  const sufixo = qs.toString() ? `?${qs}` : "";
  const res = await fetch(`/api/propostas/visao-geral${sufixo}`);
  return lerResposta(res, "Falha ao consultar a visão geral da esteira");
}

export interface HistoricoPropostaItem {
  nrSeq: number;
  dtIn: string;
  nmUsr: string;
  nrStatus: number | null;
  dsStatus: string;
  dsObserv: string;
}

/** Linha do tempo (histórico de status) de uma proposta. */
export async function getHistoricoProposta(
  nrProsp: number,
): Promise<{ env: string; historicos: HistoricoPropostaItem[] }> {
  const res = await fetch(`/api/propostas-historico/${nrProsp}`);
  return lerResposta(res, "Falha ao consultar o histórico da proposta");
}

export interface TransicaoStatus {
  proxStatus: number;
  nrWf: number;
  dsStatus: string;
  exigeObservacao: boolean;
}

/** Para onde a proposta pode ir a partir do status atual (somente leitura). */
export async function getTransicoesProposta(
  nrWf: number,
  nrStatus: number,
): Promise<{ env: string; transicoes: TransicaoStatus[] }> {
  const res = await fetch(`/api/propostas-transicoes?nrWf=${nrWf}&nrStatus=${nrStatus}`);
  return lerResposta(res, "Falha ao consultar as transições permitidas");
}

/* --- Transferência em lote --- */

export interface TransferenciaRowResult {
  nrProsp: number;
  nmCliente: string;
  status: "OK" | "ERRO" | "NAO_ENVIADO";
  detalhe: string;
}

/** Proposta da seleção bloqueada por movimentação ativa (US-09, RN04). */
export interface InelegivelMovimentacao {
  nrProsp: number;
  nmCliente: string;
  requisicaoId: string;
  estado: EstadoRequisicao;
  /** true = o bloqueio vem de um item de OUTRO lote de movimentação. */
  lote: boolean;
  motivo: string;
}

/**
 * Inicia a movimentação em lote. Fluxo DIRETO (flag OFF): job com progresso
 * (`jobId`). Sob aprovação (US-09): cria a requisição-LOTE pendente
 * (`aprovacao: true`) — zero Sinqia; ou pede confirmação de SUBCONJUNTO
 * (`confirmacaoNecessaria: true`) quando parte da seleção está bloqueada.
 */
export async function startTransferirLote(input: {
  nrWf: number;
  nrStatusAtual: number;
  /** Nome da etapa de origem — exibido no detalhe da requisição (US-09). */
  dsStatusAtual?: string;
  proxStatus: number;
  dsObserv: string;
  /** Cria o lote só com as elegíveis, após o usuário confirmar (RN04). */
  confirmarSubconjunto?: boolean;
  itens: Array<{
    nrProsp: number;
    nrCpf: string;
    nmCliente: string;
    cdProd: number;
    nrContra: number | null;
  }>;
}): Promise<{
  env?: string;
  /** Fluxo direto (flag OFF). */
  jobId?: string;
  total?: number;
  destino?: { proxStatus: number; dsStatus: string };
  /** Sob aprovação (US-09): requisição-lote criada. */
  aprovacao?: boolean;
  requisicao?: { id: string; estado: string; criadoEm: string };
  totalItens?: number;
  inelegiveis?: InelegivelMovimentacao[];
  /** 409 SUBCONJUNTO_NAO_CONFIRMADO: a UI confirma e reenviará. */
  confirmacaoNecessaria?: boolean;
  elegiveis?: number;
}> {
  const res = await fetch("/api/propostas-transferir-lote", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (res.status === 409) {
    // clone(): o corpo ainda precisa estar legível para o lerResposta abaixo.
    const corpo = (await res
      .clone()
      .json()
      .catch(() => null)) as {
      code?: string;
      inelegiveis?: InelegivelMovimentacao[];
      elegiveis?: number;
    } | null;
    if (corpo?.code === "SUBCONJUNTO_NAO_CONFIRMADO") {
      return {
        confirmacaoNecessaria: true,
        inelegiveis: corpo.inelegiveis ?? [],
        elegiveis: corpo.elegiveis ?? 0,
      };
    }
  }
  return lerResposta(res, "Falha ao iniciar a transferência em lote");
}

export interface TransferenciaStreamHandlers {
  onSnapshot?: (d: {
    total: number;
    processed: number;
    success: number;
    error: number;
    naoEnviado?: number;
    results: TransferenciaRowResult[];
    done: boolean;
  }) => void;
  onRow?: (row: TransferenciaRowResult) => void;
  onProgress?: (p: {
    processed: number;
    total: number;
    success: number;
    error: number;
    naoEnviado?: number;
  }) => void;
  onSessaoExpirada?: (d: { message: string }) => void;
  onDone?: (d: unknown) => void;
  onError?: (e: Event) => void;
}

/** Abre o SSE da transferência em lote. Retorna função para fechar. */
export function streamTransferenciaLote(
  jobId: string,
  handlers: TransferenciaStreamHandlers,
): () => void {
  const es = new EventSource(`/api/propostas-transferir-lote/stream/${jobId}`);

  const on = (name: string, cb?: (d: any) => void) => {
    if (!cb) return;
    es.addEventListener(name, (ev) => {
      try {
        cb(JSON.parse((ev as MessageEvent).data));
      } catch {
        /* evento malformado não derruba o stream */
      }
    });
  };

  on("snapshot", handlers.onSnapshot);
  on("row", handlers.onRow);
  on("progress", handlers.onProgress);
  on("sessao-expirada", handlers.onSessaoExpirada);
  on("done", (d) => {
    handlers.onDone?.(d);
    es.close();
  });
  if (handlers.onError) es.onerror = handlers.onError;

  return () => es.close();
}

/* --- Personas (base local) --- */

export interface PersonaOverride {
  documento: string;
  tpPessoa: string;
  tomador: boolean;
}

/** Exceções de persona do ambiente (a regra PF=tomador é implícita). */
export async function getPersonas(): Promise<{ env: string; overrides: PersonaOverride[] }> {
  const res = await fetch("/api/personas");
  return lerResposta(res, "Falha ao consultar as personas");
}

/** Define a persona de um cliente (PJ promovida a tomadora, PF despromovida). */
export async function salvarPersona(input: {
  documento: string;
  tpPessoa: "F" | "J";
  tomador: boolean;
}): Promise<{ env: string; ok: boolean }> {
  const res = await fetch("/api/personas", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return lerResposta(res, "Falha ao salvar a persona");
}

/**
 * MOVE a proposta de fila (transfStatus — efeito real no workflow). Com a
 * Esteira de Aprovação ativa (US-08), NADA vai à Sinqia: a resposta traz
 * `aprovacao: true` + a requisição pendente criada, e a proposta permanece
 * na etapa de origem com o indicador do painel até a decisão.
 */
export async function transferirProposta(input: {
  nrProsp: number;
  nrWf: number;
  nrStatusAtual: number;
  /** Nome da etapa de origem — exibido no detalhe da requisição (US-08). */
  dsStatusAtual?: string;
  proxStatus: number;
  dsObserv: string;
  nrCpf: string;
  nmCliente: string;
  cdProd: number;
  nrContra: number | null;
}): Promise<{
  env: string;
  ok?: boolean;
  destino: { proxStatus: number; dsStatus: string };
  aprovacao?: boolean;
  requisicao?: { id: string; estado: string; criadoEm: string };
}> {
  const res = await fetch("/api/propostas-transferir", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return lerResposta(res, "Falha ao transferir a proposta");
}

/**
 * Movimentação de proposta em requisição ATIVA (US-08, RN05): pendente,
 * executando ou em falha — é o que segura o bloqueio por proposta. Fonte
 * ÚNICA (US-09): cobre requisições individuais E itens de lote de
 * movimentação — `lote`/`itemId` distinguem a morada.
 */
export interface MovimentacaoAtiva {
  requisicaoId: string;
  estado: EstadoRequisicao;
  nrProsp: number | null;
  requisitante: string;
  criadoEm: string;
  origem: { nrStatus: number; dsStatus: string } | null;
  destino: { proxStatus: number; dsStatus: string } | null;
  /** true = item de requisição-LOTE de movimentação (US-09). */
  lote?: boolean;
  itemId?: string;
  causaFalha?: string;
}

/**
 * TODAS as movimentações ativas do ambiente em UMA chamada — o Painel de
 * Propostas desenha os indicadores a partir daqui (nunca uma consulta por
 * proposta; requisito de performance da US-08).
 */
export async function getMovimentacoesAtivas(): Promise<{
  movimentacoes: MovimentacaoAtiva[];
}> {
  const res = await fetch("/api/sod/movimentacoes-ativas");
  return lerResposta(res, "Falha ao consultar as movimentações em aprovação");
}

/* --- Proposta individual (fluxo unitário) --- */

export interface ClienteBuscaResponse {
  env: string;
  httpStatus: number;
  encontrado: boolean;
  nrClient: number | null;
  nome: string;
}

/** Busca o cliente por CPF no ambiente ativo (somente leitura). */
export async function buscarClienteParaProposta(cpf: string): Promise<ClienteBuscaResponse> {
  const res = await fetch(`/api/propostas/cliente/${encodeURIComponent(cpf)}`);
  return lerResposta(res, "Falha ao buscar o cliente");
}

export interface DadosOperacaoPayload {
  vlLiquido: number;
  qtParcelas: number;
  /** AAAAMMDD. */
  dtVct1Ap: number;
  vlTac?: number;
  vlSeguro?: number;
  vlOutros?: number;
}

export interface CalculoUmaResumo {
  vlPresta: number;
  vlFinanciado: number;
  vlLiquid: number;
  vlIof: number | null;
  vlTotal: number | null;
  txAm: number;
  txCetAm: number | null;
  qtPrest: number;
  dtVct1ap: number;
  dtVctult: number | null;
  vlTac: number;
  vlSeguro: number;
  vlOutvlr: number;
}

export interface CalcularUmaResponse {
  env: string;
  calcId: string;
  httpStatus: number;
  messages: string;
  request: unknown;
  resumo: CalculoUmaResumo;
}

/** Calcula UMA operação (calcProsp — nada é gravado). O cálculo fica retido no servidor. */
export async function calcularUmaProposta(input: {
  cpf: string;
  nome: string;
  dados: DadosOperacaoPayload;
  params: CalculoParamsPayload;
}): Promise<CalcularUmaResponse> {
  const res = await fetch("/api/propostas/calcular-uma", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return lerResposta(res, "Falha ao calcular a proposta");
}

/**
 * Resposta do criar-uma. Com a Esteira de Aprovação ativa (US-04), nada vai à
 * Sinqia: `aprovacao: true` + a requisição pendente criada; os campos de
 * CriacaoRowResult só existem no fluxo direto.
 */
export type CriarUmaPropostaResponse = Partial<CriacaoRowResult> & {
  env: string;
  aprovacao?: boolean;
  requisicao?: { id: string; estado: string; criadoEm: string };
};

/** CRIA a proposta individual na Sinqia (irreversível) — ou, com a aprovação ativa, cria a requisição. */
export async function criarUmaProposta(input: {
  calcId: string;
  /** cdLoja ausente = proposta sem loja/filial. */
  params: CalculoParamsPayload & { cdConven: string; cdLoja?: number };
  forcarDuplicada: boolean;
}): Promise<CriarUmaPropostaResponse> {
  const res = await fetch("/api/propostas/criar-uma", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return lerResposta(res, "Falha ao criar a proposta");
}

/** Listas da Sinqia para os selects de parâmetros (somente leitura). */
export async function getLookups(
  idCarctr: number,
  convenio?: number,
): Promise<LookupsResponse> {
  const qs = new URLSearchParams({ idCarctr: String(idCarctr) });
  if (convenio !== undefined && Number.isFinite(convenio)) {
    qs.set("convenio", String(convenio));
  }
  const res = await fetch(`/api/propostas/lookups?${qs}`);
  return lerResposta<LookupsResponse>(res, "Falha ao carregar as listas da Sinqia");
}

/* --- Criação das propostas (Fase 3 — irreversível) --- */

export interface CriacaoRowResult {
  linha: number;
  nome: string;
  cpf: string;
  nrClient: number | null;
  /** Nº da proposta gerado pela Sinqia (quando identificável). */
  nrProsp: string | null;
  /** JA_EXISTE = proposta idêntica encontrada — nada foi criado. */
  status: "OK" | "JA_EXISTE" | "ERRO" | "NAO_ENVIADO";
  httpStatus: number | null;
  envelopeStatus?: string;
  globalMessage?: string;
  messages: string;
  detail?: string;
}

export async function startCriarPropostas(input: {
  calcJobId: string;
  linhas: number[];
  /** cdLoja ausente = proposta sem loja/filial. */
  params: CalculoParamsPayload & { cdConven: string; cdLoja?: number };
  piloto: boolean;
  /** true = cria mesmo com proposta idêntica existente (reemissão consciente). */
  forcarDuplicadas: boolean;
  /** US-07 (sob aprovação): arquivo de tomadores retido — lote COMPOSTO. */
  tomadoresUploadId?: string;
  /** US-07 (sob aprovação): nome do arquivo de propostas, para exibição. */
  arquivo?: string;
}): Promise<{
  env: string;
  /** Fluxo direto: job com SSE. */
  jobId?: string;
  total?: number;
  ignoradas?: number;
  piloto?: boolean;
  /** Esteira de Aprovação (US-07): true = virou requisição-lote pendente. */
  aprovacao?: boolean;
  requisicao?: {
    id: string;
    estado: string;
    criadoEm: string;
    totalItens: number;
    composto: boolean;
    vinculos: number;
  };
}> {
  const res = await fetch("/api/propostas/criar", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return lerResposta(res, "Falha ao iniciar a criação");
}

/**
 * LOTE COMPOSTO (US-07): envia o arquivo de TOMADORES (CSV/JSON, mesmo
 * formato do módulo Tomadores) para o servidor reter — a requisição-lote
 * referencia o upload por id. Sob aprovação apenas.
 */
export async function parseTomadoresLote(
  file: File,
  control: BatchControlPayload = {},
): Promise<{
  env: string;
  uploadId: string;
  arquivo: string;
  total: number;
  tomadores: Array<{ index: number; nome: string; documento: string; tipo: string }>;
}> {
  const res = await fetch("/api/propostas/tomadores/parse", {
    method: "POST",
    body: buildForm(file, control),
  });
  return lerResposta(res, "Falha ao ler o arquivo de tomadores");
}

export interface CriacaoStreamHandlers {
  onSnapshot?: (d: {
    total: number;
    processed: number;
    success: number;
    jaExiste?: number;
    error: number;
    naoEnviado?: number;
    results: CriacaoRowResult[];
    done: boolean;
  }) => void;
  onRow?: (row: CriacaoRowResult) => void;
  onProgress?: (p: {
    processed: number;
    total: number;
    success: number;
    jaExiste?: number;
    error: number;
    naoEnviado?: number;
  }) => void;
  onSessaoExpirada?: (d: { message: string }) => void;
  onDone?: (d: unknown) => void;
  onError?: (e: Event) => void;
}

/** Abre o SSE da criação. Retorna função para fechar. */
export function streamCriacao(jobId: string, handlers: CriacaoStreamHandlers): () => void {
  const es = new EventSource(`/api/propostas/criar/stream/${jobId}`);

  const on = (name: string, cb?: (d: any) => void) => {
    if (!cb) return;
    es.addEventListener(name, (ev) => {
      try {
        cb(JSON.parse((ev as MessageEvent).data));
      } catch {
        /* ignora payload malformado */
      }
    });
  };

  on("snapshot", handlers.onSnapshot);
  on("row", handlers.onRow);
  on("progress", handlers.onProgress);
  on("sessao-expirada", handlers.onSessaoExpirada);
  on("done", (d) => {
    handlers.onDone?.(d);
    es.close();
  });

  es.onerror = (e) => handlers.onError?.(e);

  return () => es.close();
}

/* --- Verificação de clientes na Sinqia (somente leitura) --- */

export interface VerificacaoRowResult {
  linha: number;
  nome: string;
  cpf: string;
  nrClientPlanilha: number | null;
  nrClientSinqia: number | null;
  nomeSinqia: string;
  status: "ENCONTRADO" | "DIVERGE" | "NAO_ENCONTRADO" | "ERRO" | "NAO_ENVIADO";
  httpStatus: number | null;
  detail?: string;
}

export async function startVerificarClientes(
  alvos: Array<{ linha: number; nome: string; cpf: string; nrClient: number | null }>,
): Promise<{ jobId: string; total: number; env: string }> {
  const res = await fetch("/api/propostas/verificar-clientes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ alvos }),
  });
  return lerResposta(res, "Falha ao iniciar a verificação");
}

export interface VerificacaoStreamHandlers {
  onSnapshot?: (d: {
    total: number;
    processed: number;
    success: number;
    diverge?: number;
    naoEncontrado?: number;
    error: number;
    naoEnviado?: number;
    results: VerificacaoRowResult[];
    done: boolean;
  }) => void;
  onRow?: (row: VerificacaoRowResult) => void;
  onProgress?: (p: {
    processed: number;
    total: number;
    success: number;
    diverge?: number;
    naoEncontrado?: number;
    error: number;
    naoEnviado?: number;
  }) => void;
  onSessaoExpirada?: (d: { message: string }) => void;
  onDone?: (d: unknown) => void;
  onError?: (e: Event) => void;
}

/** Abre o SSE da verificação de clientes. Retorna função para fechar. */
export function streamVerificacao(
  jobId: string,
  handlers: VerificacaoStreamHandlers,
): () => void {
  const es = new EventSource(`/api/propostas/verificar-clientes/stream/${jobId}`);

  const on = (name: string, cb?: (d: any) => void) => {
    if (!cb) return;
    es.addEventListener(name, (ev) => {
      try {
        cb(JSON.parse((ev as MessageEvent).data));
      } catch {
        /* ignora payload malformado */
      }
    });
  };

  on("snapshot", handlers.onSnapshot);
  on("row", handlers.onRow);
  on("progress", handlers.onProgress);
  on("sessao-expirada", handlers.onSessaoExpirada);
  on("done", (d) => {
    handlers.onDone?.(d);
    es.close();
  });

  es.onerror = (e) => handlers.onError?.(e);

  return () => es.close();
}

/** Abre o SSE de progresso do cálculo. Retorna função para fechar. */
export function streamCalculo(jobId: string, handlers: CalculoStreamHandlers): () => void {
  const es = new EventSource(`/api/propostas/calcular/stream/${jobId}`);

  const on = (name: string, cb?: (d: any) => void) => {
    if (!cb) return;
    es.addEventListener(name, (ev) => {
      try {
        cb(JSON.parse((ev as MessageEvent).data));
      } catch {
        /* ignora payload malformado */
      }
    });
  };

  on("snapshot", handlers.onSnapshot);
  on("row", handlers.onRow);
  on("progress", handlers.onProgress);
  on("sessao-expirada", handlers.onSessaoExpirada);
  on("fatal", handlers.onFatal);
  on("done", (d) => {
    handlers.onDone?.(d);
    es.close();
  });

  es.onerror = (e) => handlers.onError?.(e);

  return () => es.close();
}

/** Abre o SSE de progresso. Retorna uma função para fechar. */
export function streamImport(jobId: string, handlers: StreamHandlers): () => void {
  const es = new EventSource(`/api/import/stream/${jobId}`);

  const on = (name: string, cb?: (d: any) => void) => {
    if (!cb) return;
    es.addEventListener(name, (ev) => {
      try {
        cb(JSON.parse((ev as MessageEvent).data));
      } catch {
        /* ignora payload malformado */
      }
    });
  };

  on("snapshot", handlers.onSnapshot);
  on("row", handlers.onRow);
  on("progress", handlers.onProgress);
  on("sessao-expirada", handlers.onSessaoExpirada);
  on("fatal", handlers.onFatal);
  on("done", (d) => {
    handlers.onDone?.(d);
    es.close();
  });

  es.onerror = (e) => handlers.onError?.(e);

  return () => es.close();
}
