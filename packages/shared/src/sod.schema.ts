import { z } from "zod";

/**
 * Esteira de Aprovação (SoD) — contratos da camada de requisições (US-01).
 *
 * Aqui ficam só os TIPOS e REGRAS PURAS compartilháveis (front usa a partir da
 * US-02); a máquina de estados executável e a persistência vivem no BFF
 * (apps/api/src/sod/).
 */

/* ------------------------------------------------------------------ */
/* Estados e transições (RN02)                                         */
/* ------------------------------------------------------------------ */

/** Os nomes seguem a nomenclatura do negócio — inclusive `aprovada/executando`. */
export const ESTADOS_REQUISICAO = [
  "pendente",
  "aprovada/executando",
  "executada",
  "falha",
  "reprovada",
  "cancelada",
  "descartada",
] as const;

export type EstadoRequisicao = (typeof ESTADOS_REQUISICAO)[number];

export const estadoRequisicaoSchema = z.enum(ESTADOS_REQUISICAO);

/** Estados que encerram o ciclo de vida — nenhuma transição sai deles. */
export const ESTADOS_TERMINAIS: readonly EstadoRequisicao[] = [
  "executada",
  "reprovada",
  "cancelada",
  "descartada",
];

/**
 * Transições permitidas (qualquer outra é inválida e auditada).
 * `falha → aprovada/executando` (retry) e `falha → descartada` chegam como
 * FUNCIONALIDADE na Onda 2 (US-10), mas a máquina já as reconhece desde a
 * fundação para a modelagem não precisar mudar.
 */
export const TRANSICOES_PERMITIDAS: Record<EstadoRequisicao, readonly EstadoRequisicao[]> = {
  pendente: ["aprovada/executando", "reprovada", "cancelada"],
  "aprovada/executando": ["executada", "falha"],
  falha: ["aprovada/executando", "descartada"],
  executada: [],
  reprovada: [],
  cancelada: [],
  descartada: [],
};

export function transicaoPermitida(de: EstadoRequisicao, para: EstadoRequisicao): boolean {
  return TRANSICOES_PERMITIDAS[de].includes(para);
}

/* ------------------------------------------------------------------ */
/* Requisição-LOTE (US-06): itens com estado próprio                    */
/* ------------------------------------------------------------------ */

/**
 * Máquina de estados de um ITEM de lote — espelha a individual, com uma única
 * transição a mais: `pendente → falha`. Um item aprovado fica `pendente` (na
 * fila de execução) até a sua vez; se a execução do lote for interrompida
 * antes de chegar nele (sessão expirada, queda), o item vai direto a `falha`
 * com a causa registrada (RN04/RN05, Cenário 4) — nunca fica órfão.
 */
export const TRANSICOES_ITEM_LOTE: Record<EstadoRequisicao, readonly EstadoRequisicao[]> = {
  pendente: ["aprovada/executando", "reprovada", "cancelada", "falha"],
  "aprovada/executando": ["executada", "falha"],
  falha: ["aprovada/executando", "descartada"],
  executada: [],
  reprovada: [],
  cancelada: [],
  descartada: [],
};

export function transicaoItemPermitida(de: EstadoRequisicao, para: EstadoRequisicao): boolean {
  return TRANSICOES_ITEM_LOTE[de].includes(para);
}

/**
 * Tipos de ação de LOTE e o tipo INDIVIDUAL que cada item executa — os
 * executores registrados (US-03/04) são reusados item a item, sem segundo
 * caminho Sinqia. US-09/12 acrescentam as suas entradas aqui.
 *
 * O valor é o tipo PRINCIPAL do lote; o lote COMPOSTO da US-07
 * (`proposta.criar_lote`) admite TAMBÉM itens `tomador.cadastrar` — ver
 * `TIPOS_DE_ITEM_DO_LOTE`.
 */
export const TIPO_ITEM_DO_LOTE: Partial<Record<TipoAcaoSod, TipoAcaoSod>> = {
  "tomador.cadastrar_lote": "tomador.cadastrar",
  "proposta.criar_lote": "proposta.criar",
  "proposta.movimentar_massa": "proposta.movimentar",
};

/**
 * Tipos de item ADMITIDOS em cada tipo de lote. O lote de propostas (US-07) é
 * potencialmente COMPOSTO: tomadores a cadastrar + propostas vinculadas, do
 * mesmo upload — a ordem de execução (tomadores primeiro) e o vínculo
 * tomador→proposta são responsabilidade de quem monta os itens (rota) e do
 * pipeline de execução (execucao-lote.ts), nunca do aprovador.
 */
export const TIPOS_DE_ITEM_DO_LOTE: Partial<Record<TipoAcaoSod, readonly TipoAcaoSod[]>> = {
  "tomador.cadastrar_lote": ["tomador.cadastrar"],
  "proposta.criar_lote": ["tomador.cadastrar", "proposta.criar"],
  "proposta.movimentar_massa": ["proposta.movimentar"],
};

export function ehTipoLote(tipo: TipoAcaoSod): boolean {
  return tipo in TIPO_ITEM_DO_LOTE;
}

/** Placar de um lote — contagem de itens por estado (RN01: estado derivado). */
export interface PlacarLote {
  total: number;
  pendentes: number;
  executando: number;
  executadas: number;
  falhas: number;
  reprovadas: number;
  canceladas: number;
}

export function placarVazio(): PlacarLote {
  return {
    total: 0,
    pendentes: 0,
    executando: 0,
    executadas: 0,
    falhas: 0,
    reprovadas: 0,
    canceladas: 0,
  };
}

/** Monta o placar a partir de contagens por estado (linhas do GROUP BY). */
export function montarPlacar(contagens: Array<{ estado: EstadoRequisicao; n: number }>): PlacarLote {
  const p = placarVazio();
  for (const { estado, n } of contagens) {
    p.total += n;
    if (estado === "pendente") p.pendentes += n;
    else if (estado === "aprovada/executando") p.executando += n;
    else if (estado === "executada") p.executadas += n;
    else if (estado === "falha") p.falhas += n;
    else if (estado === "reprovada") p.reprovadas += n;
    else if (estado === "cancelada") p.canceladas += n;
  }
  return p;
}

/**
 * Desfecho do LOTE ao fim da execução (RN01, estado derivado dos itens):
 * qualquer item em `falha` → lote `falha` (repouso; retry por item na US-10);
 * caso contrário `executada` — exceções reprovadas não tornam o lote falho.
 */
export function derivarDesfechoLote(placar: PlacarLote): "executada" | "falha" {
  return placar.falhas > 0 ? "falha" : "executada";
}

/* ------------------------------------------------------------------ */
/* Tipos de ação (registro extensível)                                 */
/* ------------------------------------------------------------------ */

/**
 * Registro dos tipos de ação sensível que viram requisição. Cada US futura
 * ACRESCENTA a sua entrada aqui — enum fechado de propósito: tipo desconhecido
 * é erro, nunca linha órfã na base.
 */
export const TIPOS_ACAO_SOD = [
  "tomador.cadastrar", // US-02
  "proposta.criar", // US-04
  "tomador.cadastrar_lote", // US-06
  "proposta.criar_lote", // US-07
  "proposta.movimentar", // US-08
  "proposta.movimentar_massa", // US-09
  "tomador.alterar_situacao", // US-12
] as const;

export type TipoAcaoSod = (typeof TIPOS_ACAO_SOD)[number];

export const tipoAcaoSodSchema = z.enum(TIPOS_ACAO_SOD);

/** Rótulos legíveis dos tipos — a UI (US-02+) exibe estes, nunca o código. */
export const ROTULO_TIPO_ACAO: Record<TipoAcaoSod, string> = {
  "tomador.cadastrar": "Cadastro de tomador",
  "proposta.criar": "Criação de proposta",
  "tomador.cadastrar_lote": "Cadastro de tomadores em lote",
  "proposta.criar_lote": "Criação de propostas em lote",
  "proposta.movimentar": "Movimentação de proposta",
  "proposta.movimentar_massa": "Movimentação de propostas em massa",
  "tomador.alterar_situacao": "Alteração de situação de tomador",
};

/* ------------------------------------------------------------------ */
/* Movimentação de proposta (US-08)                                    */
/* ------------------------------------------------------------------ */

/**
 * Estados em que uma requisição de `proposta.movimentar` BLOQUEIA nova
 * movimentação da mesma proposta (US-08, RN03): pendente e executando pelo
 * ciclo natural, e `falha` DE PROPÓSITO — a divergência precisa ser resolvida
 * (retry ou descarte, US-10) antes de qualquer nova tentativa. Terminais
 * (executada/reprovada/cancelada/descartada) liberam. A US-09 valida os lotes
 * de movimentação contra esta MESMA definição.
 */
export const ESTADOS_BLOQUEIO_MOVIMENTACAO: readonly EstadoRequisicao[] = [
  "pendente",
  "aprovada/executando",
  "falha",
];

/**
 * Payload canônico de `proposta.movimentar` (US-08, RN02): a identificação
 * completa da movimentação para o aprovador conferir o mérito (proposta,
 * etapa de origem e de destino, observação) + o `request` EXATO do
 * transfStatus que a execução reenvia na sessão do aprovador (RN05/RN08 —
 * nunca reconstruído). O destino foi validado contra o consultarStatusTransf
 * (as transições que o workflow permite) na CRIAÇÃO, na sessão do
 * requisitante — a execução revalida a origem antes de mover (Cenário 4).
 */
export interface MovimentacaoSodPayload {
  movimentacao: {
    nrProsp: number;
    nmCliente: string;
    nrCpf: string;
    nrWf: number;
    origem: { nrStatus: number; dsStatus: string };
    destino: { proxStatus: number; dsStatus: string };
    dsObserv: string;
    cdProd: number;
    nrContra: number | null;
  };
  /** Request EXATO do transfStatus — a execução o reenvia intacto. */
  request: Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/* Movimentação de propostas em MASSA (US-09)                          */
/* ------------------------------------------------------------------ */

/**
 * Payload canônico da REQUISIÇÃO-LOTE de movimentação (US-09): a transição
 * ÚNICA do lote (homogeneidade RN02 — todas saem da mesma fila para o mesmo
 * destino) + a contagem que as listagens exibem. Os dados de cada proposta
 * vivem nos ITENS (`MovimentacaoLoteItemSodPayload`) — o lote é o envelope.
 */
export interface MovimentacaoLoteSodPayload {
  fila: { nrWf: number; origem: { nrStatus: number; dsStatus: string } };
  destino: { proxStatus: number; dsStatus: string };
  dsObserv: string;
  totalItens: number;
  /**
   * Propostas da seleção que ficaram DE FORA por bloqueio ativo (RN04):
   * o lote só nasce sem elas com confirmação explícita do requisitante.
   */
  inelegiveisRemovidas: number;
}

/**
 * Payload canônico de um ITEM de movimentação em massa: o MESMO formato da
 * individual (US-08 — executor e chave de bloqueio reusados item a item) +
 * posição na seleção e resumo de exibição (`documento` = nº da proposta).
 */
export interface MovimentacaoLoteItemSodPayload extends MovimentacaoSodPayload {
  ordem: number;
  resumo: { nome: string; documento: string };
}

/* ------------------------------------------------------------------ */
/* Chave de duplicidade (guarda de pendentes — RN02 US-02 / RN04 US-04) */
/* ------------------------------------------------------------------ */

/** CPF/CNPJ reduzido a dígitos — a forma canônica comparável e indexável. */
export function normalizarDocumento(doc: string): string {
  return doc.replace(/\D/g, "");
}

/**
 * Payload canônico de `proposta.criar` (US-04): os INSUMOS da execução
 * (`proposta` + `calcRequest`) e os valores do cálculo do requisitante como
 * REFERÊNCIA rotulada (RN06) — o cálculo oficial acontece na execução, na
 * sessão do aprovador (decisão do PM no checkpoint A).
 */
export interface PropostaSodPayload {
  proposta: {
    cpf: string;
    nome: string;
    dados: {
      vlLiquido: number;
      qtParcelas: number;
      dtVct1Ap: number;
      vlTac?: number;
      vlSeguro?: number;
      vlOutros?: number;
    };
    params: {
      txJuros: number;
      cdProd: number;
      idCarCtr: number;
      cdConven: string;
      cdLoja?: number;
      dtContra: number;
    };
    forcarDuplicada: boolean;
  };
  /** Request EXATO do calcProsp do requisitante — a execução recalcula com ele. */
  calcRequest: Record<string, unknown>;
  referencia: {
    rotulo: string;
    calculadoEm: string;
    resumo: {
      vlPresta: number;
      vlFinanciado: number;
      vlLiquid: number;
      vlIof: number;
      vlTotal: number;
      txAm: number;
      txCetAm: number | null;
      qtPrest: number;
      dtVct1ap: number;
      dtVctult: number | null;
      vlTac: number;
      vlSeguro: number;
      vlOutvlr: number;
    };
  };
}

/** Rótulo fixo da referência (RN06) — a UI exibe exatamente este texto. */
export const ROTULO_REFERENCIA_CALCULO = "referência — cálculo oficial na execução";

const centavos = (v: number): number => Math.round(v * 100);

/**
 * Chave de duplicidade de `proposta.criar` (RN04): a MESMA assinatura da
 * guarda do fluxo direto (`propostaIdentica` — produto + parcelas + 1º vcto. +
 * financiado + parcela, em centavos), prefixada pelo CPF. Legível de propósito
 * (o drawer e a auditoria a mostram). Payload fora do formato → null (sem guarda).
 */
export function chaveDuplicidadeProposta(payload: Record<string, unknown>): string | null {
  const proposta = payload.proposta as PropostaSodPayload["proposta"] | undefined;
  const referencia = payload.referencia as PropostaSodPayload["referencia"] | undefined;
  const resumo = referencia?.resumo;
  const cpf = typeof proposta?.cpf === "string" ? normalizarDocumento(proposta.cpf) : "";
  const cdProd = proposta?.params?.cdProd;
  if (
    !cpf ||
    typeof cdProd !== "number" ||
    typeof resumo?.qtPrest !== "number" ||
    typeof resumo?.dtVct1ap !== "number" ||
    typeof resumo?.vlFinanciado !== "number" ||
    typeof resumo?.vlPresta !== "number"
  ) {
    return null;
  }
  return [
    cpf,
    `prod${cdProd}`,
    `${resumo.qtPrest}x`,
    `vcto${resumo.dtVct1ap}`,
    `fin${centavos(resumo.vlFinanciado)}`,
    `parc${centavos(resumo.vlPresta)}`,
  ].join(":");
}

/**
 * Chave de bloqueio de `proposta.movimentar` (US-08, RN03): o número da
 * proposta em dígitos — uma requisição de movimentação ATIVA por proposta,
 * independentemente do destino. Payload fora do formato → null (sem guarda).
 */
export function chaveBloqueioMovimentacao(payload: Record<string, unknown>): string | null {
  const movimentacao = payload.movimentacao as
    | MovimentacaoSodPayload["movimentacao"]
    | undefined;
  const nrProsp = movimentacao?.nrProsp;
  if (typeof nrProsp !== "number" || !Number.isInteger(nrProsp) || nrProsp <= 0) return null;
  return String(nrProsp);
}

/**
 * Extrai a CHAVE DE DUPLICIDADE do payload de uma requisição, por tipo — o
 * valor vai para a coluna `documento`, coberta pelo índice único parcial de
 * pendentes (uma pendente por (ambiente, tipo, chave)).
 *
 * - `tomador.cadastrar` (US-02): o documento (CPF/CNPJ) de
 *   `{ campos: { nrCpfCnpj } }` — uma pendente por documento.
 * - `proposta.criar` (US-04): a assinatura da proposta (mesma chave da guarda
 *   do fluxo direto) — pendentes de propostas DIFERENTES do mesmo CPF são
 *   permitidas, como na Sinqia (decisão "Opção A" do PM no checkpoint da US-04).
 * - `proposta.movimentar` (US-08): o nº da proposta — a guarda aqui é de
 *   BLOQUEIO (uma movimentação ativa por proposta, `falha` inclusive), não só
 *   de pendente; ver ESTADOS_BLOQUEIO_MOVIMENTACAO.
 *
 * Demais tipos (e payloads em formato inesperado) devolvem null — sem chave
 * não há guarda.
 */
export function extrairDocumentoSod(
  tipo: TipoAcaoSod,
  payload: Record<string, unknown>,
): string | null {
  if (tipo === "proposta.criar") return chaveDuplicidadeProposta(payload);
  if (tipo === "proposta.movimentar") return chaveBloqueioMovimentacao(payload);
  if (tipo !== "tomador.cadastrar") return null;
  const campos = payload.campos;
  if (!campos || typeof campos !== "object" || Array.isArray(campos)) return null;
  const bruto = (campos as Record<string, unknown>).nrCpfCnpj;
  if (typeof bruto !== "string") return null;
  const doc = normalizarDocumento(bruto);
  return doc.length > 0 ? doc : null;
}

/* ------------------------------------------------------------------ */
/* Identidade (RN05)                                                   */
/* ------------------------------------------------------------------ */

/**
 * Login Sinqia normalizado: trim + case-insensitive. TODA comparação de
 * identidade da esteira (maker-checker, cancelamento) usa esta forma — e é
 * ela que vai para a base, nunca o login como digitado.
 */
export function normalizarLogin(login: string): string {
  return login.trim().toLowerCase();
}

/**
 * RN04 (US-11): Lógica de decidibilidade extraída e compartilhada.
 * Uma requisição é decidível/tratável pelo operador logado se estiver aguardando ação
 * (pendente ou falha) e ele NÃO for o criador (maker-checker).
 */
export function requisicaoDecidivelPor(
  estado: EstadoRequisicao,
  requisitante: string,
  ator: string,
): boolean {
  if (estado !== "pendente" && estado !== "falha") return false;
  return normalizarLogin(requisitante) !== normalizarLogin(ator);
}

/* ------------------------------------------------------------------ */
/* Contratos dos endpoints do BFF                                      */
/* ------------------------------------------------------------------ */

/** Corpo de criação de requisição. `payload` é o JSON integral da ação (RN08). */
export const criarRequisicaoSodSchema = z.object({
  tipo: tipoAcaoSodSchema,
  payload: z.record(z.unknown()),
});

export type CriarRequisicaoSod = z.infer<typeof criarRequisicaoSodSchema>;

/**
 * Decisões aplicáveis via endpoint nesta fase. Retry e descarte (estados de
 * `falha`) só ganham rota na Onda 2 — o domínio já os suporta para testes.
 * `motivo` é obrigatório em `reprovar` (RN07) — o domínio valida.
 */
export const decisaoSodSchema = z.object({
  decisao: z.enum(["aprovar", "reprovar", "cancelar"]),
  motivo: z.string().optional(),
});

export type DecisaoSod = z.infer<typeof decisaoSodSchema>;

/**
 * Exceção por item na decisão BIDIRECIONAL de um lote (US-06, RN02/RN03):
 * o item marcado recebe a direção CONTRÁRIA à do lote, sempre com motivo —
 * a justificativa do desvio é parte do controle, não cortesia de UI.
 */
export const excecaoLoteSchema = z.object({
  itemId: z.string().uuid(),
  motivo: z
    .string({ required_error: "Motivo da exceção é obrigatório." })
    .trim()
    .min(1, "Motivo da exceção é obrigatório."),
});

export type ExcecaoLote = z.infer<typeof excecaoLoteSchema>;

/**
 * Corpo da decisão aceitando exceções de lote. Requisições INDIVIDUAIS não
 * aceitam `excecoes` (a rota rejeita); US-09/US-12 herdam este contrato.
 */
export const decisaoComExcecoesSchema = decisaoSodSchema.extend({
  excecoes: z.array(excecaoLoteSchema).optional(),
});

export type DecisaoComExcecoes = z.infer<typeof decisaoComExcecoesSchema>;

/**
 * Payload canônico da REQUISIÇÃO-LOTE de tomadores (US-06): os controles do
 * lote + a identificação do arquivo. Os dados de cada tomador vivem nos ITENS
 * (`ItemLoteSodPayload`), nunca aqui — o lote é o envelope, não o conteúdo.
 */
export interface LoteSodPayload {
  control: Record<string, unknown>;
  arquivo: {
    nome: string;
    totalItens: number;
  };
}

/**
 * Payload canônico de um ITEM de lote de tomadores: o request Sinqia montado
 * na criação (a execução o reenvia intacto — RN05/RN08) + resumo de exibição.
 */
export interface ItemLoteSodPayload {
  ordem: number;
  resumo: {
    nome: string;
    documento: string;
    tipo: "PF" | "PJ" | "?";
  };
  control: Record<string, unknown>;
  request: Record<string, unknown>;
}

/**
 * Payload canônico da REQUISIÇÃO-LOTE de propostas (US-07), possivelmente
 * COMPOSTA: `arquivo` é a planilha de propostas (Emissões, xlsx/csv);
 * `arquivoTomadores` só existe no lote composto (tomadores a cadastrar antes
 * das propostas vinculadas). `arquivo.totalItens` conta TODOS os itens
 * (tomadores + propostas) — é a contagem que as listagens exibem.
 */
export interface PropostaLoteSodPayload {
  arquivo: {
    nome: string;
    totalItens: number;
  };
  /** Presente apenas no lote COMPOSTO. */
  arquivoTomadores?: {
    nome: string;
    totalItens: number;
  };
  /** Parâmetros de criação do lote (taxa, produto, convênio, loja, contrato). */
  params: Record<string, unknown>;
  /** Controles do cadastro dos tomadores (lote composto). */
  control?: Record<string, unknown>;
  composto: boolean;
  /** Quantidade de propostas VINCULADAS a tomadores deste lote (RN03). */
  vinculos: number;
}

/** Rótulo fixo da conferência automática da execução (US-07, RN02). */
export const ROTULO_CONFERENCIA_PLANILHA =
  "conferência automática na execução — valores da planilha Emissões";

/**
 * Baseline de CONFERÊNCIA de um item de proposta em lote (US-07, RN02): os
 * valores da PLANILHA, rotulados. Na execução, o cálculo oficial é conferido
 * contra estes valores (tolerância de 1 centavo, a mesma da fase de cálculo);
 * divergência → item em `falha` com o comparativo esperado × calculado.
 * Campos null = a planilha não tinha o valor (sem baseline, sem conferência).
 */
export interface ConferenciaPlanilha {
  rotulo: string;
  /** Linha da planilha de onde os valores vieram. */
  linha: number;
  vlParcelaInicial: number | null;
  vlLiquido: number | null;
  vlFinanciado: number | null;
}

/**
 * Payload canônico de um ITEM DE PROPOSTA em lote (US-07): o formato da
 * proposta individual (US-04 — o executor e a chave de duplicidade são os
 * MESMOS) + a posição na planilha, o resumo de exibição e a conferência
 * automática. `dependeDeItemId` NÃO vive aqui — o vínculo tomador→proposta é
 * coluna própria de `sod_lote_itens`, consultável (insumo do retry da US-10).
 */
export interface PropostaLoteItemSodPayload extends PropostaSodPayload {
  ordem: number;
  resumo: {
    nome: string;
    documento: string;
    /** Linha da planilha de propostas (1 = primeira linha de dados). */
    linha: number;
  };
  conferencia: ConferenciaPlanilha;
}

/**
 * Duplicidade TRIDIMENSIONAL do lote (US-06, RN06), apontada ANTES da criação:
 * (1) dentro do próprio arquivo; (2) contra requisições individuais pendentes;
 * (3) contra itens pendentes de OUTROS lotes. Chave = documento normalizado.
 */
export interface DuplicidadesLote {
  /** Documentos repetidos no arquivo, com as linhas (ordens) em conflito. */
  intraArquivo: Array<{ documento: string; ordens: number[] }>;
  /** Linhas cujo documento já tem requisição INDIVIDUAL pendente. */
  pendentesIndividuais: Array<{ documento: string; ordem: number; requisicaoId: string }>;
  /** Linhas cujo documento já está em item pendente de OUTRO lote. */
  pendentesLote: Array<{ documento: string; ordem: number; requisicaoId: string }>;
}

export function temDuplicidades(d: DuplicidadesLote): boolean {
  return (
    d.intraArquivo.length > 0 || d.pendentesIndividuais.length > 0 || d.pendentesLote.length > 0
  );
}
