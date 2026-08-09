# CONTEXTO-SOD.md — Esteira de Aprovação (SoD) na Esteira de Originação

> **Instrução ao agente (Claude Code):** leia este arquivo integralmente no início de TODA sessão
> desta entrega, antes do prompt da história. Ele é o contexto mestre — a visão do todo.
> A especificação de cada história está no prompt da sessão; **este arquivo nunca substitui o
> prompt, e o prompt da sessão sempre prevalece em caso de divergência.**
> **Implemente somente a história da sessão atual. Nunca adiante trabalho de histórias futuras.**

---

## 1. O que estamos construindo e por quê

A Opea SCD é regulada pelo Banco Central: todo produto com impacto financeiro exige **segregação
de funções (SoD)** e **log auditável de todas as ações**. Hoje a Esteira de Originação executa
toda ação sensível diretamente na Sinqia (API, ambiente BJ21M05), no ato, pelo usuário logado —
quem cria também executa. Esta entrega transforma toda ação sensível em uma **requisição
persistida** que exige **aprovação de um segundo operador** antes de executar na Sinqia.

**Modelo central (decisão "B2'"):** a execução acontece **na sessão Sinqia do aprovador, no ato
da aprovação**. Consequências: a Sinqia registra o aprovador como executor; a rastreabilidade de
*quem pediu* existe somente na nossa trilha de auditoria — que por isso é **parte obrigatória do
controle**, não acessório. Nenhum token/credencial é jamais persistido.

## 2. Decisões de produto já tomadas (não rediscutir na implementação)

1. **Maker-checker por requisição:** o aprovador de uma requisição não pode ser o seu criador.
   Bloqueio na camada de domínio, não convenção de UI.
2. **Perfil único implícito:** todo usuário com login SCD na Sinqia pode requisitar e aprovar.
   **Não existe** tabela de usuários, perfis, papéis ou tela de admin nesta fase — a governança
   de perfis chega com a integração AD (iniciativa irmã) e ficará com Segurança.
3. **Identidade = login Sinqia normalizado** (trim + case-insensitive) da sessão autenticada.
4. **Corte total:** com a feature flag de um tipo ativa, NENHUMA rota (UI ou BFF) executa aquela
   ação diretamente — para nenhum usuário. Flags por tipo de ação, independentes, inativas por
   padrão; rollout gradual.
5. **Motivo obrigatório** em reprovação e descarte. **Trilha de auditoria append-only** (sem
   update/delete), registrando ator, ação, requisição, timestamp, payload/detalhe e resultado —
   incluindo tentativas rejeitadas (violação de SoD, transição inválida).
6. **Sem retry automático** na Onda 1: `falha` é estado de repouso; retry manual (por aprovador)
   e descarte chegam na Onda 2.
7. **Validação antes da requisição:** payload passa pelas validações existentes do fluxo direto
   antes de virar requisição — o aprovador confere mérito, não formato.

## 3. Máquina de estados da requisição

Estados: `pendente`, `aprovada/executando`, `executada`, `falha`, `reprovada`, `cancelada`,
`descartada`.

Transições permitidas (todas as demais são inválidas e auditadas):
- `pendente → aprovada/executando` (decisão de aprovação; dispara execução na sessão do aprovador)
- `pendente → reprovada` (motivo obrigatório; nunca chama a Sinqia)
- `pendente → cancelada` (somente o criador; somente em pendente)
- `aprovada/executando → executada` (sucesso Sinqia; resposta integral anexada)
- `aprovada/executando → falha` (erro/timeout/conferência reprovada; erro integral anexado)
- `falha → aprovada/executando` (retry — Onda 2; nunca pelo requisitante)
- `falha → descartada` (motivo obrigatório; divergência causada fora da plataforma — Onda 2)

Terminais: `executada`, `reprovada`, `cancelada`, `descartada`.
Decisão é **atômica** na persistência (primeira vence; jamais segunda execução na Sinqia).

## 4. Mapa da entrega

### Onda 1 (uma sessão por história, nesta ordem)
| ID | História | Resumo |
|----|----------|--------|
| US-01 | Fundação | Camada persistente de requisições + máquina de estados + maker-checker + auditoria + endpoints internos do BFF. Sem UI. Sem Sinqia. Checkpoint: propor 2–3 modelagens e parar. |
| US-02 | Requisição de tomador | Cadastro individual de tomador vira requisição (atrás de toggle); área "Minhas requisições" (listar/detalhar/cancelar); guarda de duplicidade pendente por documento. |
| US-03 | Aprovação + execução B2' | Painel de pendências; aprovar/reprovar individual; execução na sessão do aprovador com pré-verificação de sessão; falha registrada. Checkpoint condicional sobre a premissa B2'. |
| US-04 | Proposta individual | Segundo tipo de ação por reuso (registro + adaptador). Cálculo oficial (parcelas/CET/IOF) é da execução; valores prévios são "referência". Teste de extensibilidade da fundação. |
| US-05 | Flag + corte | Toggle vira feature flag definitiva por tipo; corte total no BFF (guard centralizado); auditoria de mudança de flag; go-live com flags inativas. |

### Onda 2 (uma sessão por história, nesta ordem — NÃO implementar antes da história correspondente)
| ID | História | Resumo |
|----|----------|--------|
| US-06 | Lote de tomadores | Modelo de requisição-lote (itens com estado próprio, decisão bidirecional, execução sequencial com falha parcial, idempotência por item) aplicado ao cadastro de tomadores em lote. Fundação reusada por US-07/09/12. Checkpoint: modelagem do lote. |
| US-07 | Lote de propostas (Emissoes.xlsx) | Propostas em lote com cálculo/conferência na execução e ENCADEAMENTO tomador→proposta (lote composto 70+70; propostas executam após sucesso dos tomadores; exceção propaga com aviso de impacto). Checkpoint: desenho do lote composto. |
| US-08 | Movimentação individual | Mover proposta de etapa vira requisição; UMA requisição de movimentação ativa por proposta (bloqueio no BFF, `falha` mantém); indicador no Painel de Propostas; divergência externa → `falha`. |
| US-09 | Movimentação em massa | Composição US-06 × US-08: seleção múltipla (mesma etapa + mesma carteira), decisão bidirecional, bloqueio por proposta unificado (individual↔lote). |
| US-10 | Retry e descarte | `falha → aprovada/executando` (retry manual, nunca pelo requisitante, payload original imutável, elegibilidade por vínculo) e `falha → descartada` (motivo obrigatório; libera bloqueio de movimentação). Histórico de tentativas imutável. Fecha o ciclo de vida. |
| US-11 | Badge de pendências | Contador na navegação do que o usuário PODE decidir (pendentes de terceiros, lote = 1, + falhas tratáveis); endpoint agregado; fonte única com o painel. |
| US-12 | Situação de tomador `[a validar com Head SCD]` | Ativar/inativar, individual (máquina Onda 1) e massa (modelo US-06); aviso de impacto na inativação com propostas em andamento. Depende de aceite do negócio. |

## 4.1 Status das entregas (ATUALIZAR a cada checkpoint final aprovado)

> O agente deve atualizar esta seção como último passo de cada checkpoint final aprovado pelo PM,
> registrando: data, decisões de checkpoint (ex.: modelagem escolhida) e observações relevantes
> para as histórias seguintes.

- US-01: `entregue` — 2026-08-09, checkpoint final aprovado pelo PM (SCD-251).
  Decisões: modelagem "Opção A" (híbrida — colunas tipadas para o ciclo de vida + payload
  integral em JSON/TEXT; máquina de estados no domínio com UPDATE atômico "primeira decisão
  vence"; auditoria em tabela dedicada `sod_auditoria`, append-only com triggers); maker-checker
  aplicado também a reprovação e retry (saída do criador = cancelamento); testes com `node:test`
  (zero dependência nova); repositório com fábrica (banco/ambiente por parâmetro).
  Para as próximas US: módulo em `apps/api/src/sod/` (repositorio/dominio/rotas), contratos em
  `packages/shared/src/sod.schema.ts` (tipos de ação = enum extensível — cada US acrescenta a
  sua entrada), endpoints `/api/sod/*`, serviço injetável em `registerSodRoutes(app, servico)`;
  execução na Sinqia pendente no stub `concluirExecucaoStub` (`TODO US-03`); retry/descarte já
  suportados no domínio, sem rota (US-10). MIGRATION-NOTEs concentrados em `sod/repositorio.ts`.
- US-02: `entregue` — 2026-08-09, checkpoint final aprovado pelo PM (SCD-252).
  Decisões: duplicidade RN02 pela "Opção A" (coluna `documento` extraída no INSERT +
  índice único parcial `(ambiente, tipo, documento) WHERE estado='pendente'` — guarda
  no próprio banco, corrida do INSERT coberta); toggle via env
  `APROVACAO_CADASTRO_TOMADOR_INDIVIDUAL` (chave `aprovacao.cadastro_tomador_individual`)
  atrás de `aprovacaoAtiva(tipo)` em `apps/api/src/sod/flags.ts` — a US-05 troca a FONTE
  (flag persistida + auditoria) sem tocar os chamadores; a edição (idAcao=AL) do cadastro
  individual também passa pelo toggle (mesma rota/ação sensível).
  Para as próximas US: payload canônico de `tomador.cadastrar` =
  `{ campos, control, request }` — a US-03 executa `payload.request` na sessão do
  aprovador; extrator de documento por tipo em `extrairDocumentoSod` (shared);
  `GET /api/sod/requisicoes?minhas=1` filtra pela identidade da SESSÃO;
  `DUPLICIDADE_PENDENTE` → 409 com `requisicaoExistente` estruturada; `/api/cadastrar`
  tem deps injetáveis p/ teste (`RegisterRoutesDeps`: spy Sinqia, serviço SoD, toggle);
  `/api/env` expõe os toggles para a UI. Frontend: módulo "Requisições" na topbar
  (`MinhasRequisicoes.tsx` — a US-03 acrescenta o painel de pendências), drawer lateral
  em `components/ui/drawer.tsx`, rótulos de tipo em `ROTULO_TIPO_ACAO`, badge de estado
  em `BadgeEstado`. Testes de frontend não existem no repo — cenários cobertos no BFF
  (`us02-cadastro.test.ts`).
- US-03: `entregue` — 2026-08-09, checkpoint final aprovado pelo PM (SCD-253).
  Decisões: premissa B2' confirmada DIRETA (checkpoint condicional não acionado) — as
  sessões do BFF vivem em memória com o token Sinqia do operador, e a decisão de
  aprovação roda no ciclo HTTP do próprio aprovador; pré-verificação RN03 por sonda
  REAL na Sinqia (`verificarSessaoSinqia` em sinqia-client.ts, reutilizando
  consultarCamposObrigatorios; distingue valida/invalida/indisponivel — indisponível
  → 502 sem transição, pendente intacta); fluxo de aprovação em três tempos na rota
  de decisão (sonda → transição atômica → execução → conclusão com resultado
  integral); sem novos MIGRATION-NOTEs.
  Para as próximas US: executores por tipo no registro `EXECUTORES`
  (apps/api/src/sod/rotas.ts) — a US-04 acrescenta o de proposta; deps injetáveis de
  execução em `registerSodRoutes(app, servico, { cadastrarClienteFn,
  verificarSessaoSinqiaFn })`; `concluirExecucao` substituiu o stub e há evento
  `execucao_iniciada` na auditoria; decisão concorrente perdedora recebe 409 com
  `estadoAtual` + `decididoPor` estruturados; listagem aceita `ordem=asc` (RN01) e
  `GET /api/sod/requisitantes` alimenta o filtro de criador. Frontend: módulo
  Requisições com abas em `Requisicoes.tsx` (pendências | minhas), painel em
  `PainelPendencias.tsx`, detalhe compartilhado em
  `components/RequisicaoDetalhe.tsx` (com seção "Resultado da execução").
  Observação: validação de integração real em HML PENDENTE — entregue no sábado,
  fora da janela Sinqia; PM valida no próximo dia útil.
- US-04: `entregue` — 2026-08-09, checkpoint final aprovado pelo PM (SCD-248).
  Decisões (checkpoint A): o cálculo do requisitante é PRÉ-REQUISITO da requisição
  (sem cálculo OK não há requisição) e o CÁLCULO OFICIAL da execução, na sessão do
  aprovador, é o que vale — divergência com a referência NÃO bloqueia (fica
  registrada em `resultado.divergenciasReferencia`); guarda RN04 pela "Opção A":
  chave de duplicidade de proposta = assinatura da guarda do fluxo direto
  (cpf:prod:parcelas:1º vcto:financiado:parcela em centavos) na MESMA coluna
  `documento` — índice único parcial reusado, zero mudança de schema; refactor
  mínimo aprovado (executores extraídos para `sod/execucao.ts` com deps genéricas,
  `extrairDocumentoSod` por tipo, drawer parametrizado por tipo).
  Para as próximas US: novo tipo custa 1 entrada em flags.ts + 1 executor em
  `sod/execucao.ts` (registro `EXECUTORES`, assinatura `(requisicao, {token, ator},
  deps)`) + 1 branch de toggle na rota da ação + 1 renderer em
  `RequisicaoDetalhe.tsx` + testes (~570 linhas de custo marginal na US-04).
  Payload canônico de `proposta.criar` = `PropostaSodPayload` (shared): `proposta`
  (insumos) + `calcRequest` (a execução recalcula com ele) + `referencia` rotulada
  (`ROTULO_REFERENCIA_CALCULO`, RN06). Falhas de execução distinguíveis por
  `resultado.causa` (calculo_reprovado | erro_negocio | duplicidade_sinqia |
  indisponibilidade_ou_timeout | sessao_expirada_durante_execucao) + `etapa`.
  RN05: `pendentePorDocumento("tomador.cadastrar", cpf)` exposto no serviço —
  proposta para tomador pendente → 409 TOMADOR_PENDENTE. Toggle
  `APROVACAO_CRIACAO_PROPOSTA_INDIVIDUAL` (chave
  `aprovacao.criacao_proposta_individual`), OFF por padrão. Sem novos
  MIGRATION-NOTEs. Observação: validação de integração real em HML PENDENTE —
  entregue fora da janela Sinqia; PM valida no próximo dia útil (mesmo caso da
  US-03).
- US-05: `entregue` — 2026-08-09, checkpoint final aprovado pelo PM (SCD-249).
  Decisões (checkpoint A): flag definitiva pela "Opção 2" — persistida na tabela
  `sod_flags` (por ambiente + tipo; ausência de linha = INATIVA, RN07), lida em
  RUNTIME (mudança vale na requisição seguinte, sem restart) e mudada SOMENTE pelo
  CLI auditado `npm run sod:flag -- <tipo|chave> <on|off> --por <login>` (RN03: sem
  tela); auditoria RN05 na mesma transação da mudança (evento `flag_alterada` só em
  mudança EFETIVA); corte pela leitura "desvio automático + guard": as rotas cobertas
  mantêm o desvio flag ativa → cria requisição (UX das US-02/04) e o guard
  centralizado `guardarExecucaoDireta(tipo, reply)` (sod/corte.ts) barra QUALQUER
  execução direta de tipo coberto com 409 `ACAO_SOB_APROVACAO`, zero Sinqia.
  Toggle provisório REMOVIDO (envs `APROVACAO_*` fora de env.ts/.env.example) —
  mecanismo único. Mapa do corte: POST /api/cadastrar (tomador.cadastrar, inclui
  edição) e POST /api/propostas/criar-uma (proposta.criar).
  Para a Onda 2: novo tipo sob corte = 1 entrada em `TIPOS_COM_FLAG` +
  `CHAVE_APROVACAO` (sod/flags.ts) + chamada ao guard imediatamente antes da
  execução direta na rota; o CLI e a auditoria valem automaticamente. Flags são por
  AMBIENTE (HML ≠ prod). MIGRATION-NOTEs novos: `sod_flags` (INTEGER→BOOLEAN) em
  repositorio.ts e conexão do CLI em flag-cli.ts. Go-live com as duas flags
  inativas (estado padrão — sem seed). Observação: validação de integração real em
  HML PENDENTE — entregue no sábado, fora da janela Sinqia (mesmo caso das US-03/04).
- US-06: `entregue` — 2026-08-09, checkpoint final aprovado pelo PM (SCD-256).
  Decisões (checkpoint A): modelagem do lote pela "Opção A" — tabela filha
  `sod_lote_itens` (payload integral POR item, estado próprio espelhando a máquina
  individual + transição extra `pendente → falha` para interrupção); estado do lote
  DERIVADO do placar dos itens (RN01: ≥1 falha → lote `falha`; exceções reprovadas
  não tornam o lote falho); idempotência RN05 por reivindicação atômica
  `pendente → aprovada/executando` por item (UPDATE condicional, "primeira vence");
  duplicidade RN06 TRIDIMENSIONAL (intra-arquivo + individuais pendentes + itens de
  outros lotes) com guarda no banco (índice único parcial em `sod_lote_itens`) e
  RECÍPROCA na individual; progresso por POLLING do detalhe (estados persistidos =
  fonte única; SSE descartado); upload mantido CSV/JSON (XLSX segue só em propostas).
  Decisões de implementação ratificadas: sob aprovação NÃO há "pular inválidas"
  (arquivo com erro volta inteiro — decisão 7); "aprovar com todas as linhas em
  exceção" é rejeitado (caminho correto: reprovar); motivo de exceção obrigatório
  nas DUAS direções (o de exceção aprovada vive na trilha de auditoria).
  Para as próximas US (fundação reusada por US-07/09/12): decisão bidirecional em
  `decisaoComExcecoesSchema` (shared) na MESMA rota de decisão; novo tipo de lote =
  entrada em `TIPO_ITEM_DO_LOTE` (shared, lote → tipo individual executável) +
  flags.ts + desvio/guard na rota da ação — os executores individuais são reusados
  item a item por `iniciarExecucaoLote` (sod/execucao-lote.ts, job em processo com
  o token do aprovador, mesmo padrão do batch.ts); `criarRequisicaoLote`/
  `decidirLote`/`concluirLote` no domínio; detalhe devolve `itens` (visão enxuta) +
  `placar`, item integral em `GET /api/sod/requisicoes/:id/itens/:itemId`; UI:
  renderer de lote + marcação de exceções em `RequisicaoDetalhe.tsx` (`LoteItens`),
  polling de 1,5s nas duas telas. Flag `aprovacao.cadastro_tomador_lote`.
  MIGRATION-NOTE novo: detecção de violação do índice de itens pela mensagem do
  SQLite → 23505 no PostgreSQL (repositorio.ts). Overhead da esteira medido nos
  testes: ~0–3 ms/item (70 itens ≈ 200 ms ponta a ponta com Sinqia mockada);
  `resultado.duracaoMediaItemMs` grava o tempo real de cada execução (insumo de UX
  para lotes grandes). Teste de escopo da US-05 atualizado: exemplo de tipo fora do
  corte passou a ser `proposta.criar_lote`.
- US-07: `entregue` — 2026-08-09, checkpoint final aprovado pelo PM (SCD-262).
  Decisões (checkpoint A): lote composto pela "Opção (i)" — UMA requisição-lote
  (`proposta.criar_lote`) com itens de DOIS tipos (`tomador.cadastrar` +
  `proposta.criar`) e vínculo tomador→proposta em coluna própria
  `sod_lote_itens.depende_de_item_id` (FK autorreferente, profundidade fixa 1 —
  sem recursão/CTE aqui nem no PostgreSQL). Decisões de produto do PM: o
  Emissões passa a ser aceito TAMBÉM em CSV (mesmas colunas, parser único —
  texto plano lido com raw + decodificação própria: datas dd/mm/aaaa e
  decimais determinísticos, `toMoney` aceita ponto decimal); lote composto =
  segundo arquivo OPCIONAL de tomadores (CSV/JSON do módulo Tomadores,
  parser/validações reusados, retido no servidor por sessão, vínculo
  automático por CPF); templates para download (`GET
  /api/propostas/template.csv` + o de tomadores já existente).
  Desenho do ENCADEAMENTO (insumo da US-10): itens persistidos com tomadores
  primeiro (ordem 1..T); na execução, proposta com `dependeDeItemId` só é
  reivindicada se o tomador estiver `executada` — senão cai `pendente → falha`
  com causa `tomador_nao_criado` ("Tomador não criado — item X"), zero Sinqia
  (Cenário 3). Decisão bidirecional PROPAGA (Cenário 4): exceção que reprova
  tomador reprova as propostas vinculadas na MESMA transação (origem
  `propagacao`, motivo do tomador propagado; aviso de impacto na UI ANTES da
  confirmação — drawer e diálogo); exceção que aprovaria proposta de tomador
  reprovado → decisão inteira rejeitada (LOTE_INVALIDO). RN05 (retry por
  vínculo, US-10) registrada em comentário no repositório/execução: retry de
  proposta exige tomador `executada`; retry de tomador reabilita as propostas
  em `falha` vinculadas — consulta pronta em `itensDependentes(itemId)`.
  Execução do item de proposta: cálculo OFICIAL (`calcRequest` persistido) +
  CONFERÊNCIA AUTOMÁTICA contra a planilha (RN02 — `payload.conferencia`
  rotulada `ROTULO_CONFERENCIA_PLANILHA`; `conferirCalculo` reusado, 1 centavo)
  → divergência = `falha` causa `conferencia_reprovada` com comparativo
  esperado × calculado; depois `criarUma` (mesmo caminho do fluxo direto —
  painel e base local iguais). Duplicidade RN06 conferida POR TIPO no lote
  misto (tomador = documento; proposta = assinatura da US-04); RN05 da US-04
  herdada na criação (tomador pendente em OUTRA requisição → 409
  TOMADOR_PENDENTE, salvo se ele vier no arquivo deste lote); tomador no
  arquivo sem proposta correspondente → 422 (arquivo volta inteiro).
  Para as próximas US: detalhe devolve `placarPorTipo` (dois níveis; a UI
  distingue falha de conferência × tomador não criado × Sinqia);
  `itemParaLista` expõe `dependeDeItemId` (agrupamento na UI);
  `falharItemPendente` no domínio (transição `pendente → falha` de UM item,
  atômica); `calcProspFn` injetável no calculo-job (testabilidade da fase 2).
  Flag `aprovacao.criacao_proposta_lote` + corte na rota direta
  (POST /api/propostas/criar). MIGRATION-NOTE novo: coluna
  `depende_de_item_id` via PRAGMA table_info/ADD COLUMN (repositorio.ts).
  Testes: us07-proposta-lote.test.ts (13 testes; composto 70+70 ≈ 0,8 s com
  Sinqia mockada); teste de escopo da US-05 atualizado (exemplo de tipo fora
  do corte → `proposta.movimentar`). Observação: validação de integração real
  em HML PENDENTE — entregue fora da janela Sinqia (mesmo caso das US-03..06).
- US-08: `entregue` — 2026-08-09, checkpoint final aprovado pelo PM (SCD-257).
  Decisões: tipo = `proposta.movimentar` (entrada do enum reservada desde a US-01; o nome
  de negócio "movimentação individual de proposta" segue o padrão das US-02/04: tipo
  `entidade.acao` + chave `aprovacao.movimentacao_proposta`); bloqueio RN03 por proposta
  com definição ÚNICA em `ESTADOS_BLOQUEIO_MOVIMENTACAO` (shared: pendente |
  aprovada/executando | falha — `falha` MANTÉM) e guarda ATÔMICA no banco: índice único
  parcial `idx_sod_req_mov_ativa` sobre (ambiente, documento) restrito ao tipo/estados —
  a corrida de criação simultânea (Cenário 3) é decidida pelo próprio banco; erro
  `MOVIMENTACAO_BLOQUEADA` (409, `requisicaoExistente` estruturada); chave na coluna
  `documento` = nº da proposta. Payload RN02 = `MovimentacaoSodPayload` (shared):
  `movimentacao` (proposta, origem, destino, observação) + `request` EXATO do
  transfStatus; a criação revalida o destino no consultarStatusTransf (a MESMA validação
  do fluxo direto), zero transfStatus. Execução (executor em sod/execucao.ts): confere o
  status ATUAL da proposta via consultarHistoricoProposta ANTES de mover — divergência
  externa → `falha` causa `divergencia_externa` com esperado × atual + `etapasValidas`
  capturadas do status atual; rejeição da Sinqia no transfStatus → `falha` causa
  `movimentacao_rejeitada` com a resposta integral. Indicador RN05 por endpoint AGREGADO
  `GET /api/sod/movimentacoes-ativas` (UMA chamada por carga de fila, nunca por proposta;
  2,2 ms com 155 ativas nos testes) — chip clicável no painel ("pendente (→ destino)" /
  "executando" / "falhou") abre o detalhe em drawer com cancelamento RN06 (criador,
  pendente). Gesto individual de mover na UI só existe com a flag ativa; flag OFF =
  painel intacto (mover direto segue morando no lote).
  Para as próximas US: bloqueio CONSULTÁVEL para a US-09 em
  `movimentacaoAtivaPorProposta(nrProsp)` e `listarMovimentacoesAtivas()` (serviço) —
  mesma definição do índice; a rota de transferência em LOTE segue SEM corte até a US-09
  (tipo `proposta.movimentar_massa`) — mover 1 proposta pelo caminho do lote ainda é
  direto (gap conhecido, fecha na US-09); para a US-10, retry reexecuta o MESMO payload
  persistido e `falha → descartada` libera o bloqueio pela própria máquina de estados.
  MIGRATION-NOTE novo: `ehViolacaoBloqueioMovimentacao` → 23505 no PostgreSQL
  (repositorio.ts). Teste de escopo da US-05 atualizado (exemplo fora do corte →
  `proposta.movimentar_massa`). Observação: validação de integração real em HML PENDENTE
  — entregue no sábado, fora da janela Sinqia (mesmo caso das US-03..07); sem infra de
  teste de frontend no repo (registrado desde a US-02), a medição do painel é a do BFF +
  análise de render (indicador = 1 Map.get por linha, zero fetch por proposta).
- US-09: `pendente`
- US-10: `pendente`
- US-11: `pendente`
- US-12: `pendente — aguarda aceite do negócio (ação 4)`

## 5. Regras técnicas transversais

- **Stack:** frontend React/Vite; backend BFF sobre a API Sinqia; persistência **SQLite já
  implementada no repo** — siga a estrutura, biblioteca e padrões existentes. Não introduza
  ORM/bibliotecas novas sem propor no checkpoint.
- **Portabilidade:** migração futura planejada para **PostgreSQL + Docker**. Isole acesso a
  dados em módulo único (repositório/serviço); prefira SQL portável; marque exceções com
  `// MIGRATION-NOTE:` descrevendo o ajuste necessário.
- **Segurança:** nunca persistir token, senha ou credencial Sinqia — em tabela, log ou
  auditoria. Variáveis de ambiente e fixtures em testes; nada de credencial real no código.
- **Não regressão:** fluxos diretos existentes permanecem intactos enquanto a flag do tipo
  estiver inativa; ações fora do escopo da história da sessão não são tocadas.
- **Toda mutação de requisição** passa pela camada de domínio da US-01 — jamais contornar a
  máquina de estados ou o maker-checker "por ser backend".

## 6. Regras de trabalho do agente (valem em toda sessão)

1. **Uma história por sessão.** O prompt da sessão define o escopo; nada além dele.
2. **Uma branch por ONDA, um commit por US (fluxo Git):** a branch base do fluxo é
   `development` (integração/homolog); `master` recebe apenas merges de `development` já
   validados em homologação contra a Sinqia (janela: dias úteis, horário comercial). O
   trabalho vive em `feature/sod-onda-1` e `feature/sod-onda-2`. A primeira US de cada onda
   cria a branch da onda a partir de `development` atualizada — e a Onda 2 só nasce após o
   merge da Onda 1 em `development`; as demais US fazem checkout da branch da onda e
   verificam no log os commits das US anteriores. Commit SOMENTE após aprovação do
   checkpoint final, em um único commit por US, com mensagem
   `feat(sod): US-XX [CODIGO-CLICKUP] — <resumo>`. Sem o código ClickUp, pergunte ao PM
   antes de começar. Nunca trabalhe em `development` ou `master` diretamente; merge e push
   somente com instrução explícita do PM.
3. **Explorar antes de escrever:** todo prompt começa com exploração do repo — respeite-a.
4. **Checkpoints são paradas reais:** ao atingir um checkpoint (condicional ou final), PARE e
   aguarde o PM. Não prossiga, não refatore além do escopo, não commite sem instrução explícita.
5. **Decisões em aberto não se decidem sozinhas:** proponha 2–3 opções com trade-offs e pare.
6. **Dependências se verificam, não se criam:** se algo de história anterior não existir ou
   divergir, PARE e reporte. Dependências de US da MESMA onda estão na branch da onda (confira
   os commits `feat(sod): US-XX ...` no log); dependências de onda ANTERIOR estão na branch
   base (a onda anterior foi mergeada antes desta começar). Se faltar, reporte ao PM — o merge
   pode estar pendente — em vez de buscar código em outra branch.
7. Os critérios de done do prompt mapeiam 1:1 os cenários Gherkin da história — a evidência de
   cada um é obrigatória no checkpoint final.

---
*Origem: Discovery "Esteira de Aprovação (SoD)" — Opea SCD/Produtos, PM Cassio (PPM), stakeholder
Rodrigo Shyton de Melo (Head SCD). Processo invertido registrado: implementação de referência
antecede as validações formais (TL/stakeholder), que ocorrem pós-apresentação.*

---
- **Janela de disponibilidade da Sinqia (importante):** as APIs da Sinqia só operam em
  horário comercial (dias úteis). Fora dessa janela — noites, fins de semana, feriados —
  o ambiente de homologação (BJ21M05) não responde, e isso NÃO é bug da nossa
  implementação: nunca interprete timeout/indisponibilidade fora do horário comercial
  como defeito do código, e não gaste ciclos "debugando" a integração nessas condições.
  Regras práticas para o agente:
  (1) testes automatizados usam SEMPRE mock/spy do cliente Sinqia — nunca dependem do
      ambiente real, e por isso rodam a qualquer hora;
  (2) validação de integração real contra a Sinqia (homologação) só em dia útil, em
      horário comercial — se o checkpoint final cair fora da janela, entregue tudo com
      os testes mockados verdes e marque explicitamente no checkpoint:
      "validação de integração real PENDENTE — aguardando janela Sinqia (próximo dia
      útil)"; o PM valida em homologação quando a janela abrir;
  (3) NUNCA use o ambiente de produção como alternativa de teste fora da janela — a
      execução em produção tem efeito financeiro real e está proibida para fins de
      teste, sem exceção.