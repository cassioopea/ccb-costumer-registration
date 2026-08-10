# Relatório de validação de integração em homologação — Esteira de Aprovação (SoD)

**Escopo:** US-01 a US-12, contra a Sinqia **BJ21M05 / homologação**
(`https://<HOST_HML>`).
**Quando:** segunda-feira, 2026-08-10, 09:00–11:00 (janela comercial aberta).
**Branch:** `feature/sod-onda-2`. A validação em si não alterou código; as
correções aprovadas pelo PM ao final do dia estão registradas na §4 com o commit
de cada uma.
**Operadores:** dois logins Sinqia distintos — `<OPERADOR_A>` (requisitante) e
`<OPERADOR_B>` (aprovador). Credenciais lidas de `.env.test` (gitignored) e usadas
somente no `POST /api/login` do BFF local; nenhum valor foi impresso, logado ou
gravado. Toda evidência tem os logins redigidos.

## 1. Veredito

| | |
|---|---|
| **Cenários executados em HML** | **75** (soma das linhas das tabelas da §2) |
| **PASSOU** | **73** |
| **FALHOU** | **2** (US-12, ambos de frontend — **os dois já corrigidos**, ver §4) |
| **BLOQUEADO** | 1 caminho de negócio (US-07 composto com tomador novo — ver §4.3) |
| Bug reportado da US-08 | **NÃO REPRODUZIU** em 6 caminhos distintos — ver §3 |
| Suíte mockada | 152/152 na validação · **157/157** após as correções |
| Defeitos abertos ao fim do dia | 4 de 8 (4.3, 4.4, 4.6, 4.7) |

O motor da esteira — máquina de estados, maker-checker, execução B2' na sessão do
aprovador, auditoria append-only, lotes com decisão bidirecional, bloqueio por
proposta, retry/descarte e badge — **funciona ponta a ponta contra a Sinqia real**.
Os dois cenários que reprovaram estão na camada de apresentação da US-12, e um
deles era grave porque corrompia a informação em que o aprovador baseia a
decisão: a tela mostrava a situação nova invertida. Ambos foram corrigidos,
verificados na UI contra homologação e commitados no mesmo dia.

## 2. Matriz de validação

Legenda: **A** = requisitante, **B** = aprovador.

> **Onde estão as evidências.** Os arquivos `test-artifacts/evidencias/*.json`
> (resposta integral do BFF, estado antes/depois, envelope da Sinqia e trilha de
> auditoria de cada cenário) **não são versionados**: este repositório é público
> e eles contêm host de homologação, nº de cliente/proposta e dados dos tomadores
> de teste. Ficam na máquina de quem executou; o harness os regenera. As
> evidências-chave estão transcritas nas tabelas abaixo, e os identificadores de
> homologação aparecem como placeholders (`<HOST_HML>`, `<CLI_T01>`,
> `<PROP_P01>`…) — o mapa real vive no `test-artifacts/estado.json` local.

### US-01/02/03 — Tomador individual · 8/8 PASSOU
Evidências: `10-us010203-tomador.json`, `11-us02-validacao.json`

| # | Cenário | Resultado | Evidência-chave |
|---|---------|-----------|-----------------|
| 1.1 | A cria requisição (flag ativa) | PASSOU | 201 `aprovacao:true`, `pendente`, zero Sinqia |
| 1.2 | Payload inválido não vira requisição | PASSOU | CPF de 10 dígitos e data inválida → `valido:false`, nenhuma requisição |
| 1.3 | Duplicidade pendente por documento (RN02) | PASSOU | 409 `DUPLICIDADE_PENDENTE` + `requisicaoExistente` |
| 1.4 | **Violação de SoD** (A aprova o que A criou) | PASSOU | 403 `VIOLACAO_SOD`; segue `pendente`; auditado como `tentativa_rejeitada` |
| 1.5 | B aprova → execução real (B2') | PASSOU | `executada` em 5,0 s; envelope Sinqia "Cadastro do cliente salvo/atualizado com sucesso", cliente <CLI_T01> |
| 1.6 | Tomador visível na plataforma | PASSOU | consulta por CPF responde 200; `nrCliente` confirmado na base (<CLI_T01>) |
| 1.7 | Reprovação com motivo + novo ciclo | PASSOU | `reprovada` (motivo na trilha, zero Sinqia) → recriação do mesmo CPF → `executada` |
| 1.8 | Cancelamento é exclusivo do criador | PASSOU | B cancelar → 403 `CANCELAMENTO_NEGADO`; A cancelar → `cancelada` |

Trilha do ciclo 1.1→1.5, na ordem: `requisicao_criada` (A) → `tentativa_rejeitada`
×2 (duplicidade) → `tentativa_rejeitada` (violação de SoD) → `transicao_estado`
pendente→aprovada/executando (B) → `execucao_iniciada` (B) →
`transicao_estado` →`executada`.

**Observação (não é defeito):** `dsNome` vazio passa pela validação local (o
schema compartilhado o tem como opcional) e vira requisição. A esteira reusa,
por decisão de produto, exatamente as validações do fluxo direto — quem recusa é
a Sinqia. Vale saber que o aprovador pode receber uma requisição sem nome.

### US-04 — Proposta individual · 7/7 PASSOU
Evidências: `20-us04-proposta.json`, `21-us04-painel.json`

| # | Cenário | Resultado | Evidência-chave |
|---|---------|-----------|-----------------|
| 4.1 | Cálculo do requisitante (pré-requisito) | PASSOU | parcela R$ 929,90 · CET 1,7033% a.m. · IOF 0 |
| 4.2 | A cria requisição | PASSOU | 201 `pendente`, zero criação na Sinqia |
| 4.2b | Duplicidade pendente de proposta (RN04) | PASSOU | 409 `DUPLICIDADE_PENDENTE` pela assinatura |
| 4.3 | Violação de SoD | PASSOU | 403 `VIOLACAO_SOD` |
| 4.4 | B aprova → **cálculo OFICIAL** na execução | PASSOU | proposta **<PROP_P01>** em 8,3 s; 12 parcelas de R$ 929,90; financiado R$ 10.500 (TAC 500 via `vlConces`); CET 1,7033% a.m.; 12 prestações no resultado integral |
| 4.5 | Proposta no painel | PASSOU | <PROP_P01> em 20050; histórico 20010→20015→20050 |
| 4.6 | **Falha real** na execução | PASSOU | proposta idêntica → `falha` causa `duplicidade_sinqia`, mensagem "Proposta idêntica já existe … nº <PROP_P01>. Nada foi criado" |

### US-05 — Flag e corte · 5/5 PASSOU
Evidência: `30-us05-flags.json`

| # | Cenário | Resultado | Evidência-chave |
|---|---------|-----------|-----------------|
| 5.1 | Flag ATIVA → rota direta não executa | PASSOU | `/api/cadastrar` devolve 201 `aprovacao:true`, sem campos de execução Sinqia |
| 5.1b | Leitura da flag em RUNTIME | PASSOU | `/api/env` refletiu off→on **sem restart** (servidor subiu antes das flags) |
| 5.2 | Corte na UI | PASSOU | tela de cadastro individual: "Sob aprovação (SoD): este cadastro não é enviado direto à Sinqia…" e CTA "Enviar para aprovação" |
| 5.3 | Flag INATIVA → fluxo direto intacto | PASSOU | cadastro DIRETO real de T05 → `status OK`, cliente <CLI_T05>, sem requisição |
| 5.4 | Mudança de flag auditada (RN05) | PASSOU | 24 eventos `flag_alterada` na trilha, com ator e antes/depois |
| 5.5 | CLI recusa tipo fora do corte | PASSOU | "não é um tipo com flag nesta fase"; tabela segue com 8 linhas |

**Nota operacional:** `npm run sod:flag` devolve **exit code 0 mesmo quando o CLI
falha** (o CLI sai 1; o wrapper do npm mascara). Se algum dia a mudança de flag
entrar num pipeline, chame o script direto (`npx tsx src/sod/flag-cli.ts …`) para
que o erro seja detectável.
O guard `ACAO_SOB_APROVACAO` (corrida entre as duas leituras da flag) segue
coberto apenas pela suíte mockada — é inalcançável em operação normal.

### US-06 — Lote de tomadores (3 itens) · 6/6 PASSOU
Evidência: `40-us06-lote-tomadores.json`

| # | Cenário | Resultado | Evidência-chave |
|---|---------|-----------|-----------------|
| 6.1 | Upload válido vira requisição-lote | PASSOU | 201, 3 itens, `pendente`, zero Sinqia |
| 6.2 | Violação de SoD no lote | PASSOU | 403 `VIOLACAO_SOD` |
| 6.2b | Exceção sem motivo é rejeitada | PASSOU | 400 "Motivo da exceção é obrigatório." |
| 6.3 | Decisão bidirecional aprovar-exceto-1 | PASSOU | placar `{total:3, pendentes:2, reprovadas:1}`; 2 aprovados para execução |
| 6.4 | Execução sequencial + placar + motivo | PASSOU | 2 `executada`, 1 `reprovada` com o motivo da exceção registrado |
| 6.5 | Duplicidade tridimensional (RN06) | PASSOU | item de lote **pendente** bloqueia a individual (409); item já **executado** não bloqueia (correto) |

### US-07 — Lote de propostas + composto (3+3) · 10/10 PASSOU (com contorno)
Evidência: `50-us07-lote-composto.json`

| # | Cenário | Resultado | Evidência-chave |
|---|---------|-----------|-----------------|
| 7.1a | Parse do Emissões em CSV | PASSOU | 3 linhas, zero avisos |
| 7.1b | Arquivo de tomadores retido | PASSOU | `uploadId`, 3 tomadores |
| 7.1c | Cálculo em lote (fase 2) | PASSOU | 3 sucessos, zero divergência |
| 7.1d | Lote COMPOSTO criado | PASSOU | 201, 6 itens, `composto:true`, 3 vínculos |
| 7.2 | Encadeamento persistido | PASSOU | tomadores nas ordens 1–3; cada proposta com `dependeDeItemId` |
| 7.3a | Violação de SoD | PASSOU | 403 `VIOLACAO_SOD` |
| 7.3b/c | **Propagação de exceção** | PASSOU | reprovar o tomador C2 reprovou a proposta vinculada na mesma transação: "Reprovada em propagação: o tomador vinculado (item 2) foi reprovado — …" |
| 7.4 | Cálculo oficial + conferência (RN02) | PASSOU | 2 tomadores e 2 propostas `executada` (<PROP_L1> e <PROP_L2>), sem divergência de conferência |
| 7.5 | Placar por tipo | PASSOU | `placarPorTipo` com os dois níveis (tomadores × propostas) |

⚠️ **Contorno necessário — ver defeito #3 em §4:** a planilha de teste foi
preenchida com um `ID_Sinqia` sintético (`999-9`) porque o parser exige a coluna
em toda linha. Com tomador novo (o caso do composto) esse ID não existe, e o
lote composto **não nasce**. O que a matriz validou foi o motor do composto; o
caminho de negócio real está bloqueado.

### US-08 — Movimentação individual · 7/7 + 3 variantes PASSOU
Evidências: `60-us08-movimentacao.json`, `61-us08-variantes.json`

| # | Cenário | Resultado | Evidência-chave |
|---|---------|-----------|-----------------|
| 8.1 | A cria requisição de movimentação | PASSOU | 201 `pendente`, destino "Contrato Assinado", zero `transfStatus` |
| 8.2 | Indicador agregado do painel | PASSOU | `/api/sod/movimentacoes-ativas` traz a proposta com origem→destino |
| 8.3 | Bloqueio de 2ª requisição (RN03) | PASSOU | 409 `MOVIMENTACAO_BLOQUEADA` + `requisicaoExistente` |
| 8.4 | Violação de SoD | PASSOU | 403 `VIOLACAO_SOD` |
| 8.5 | **B aprova → executa na Sinqia** | PASSOU | `executada` em 0,8 s; `respostaSinqia: OK` |
| 8.6 | Etapa refletida na Sinqia | PASSOU | painel 20050→**20051**; histórico ganhou registro com a NOSSA observação |
| 8.7 | Indicador após a decisão | PASSOU | executada sai da lista de ativas |
| 8.2-UI | Chip no Painel de Propostas | PASSOU | linha da proposta <PROP_F2> mostrou `pendente (→ Contrato Finalizado no Portal)` |
| 8.5-UI | Aprovação **pela interface** | PASSOU | drawer → "Aprovar e executar" → "Executada na Sinqia", histórico com "Tentativa 1" |
| V1 | Destino **20056 Cancelado** (ocorrência no Portal) | PASSOU | `executada`; proposta <PROP_L1> em 20056 — o `transfStatus` sozinho basta |
| V2 | Movimentação **20052→20053** | PASSOU | `executada`; proposta <PROP_P01> em 20053 |
| V3 | **Divergência externa** | PASSOU | `falha` causa `divergencia_externa`, esperado × atual, **nada movido**, bloqueio mantido |

### US-09 — Movimentação em massa · 8/8 PASSOU
Evidências: `70-prep-propostas-fila.json`, `71-us09-massa.json`, `71b-us09-historicos.json`

| # | Cenário | Resultado | Evidência-chave |
|---|---------|-----------|-----------------|
| 9.0 | Individual pendente (pré-condição) | PASSOU | 201 na proposta <PROP_F1> |
| 9.1 | Elegibilidade RN04 | PASSOU | 409 `SUBCONJUNTO_NAO_CONFIRMADO`: 1 inelegível com motivo, 2 elegíveis, **nada criado** |
| 9.2 | Lote-subconjunto com confirmação | PASSOU | 201 com 2 itens |
| 9.3 | **Bloqueio unificado** lote→individual | PASSOU | 409 `MOVIMENTACAO_BLOQUEADA`; agregado mostra 4 ativas, 2 de lote |
| 9.4a | Violação de SoD | PASSOU | 403 `VIOLACAO_SOD` |
| 9.4b | Decisão bidirecional | PASSOU | 1 aprovado, 1 reprovado com motivo |
| 9.5 | Execução item a item | PASSOU¹ | <PROP_F2> movida com a nossa observação (nrSeq 4); <PROP_F3> (reprovada) permaneceu em 20050 |
| 9.6 | Individual e lote coexistem | PASSOU | a individual de <PROP_F1> executou normalmente (bloqueio é por proposta, não por fila) |

¹ A asserção automática acusou divergência porque a proposta <PROP_F2> apareceu em
**20052** e não em 20051: o histórico mostra `nrSeq 4 → 20051` com a nossa
observação e `nrSeq 5 → 20052` **sem observação, pelo motor da Sinqia**. O
movimento foi correto; o motor avançou a etapa sozinho em seguida. Isso importa
para a US-08 (ver §3).

### US-10 — Retry e descarte · 8/8 PASSOU
Evidências: `80-us10-retry-descarte.json`, `85-us10-complemento.json`, `86-us10-liberacao.json`

| # | Cenário | Resultado | Evidência-chave |
|---|---------|-----------|-----------------|
| 10.1 | Falha em repouso com bloqueio mantido | PASSOU | `falha`/`divergencia_externa`; proposta segue bloqueada |
| 10.2 | Retry vedado ao requisitante | PASSOU | 403 `VIOLACAO_SOD` |
| 10.3 | Retry pelo aprovador, payload ORIGINAL | PASSOU | payload byte-a-byte idêntico; tentativas numeradas na trilha |
| 10.4 | Descarte exige motivo | PASSOU | sem motivo → 400; com motivo → `descartada` |
| 10.5 | **Descarte LIBERA o bloqueio** | PASSOU | na proposta <PROP_F4>: antes 409 `MOVIMENTACAO_BLOQUEADA` → descarte → depois **201** |
| 10.6 | Retry em `proposta.criar` | PASSOU | vedado a A (403), executado por B (200), causa `duplicidade_sinqia` mantida, 3 tentativas no histórico |

Registro honesto de método: as duas primeiras tentativas do cenário 10.5 foram
inconclusivas — a proposta usada tinha ido para 20056 (etapa terminal, sem
transições), então "nova requisição recusada" não provava nada. Refeito com uma
proposta viva (<PROP_F4>), o ciclo completo fechou.

### US-11 — Badge de pendências · 5/5 PASSOU
Evidência: `90-us11-badge.json`

| # | Cenário | Resultado | Medição (A / B) |
|---|---------|-----------|-----------------|
| 11.1 | Própria não conta para o criador | PASSOU | 0/1 → 0/**2** ao A criar |
| 11.2 | Lote conta como 1 | PASSOU | 0/2 → 0/**3** com lote de 2 itens |
| 11.3 | Simetria do maker-checker | PASSOU | 0/3 → **1**/3 ao B criar |
| 11.4 | Cai após a decisão | PASSOU | 1/3 → 1/**2** |
| 11.5 | Falha tratável de terceiro entra na conta | PASSOU | a falha de `proposta.criar` sustenta B=1 na linha de base |
| 11.6 | Badge na UI | PASSOU | topbar renderizou `Requisições 2`, igual ao endpoint |

### US-12 — Situação de tomador · 5/5 no BFF, **2 FALHOU na UI**
Evidência: `95-us12-situacao.json` + inspeção de UI

| # | Cenário | Resultado | Evidência-chave |
|---|---------|-----------|-----------------|
| 12.1a | Alteração vira requisição | PASSOU | 201 `pendente`, zero Sinqia |
| 12.1b | Duplicidade + violação de SoD | PASSOU | 409 `DUPLICIDADE_PENDENTE`; 403 `VIOLACAO_SOD` |
| 12.1c | B aprova → execução real | PASSOU | T05 `1 — ATIVO` → **`2 — INATIVO`** na Sinqia |
| 12.2 | Inativação com proposta em andamento | PASSOU (BFF) | T01 inativado; `propostasAfetadas: 1` no resultado |
| 12.3 | Massa com decisão bidirecional | PASSOU | L1a inativado; L1c permaneceu ATIVO com o motivo da exceção |
| 12.4 | **Rótulo da nova situação na tela do aprovador** | **FALHOU** | defeito #1 — ver §4.1 |
| 12.5 | **Aviso de impacto ANTES da decisão** | **FALHOU** | defeito #2 — ver §4.2 |

## 3. Bug reportado na US-08 — investigação e conclusão

**Sintoma reportado:** "a movimentação não executa na aprovação".
**Resultado: não reproduziu.** Seis caminhos independentes foram exercitados em
HML e **todos executaram na Sinqia**:

| Caminho | Movimento | Desfecho |
|---|---|---|
| API, caminho feliz | 20050 → 20051 | `executada` em 0,8 s; etapa refletida |
| API, destino Cancelado | 20050 → 20056 | `executada` |
| API, etapa adiante | 20052 → 20053 | `executada` |
| **UI**, drawer de pendências | 20052 → 20053 | `executada`; "Executada na Sinqia" |
| API, item de lote (US-09) | 20050 → 20051 | `executada` |
| API, retry de falha (US-10) | payload original | reexecutou e falhou pela causa correta |

Hipóteses testadas e **descartadas**:

1. **Falta de `incluirOcorrencia`** (o Portal usa Ocorrência 10/11 nas transições
   de 20050/20052). Descartada: V1 e V2 moveram exatamente essas transições só
   com o `transfStatus`, e a Sinqia confirmou.
2. **Eleição errada da etapa vigente** no histórico (`maior nrSeq`). Descartada:
   em todos os históricos coletados o maior `nrSeq` é o registro vigente.
3. **Payload/`request` persistido incompleto.** Descartada: o payload persistido
   foi conferido item por item e reexecutado intacto no retry.
4. **Tipo sem executor.** Descartada: `proposta.movimentar` está registrado em
   `EXECUTORES` e roda.

**As duas explicações que sobrevivem à evidência** — nenhuma delas é defeito do
código da US-08:

**(a) Aprovação tentada fora da janela da Sinqia.** A pré-verificação de sessão
(`verificarSessaoSinqia`, [sinqia-client.ts:267](apps/api/src/sinqia-client.ts:267))
devolve `indisponivel` em timeout, erro de rede ou 5xx, e a rota de decisão
([sod/rotas.ts:407](apps/api/src/sod/rotas.ts:407)) responde **502 sem
transição alguma — a requisição continua `pendente`**. Do lado do operador isso é
exatamente "aprovei e não movimentou". A US-08 foi entregue em um sábado, fora
da janela; se o teste que originou o report foi feito ali, o comportamento
observado é o esperado e está documentado no CONTEXTO.

**(b) Divergência externa provocada pelo próprio motor da Sinqia.** Medimos duas
vezes o motor avançando a etapa sozinho (20051 → 20052) em minutos, sem
observação. Se a etapa muda entre a criação da requisição e a aprovação, o
executor recusa mover e grava `falha` com causa `divergencia_externa` — correto
por RN, mas indistinguível de "não executou" para quem só olha a proposta. A
variante V3 reproduziu isso de propósito.

**Contribuindo para a leitura errada — dois textos de UI genéricos** (defeito #4,
§4.4): tanto o rodapé do drawer quanto o diálogo de confirmação afirmam que
aprovar "dispara o **cadastro do tomador** na Sinqia", mesmo quando a requisição
é de movimentação. Quem aprova uma movimentação e lê "cadastro do tomador" tem
motivo para achar que a ação errada foi disparada.

**Recomendação:** reproduzir com o PM em janela aberta, na proposta e no horário
do report. Se o sintoma reaparecer, o que precisamos é da requisição concreta —
com o `estado` que ela ficou e o `resultado.causa`, se houver. Não há correção a
propor sem isso: proponho **não** mexer no código da US-08.

## 4. Defeitos encontrados

> **Situação em 2026-08-10, fim do dia.** Quatro dos oito defeitos já foram
> corrigidos, validados na UI contra homologação e commitados nesta branch —
> cada um em um ciclo próprio, com aprovação do PM. Os cabeçalhos abaixo trazem
> o estado e o commit; o texto de cada um preserva o diagnóstico original.
>
> | # | Defeito | Estado |
> |---|---------|--------|
> | 4.1 | US-12 — situação nova invertida na tela do aprovador | **CORRIGIDO** (`b7f6408`) |
> | 4.2 | US-12 — sem aviso de impacto antes da decisão | **CORRIGIDO** (`49cec9d`) |
> | 4.3 | US-07 — composto não aceita tomador novo (`ID_Sinqia`) | ABERTO |
> | 4.4 | Textos de decisão falam sempre em "cadastro do tomador" | ABERTO |
> | 4.5 | US-12 — tela de situação não trata o desvio (SSE undefined) | **CORRIGIDO** (`7291490`) |
> | 4.6 | US-10 — `us10-retry.test.ts` quebrado e fora da suíte | ABERTO |
> | 4.7 | `npm run typecheck` falha (4 erros em `us12-situacao.test.ts`) | ABERTO |
> | 4.8 | US-11 — badge conta falhas que a fila esconde | **CORRIGIDO** (`311ace5`) |

### 4.1 [ALTO] US-12 — a tela do aprovador mostra a situação nova INVERTIDA · CORRIGIDO em b7f6408

**Arquivo:** [RequisicaoDetalhe.tsx:796](apps/web/src/components/RequisicaoDetalhe.tsx:796)

```js
const rotuloSituacao =
  cdSituacao === 1 ? "Inativo" : cdSituacao === 2 ? "Ativo" : cdSituacao === 3 ? "Em Análise" : String(cdSituacao ?? "—");
```

A tabela oficial (`packages/shared/src/situacao.schema.ts`) é **1 = ATIVO,
2 = INATIVO, 3 = BLOQUEADO JUDICIALMENTE** (e "EM ANÁLISE" é 11). O mapa está
trocado nos três casos.

**Reproduzido em HML:** requisição de **inativação** (`cdSituacao: 2`) do tomador
C1 exibiu, no drawer de decisão:
`Situação Anterior: 1 — ATIVO` · **`Nova Situação: Ativo`**.

**Por que é grave:** o aprovador decide sobre a informação exibida. Aqui ele lê o
**oposto** do que será executado — uma inativação parece uma ativação. É
exatamente a classe de erro que a segregação de funções existe para evitar, e o
BFF executa o valor correto (2), então o engano só aparece depois.

**Correção proposta:** trocar o mapa manual pelo helper que já existe e é a fonte
única — `situacaoLabel(cdSituacao)` de `@cadastro-lote/shared`, que devolve
`"2 — INATIVO"` (código + rótulo, como o resto da UI). Risco: nenhum
comportamento de backend muda; é uma linha de apresentação. Teste que passaria a
cobrir: renderizar `PayloadSituacaoTomador` com `cdSituacao` 1, 2 e 3 e afirmar o
rótulo — o que exige a infra de teste de frontend que o repo não tem
(registrado desde a US-02); alternativa imediata: um teste unitário de
`situacaoLabel` mais a troca do mapa.

### 4.2 [MÉDIO] US-12 — não existe aviso de impacto ANTES da decisão · CORRIGIDO em 49cec9d

**Arquivo:** [RequisicaoDetalhe.tsx:814](apps/web/src/components/RequisicaoDetalhe.tsx:814)

A seção "Impacto da alteração" só renderiza quando
`estado === "executada" || estado === "falha"` e depende de
`resultado.propostasAfetadas`, que **só existe depois** da execução (o executor
consulta as propostas durante a execução —
[execucao.ts:582](apps/api/src/sod/execucao.ts:582)).

**Reproduzido em HML:** o tomador C1 tinha **2 propostas**; o drawer de decisão
não exibiu nenhum aviso, e o diálogo de confirmação também não.

A RN da US-12 pede aviso de impacto na inativação com propostas em andamento, e a
§4.1 do CONTEXTO registra "consulta dinâmica ao backend durante a aprovação" —
não é o que o código faz. O impacto é apenas registrado *a posteriori*.

**Correção proposta:** expor a consulta de impacto como leitura antes da decisão
(por exemplo `GET /api/sod/requisicoes/:id/impacto`, reusando
`listarPropostasPorCpf`) e renderizar o aviso no drawer quando
`estado === "pendente"` e `cdSituacao !== 1`. Risco: uma chamada Sinqia a mais
por abertura de drawer desse tipo (somente leitura).

### 4.3 [MÉDIO] US-07 — o lote composto não aceita tomador novo (uso principal)

**Arquivo:** [emissoes.ts:201](apps/api/src/emissoes.ts:201) — `if (!idSinqia) erros.push("ID_Sinqia ausente.")`

O parser do Emissões exige `ID_Sinqia` em **toda** linha; linha com erro é
filtrada em `/api/propostas/calcular` ("Nenhuma linha apta para cálculo") e sem
cálculo não há lote. Mas o `ID_Sinqia` é o código do cliente **na Sinqia** — um
tomador que só vai ser criado pela execução deste lote não tem esse código.

**Reproduzido em HML:** planilha com 3 linhas de tomadores novos →
`erros: ["ID_Sinqia ausente."]` → 422. Com `ID_Sinqia` sintético (`999-9`) o
mesmo arquivo passou e o composto funcionou inteiro (10/10 na §2), o que confirma
que o ID não é usado na criação — o cliente é buscado por CPF na execução.

A suíte mockada não pegou isso porque a fixture
(`us07-proposta-lote.test.ts:262`) preenche `"333-6"` para tomadores chamados
"Tomador Novo N" — um valor que não pode existir na realidade.

**Correção proposta:** dispensar `ID_Sinqia` quando o CPF da linha estiver no
arquivo de tomadores do mesmo lote (o vínculo por CPF já é calculado em
`/api/propostas/criar`); manter a exigência nos demais casos. Alternativa mais
simples: rebaixar de erro para aviso quando houver arquivo de tomadores. Risco:
mexe no parser compartilhado pelo fluxo direto — precisa de teste do caso
"planilha sem ID + arquivo de tomadores" e do caso "planilha sem ID sem arquivo"
(que deve continuar recusando).

### 4.4 [BAIXO] Textos de decisão falam sempre em "cadastro do tomador"

No drawer de decisão e no diálogo de confirmação, para **qualquer** tipo:
"Aprovar executa o cadastro na Sinqia imediatamente" e "A aprovação dispara o
cadastro do tomador na Sinqia agora". Numa movimentação ou numa alteração de
situação o texto descreve a ação errada. Correção: parametrizar a frase por tipo
(já existe `ROTULO_TIPO_ACAO`). Contribui diretamente para a confusão relatada
na US-08 (§3).

### 4.5 [MÉDIO] US-12 — a tela de situação não trata o desvio de aprovação · CORRIGIDO em 7291490

**Arquivo:** [SituacaoClientes.tsx:345](apps/web/src/pages/SituacaoClientes.tsx:345)

```js
const { jobId, total } = await startAlterarSituacao(cdSituacao, alvos);
streamSituacao(jobId, { … });
```

Com a flag ativa o BFF responde **201 `{valido, aprovacao:true, requisicao:{…}}`
— sem `jobId`**. A tela então abre `EventSource("/api/situacao/stream/undefined")`.

**Reproduzido em HML** (sequência exata da tela): `POST /api/situacao` → 201 com
`requisicao.id = 93ef46d9-…`; `GET /api/situacao/stream/undefined` → **404
"Job não encontrado"** → o handler `onError` mostra ao operador *"Conexão de
progresso (SSE) caiu. Verifique o backend."*

Ou seja: a requisição **foi criada** e o operador vê uma mensagem de erro de
backend, sem saber que já existe pendência. Se ele repetir, toma 409
`DUPLICIDADE_PENDENTE`. Some-se a isso que `/api/env` **não expõe** as flags de
situação (`situacao_tomador*`), então a tela também não avisa "sob aprovação"
antes do envio, como a de cadastro individual faz.

**Correção proposta:** (i) acrescentar `situacaoTomador` ao objeto `aprovacao` de
`/api/env`; (ii) em `executarAlteracao`, tratar `aprovacao: true` como a tela de
cadastro individual (mensagem de requisição criada + link para "Requisições") e
não abrir SSE nesse caso; (iii) exibir o aviso "sob aprovação" na tela quando a
flag estiver ativa. Risco: baixo, isolado na página e no `/api/env`.

### 4.6 [MÉDIO, pré-existente] `us10-retry.test.ts` está quebrado e fora da suíte

O arquivo não está na lista do `npm test` e, executado isoladamente, **falha
inteiro (0 de 7)**. Foi escrito contra APIs que não existem: `abrirBancoSod()` sem
caminho, segundo parâmetro em `criarSodServico`, hook falso de sessão em vez do
`getSession` real, e tabelas `sod_itens_lote` / `sod_workflow_historico` no lugar
de `sod_lote_itens`. O `@ts-nocheck` no topo esconde tudo isso do compilador.

Efeito: **a US-10 não tinha nenhuma cobertura automatizada**. A validação desta
sessão (8/8 em HML, §2) é a primeira evidência real de que retry e descarte
funcionam. Correção: reescrever o arquivo no padrão dos demais (`us09-…` é o
modelo mais próximo) e incluí-lo no script `test`.

### 4.8 [BAIXO] US-11 — badge conta falhas que a fila esconde no filtro padrão · CORRIGIDO em 311ace5

Encontrado pelo PM ao conferir a tela depois da validação.

O badge da navegação conta, por RN04, **pendentes de terceiros + falhas
tratáveis** ([repositorio.ts:629](apps/api/src/sod/repositorio.ts:629):
`estado IN ('pendente','falha') AND requisitante != ?`). Já a fila de
"Pendências e Falhas" abre com **Estado = Pendentes**
([PainelPendencias.tsx:100](apps/web/src/pages/PainelPendencias.tsx:100)), e
falha não é pendente.

**Reproduzido:** badge = 1, fila mostra `0 pendência(s)` e o estado vazio afirma
**"Nenhuma requisição aguardando decisão. Tudo em dia!"** — contradizendo o badge
na mesma tela. A requisição existe (uma `proposta.criar` em `falha`, causa
`duplicidade_sinqia`) e só aparece ao trocar o filtro para "Falhas". O operador
não tem nenhuma pista de que precisa trocar o filtro.

**Correção proposta** — a base é a mesma nas três alternativas: estender
`GET /api/sod/pendencias-badge` para devolver `{ count, pendentes, falhas }`
(uma consulta, `SUM(CASE …)` no lugar do `COUNT(*)`, sem índice novo, mantendo
`count` para não quebrar o topbar). Sobre isso:

- **(A) contagem nas opções do seletor "Estado"** — "Pendentes (0)" / "Falhas (1)".
  Menor mudança visual, mas o número de falhas só aparece ao abrir o dropdown.
- **(B) dois chips clicáveis acima da fila** — `Pendentes 0` | `Falhas 1`, o de
  falhas em destaque quando > 0, substituindo o seletor. Os dois números ficam
  visíveis sem interação e casa com o título "Pendências e Falhas". *Recomendada.*
- **(C) estado vazio inteligente** — subtítulo passa a "0 pendência(s) · 1 falha
  para analisar" com atalho, e "Tudo em dia!" só aparece quando os dois são zero.
  A mais barata; resolve a contradição sem dar proeminência ao número.

Risco: baixo nas três (uma consulta agregada + apresentação). Teste que passaria a
cobrir: o endpoint com cenário misto (pendente de terceiro + falha de terceiro +
própria pendente) afirmando `pendentes`, `falhas` e `count`.

### 4.7 [BAIXO, pré-existente] `npm run typecheck` falha

4 erros, todos em `us12-situacao.test.ts` — entre eles a injeção de
`alterarSituacaoClienteFn`, que **não existe** em `RegisterRoutesDeps` (a rota
ignora a dependência, então o teste do fluxo direto não prova o que aparenta).
O runtime passa porque `tsx` não checa tipos.

## 5. Bloqueados

| Item | Causa |
|------|-------|
| **US-07 composto com tomador novo** | defeito #4.3 — validação de `ID_Sinqia`. O motor foi validado com ID sintético; o caminho de negócio real segue bloqueado até a correção. |
| Corridas de concorrência (duas decisões simultâneas; criação simultânea da mesma movimentação) | não reproduzíveis com confiabilidade por HTTP em HML; seguem cobertas pela suíte mockada (índices parciais + pré-checagem síncrona). |
| Guard `ACAO_SOB_APROVACAO` | inalcançável em operação normal (o desvio vem antes); evidência mockada. |
| Aprovação com Sinqia indisponível / sessão expirada durante a execução | exigiria derrubar o ambiente ou expirar o token sob demanda; caminho lido no código (§3a) e coberto por mock. |
| Testes automatizados de frontend | não existe infra no repo (registrado desde a US-02). Os defeitos #4.1, #4.2, #4.4 e #4.5 foram verificados por inspeção de UI no navegador e reprodução em nível de requisição. |

## 6. Como a validação foi executada (reprodutível)

Harness em `test-artifacts/harness/*.mjs`, marcado **`@homolog`** no cabeçalho de
cada arquivo. **Não roda no CI**: não é referenciado por nenhum script npm,
depende de `.env.test` (fora do repo) e da janela comercial da Sinqia. Os testes
automatizados do repo seguem 100% mockados e rodam a qualquer hora
(152/152 verdes nesta sessão).

```bash
npx tsx test-artifacts/harness/00-smoke.mjs
```

Ordem: `00-smoke` (aborta se o ambiente não for HML) → `01/02-recon` (leitura) →
`10/11` US-01/02/03 → `20/21` US-04 → `30` US-05 → `40` US-06 → `50` US-07 →
`60/61` US-08 → `70/71` US-09 → `80/85/86` US-10 → `90` US-11 → `95` US-12.

Proteções embutidas: o smoke recusa qualquer ambiente que não seja
`env=hml` + `isProd=false` + host com `hml`; os logins são substituídos por
`<OPERADOR_A>`/`<OPERADOR_B>` em toda evidência e log; senhas nunca são impressas.

## 7. Estado do ambiente ao final

- **As 8 flags `aprovacao.*` foram devolvidas para `inativa`** (estado de
  go-live), com as mudanças auditadas.
- 37 requisições, 16 itens de lote e 199 eventos de auditoria na base local; a
  única `falha` remanescente é a de `proposta.criar` usada como insumo da US-10.
- Entidades criadas em HML (10 tomadores, 7 propostas) inventariadas em
  [test-artifacts/entidades.md](test-artifacts/entidades.md), com a ação de
  limpeza sugerida por linha. Backup da base local anterior à validação guardado
  no scratchpad da sessão.
- Nada foi executado em produção.
