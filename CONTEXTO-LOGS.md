# CONTEXTO-LOGS.md — Discovery: Observabilidade e Trilha Auditável

> **Instrução ao agente (Claude Code):** este arquivo é o **contexto de partida de um Discovery**,
> não uma especificação de implementação. Leia-o integralmente antes de conduzir o Discovery ou
> escrever qualquer história derivada dele.
> **Nada aqui está decidido.** As listas das seções 4 e 5 são o *espaço de candidatos* levantado do
> código — cabe ao Discovery priorizar, cortar e desenhar. Não implemente nada a partir deste
> arquivo; ele existe para que o Discovery comece informado, e não do zero.
> A entrega da Esteira de Aprovação (SoD) tem seu próprio contexto mestre em `CONTEXTO-SOD.md`,
> que continua valendo e **prevalece** em qualquer divergência sobre a esteira.

---

## 1. De onde parte este Discovery

A Opea SCD é regulada pelo Banco Central. A entrega da **Esteira de Aprovação (SoD)** — 12 histórias
em duas ondas, concluída em 2026-08-10 — foi construída sobre duas exigências regulatórias
declaradas no `CONTEXTO-SOD.md`: **segregação de funções** e **log auditável de todas as ações**.

A segregação de funções está entregue e é forte: maker-checker no domínio, máquina de estados
atômica, corte total por feature flag. **A parte de "log auditável" foi entregue apenas para as
ações que passam pela esteira** — e a esteira, no go-live, nasce com todas as flags **inativas**.

Daí a pergunta que origina este Discovery:

> Hoje, se o BACEN, a auditoria interna ou o Head SCD pedir "me mostre tudo o que foi feito nesta
> plataforma no mês passado, por quem, quando, com que resultado" — **conseguimos responder?**

A resposta curta, olhando o código: **parcialmente, e só para o que passou pela esteira.** Existe
uma trilha de auditoria sólida em `sod_auditoria`, existe uma tabela `eventos` quase vazia de
propósito, e praticamente **não existe log de aplicação**. Este Discovery precisa dimensionar essa
lacuna, separar o que é **exigência regulatória** do que é **conforto de operação**, e propor um
desenho.

**Origem:** PM Cassio (PPM), Opea SCD/Produtos. Continuidade natural do Discovery "Esteira de
Aprovação (SoD)". Stakeholder provável: Rodrigo Shyton de Melo (Head SCD) para a dimensão
regulatória; TL para a dimensão técnica; Segurança para retenção e dados pessoais.

---

## 2. As duas coisas que este Discovery trata (e por que não são a mesma)

O pedido chega como "logs", mas são **dois produtos diferentes**, com donos, prazos de retenção,
públicos e critérios de sucesso distintos. Confundi-los é o principal risco do Discovery.

| | **Trilha auditável (banco)** | **Log de aplicação (stdout/observabilidade)** |
|---|---|---|
| Pergunta que responde | *Quem fez o quê, quando, com que resultado?* | *Por que isso está lento / quebrado / falhando?* |
| Público | Auditoria, BACEN, Head SCD, Compliance | Quem sustenta a aplicação (dev/TL/PM) |
| Natureza | Registro de **negócio**, append-only, imutável | Registro **técnico**, volátil, descartável |
| Fonte da verdade | Sim — é o controle em si | Não — é apoio ao diagnóstico |
| Perda aceitável | **Nunca** | Sim (rotação, amostragem) |
| Dados pessoais | Inevitáveis (CPF é a chave do negócio) | Devem ser **evitados** ou mascarados |
| Retenção | Anos (a definir — ver seção 6) | Dias/semanas |
| Se falhar a gravação | A ação **não pode acontecer** | A ação segue normalmente |

Essa última linha já é uma decisão implementada e vale registrar: em `sod/repositorio.ts:21-23`
está escrito que falha de banco na esteira **propaga** ("sem registro, a ação não existe"),
enquanto em `db.ts:19-20` está escrito que falha de banco **nunca derruba o fluxo** de negócio. As
duas posturas coexistem no repo hoje, cada uma no lugar certo — e o Discovery deve preservar
essa distinção, não uniformizá-la.

---

## 3. O que existe hoje (levantamento factual do código — 2026-08-10)

### 3.1 Trilha auditável — existe e é boa, mas cobre pouco

**Existe (`apps/api/src/sod/`):**
- Tabela `sod_auditoria` (`repositorio.ts:236`) com ambiente, requisição, ator, ação, detalhe
  (JSON), resultado e timestamp; índices por requisição, por ator+data e por data.
- **Append-only garantido pelo banco**: triggers `trg_sod_auditoria_sem_update` e
  `trg_sod_auditoria_sem_delete` abortam UPDATE/DELETE (`repositorio.ts:338-351`). A camada de
  repositório também não expõe update/delete (`repositorio.ts:1037-1040`).
- Quatro ações registradas (`dominio.ts:59-64`): `requisicao_criada`, `transicao_estado`,
  `execucao_iniciada`, `tentativa_rejeitada` — esta última cobre violação de SoD e transição
  inválida, que é exatamente o que auditoria quer ver.
- `flag_alterada` gravado na **mesma transação** da mudança de feature flag
  (`repositorio.ts:717`, `ACAO_FLAG_ALTERADA`).
- O `detalhe` guarda o resultado **integral** da Sinqia (`dominio.ts:157-159`) — a trilha conta a
  história sozinha, sem depender da tabela de requisições.
- Endpoint de consulta `GET /api/sod/auditoria` com filtro por ator, requisição e período
  (`rotas.ts:677`).

**Não existe / cobre pouco:**
- **Nenhuma tela consome `/api/sod/auditoria`.** O frontend só mostra o histórico *daquela*
  requisição, dentro do `RequisicaoDetalhe.tsx:372`. Não há console de auditoria, busca por
  operador, nem exportação. O endpoint está pronto e órfão.
- **Fluxo direto não é auditado.** Com a flag do tipo inativa — que é o estado de go-live
  (`CONTEXTO-SOD.md`, US-05) — a ação executa direto na Sinqia e **nada** é gravado localmente.
  Cadastro de tomador (individual e lote), cálculo, verificação e alteração de situação não
  geram registro algum.
- A tabela `eventos` (`db.ts:49-57`) é o que mais se aproxima de trilha genérica: tem `ts`,
  `ambiente`, `usuario`, `tipo`, `detalhe`. Só que é gravada de **4 pontos** e com **3 tipos**:
  `proposta_criada` (`criacao-job.ts:359`), `transferencia_status`
  (`routes-propostas.ts:1545` e `transferencia-job.ts:177`) e `persona_definida`
  (`routes-propostas.ts:1813`). **Não tem função de leitura em lugar nenhum** — é write-only.
  E as duas gravações dentro de jobs estão em `try {} catch {}` **vazio**: se a gravação falhar,
  ninguém fica sabendo.
- **Login, logout e sessão não são auditados.** Nem sucesso, nem falha (ver 3.2).
- **Consulta de dados não é auditada.** Quem listou a base de clientes, quem exportou, quem abriu
  a ficha de qual CPF — não há registro. Para dado pessoal isso costuma ser exigência.
- Sem `sessionId`, IP ou user-agent em nenhum evento — o ator é só o login Sinqia normalizado.

### 3.2 Log de aplicação — praticamente inexistente

- Logger **pino embutido do Fastify**, `level: "info"` **hardcoded** em `server.ts:11-27`, com
  `redact` de `authorization`, `proxy-authorization`, `password` e `token`. Saída: JSON cru no
  stdout, sem transport, sem arquivo, sem rotação.
- **8 chamadas de log em todo o backend.** Uma de boot (`server.ts:53`), uma de erro de boot
  (`:57`), uma de login OK (`routes.ts:196`) e 5–7 de evento de negócio em
  `routes-propostas.ts`.
- **Falha de login não é logada** (`routes.ts:181-186`): senha errada, VPN caída, host errado —
  tudo devolve 401/502 em silêncio. Sem contador de tentativas, sem IP, sem rate limit.
- **Nenhum erro 4xx/5xx é logado.** O padrão em todo o backend é
  `reply.code(...).send({ error: e.message })` — a mensagem vai para o usuário e **não** para o
  log. Isso vale para ~13 pontos de `502` e 4 de `500`.
- **Nenhum `setErrorHandler`, `setNotFoundHandler` ou `addHook`** no projeto inteiro.
- **`sinqia-client.ts` (1033 linhas) não tem um único log.** Nenhuma medição de latência, nenhum
  registro de status ou de corpo de erro. Timeout existe (`REQUEST_TIMEOUT_MS`, default 30 s);
  retry vive nos jobs, não no client.
- **Não existe ID de correlação.** Nada liga uma ação da UI → requisição no BFF → chamada à
  Sinqia → evento de auditoria. O `reqId` do Fastify é um contador por processo que morre no log
  de linha.
- **Jobs são 100% em memória** (`batch.ts:74-75` e os 5 equivalentes): `Map` de estado +
  `EventEmitter` para SSE, retenção de 10 jobs concluídos. Se o processo morrer no meio de um
  lote, **os itens já enviados à Sinqia estão efetivados lá e o registro local some** — sem
  marca de "job interrompido", sem retomada. Nenhum job loga nada.
- **Sem `process.on("SIGTERM"/"uncaughtException"/"unhandledRejection")`** em lugar nenhum.
- **Frontend sem nenhuma captura global:** zero `ErrorBoundary`, zero `window.onerror`, zero
  `onunhandledrejection`, zero telemetria. Um throw em render dá tela branca silenciosa. Erro de
  API vira `setErro(...)` inline na página (`lib/session.tsx:58-73`).
- **Zero dependência de observabilidade** em qualquer workspace: sem pino explícito, sem
  pino-pretty, sem OpenTelemetry, sem Sentry, sem prom-client.
- **Nenhuma variável de ambiente** de log level, formato, destino, service name ou `NODE_ENV`
  (`env.ts` tem 30 variáveis, nenhuma de observabilidade).

### 3.3 O contexto de execução — a restrição que muda tudo

Isto não é detalhe de infra; é **premissa central do Discovery**:

- A aplicação é **local, por operador**. O README é explícito (linhas 3, 90-94, 145-147): roda na
  máquina do usuário, atrás da VPN da Opea, com dois terminais abertos. **Não há deploy em
  servidor, não há Docker, não há CI, não há PM2/systemd/Nginx.** O `git ls-files` não retorna
  nenhum arquivo de infra.
- O backend escuta em `127.0.0.1` (`server.ts:52`) e o README (linha 479) diz literalmente que é
  "uma ferramenta estritamente local (1 operador por máquina)".
- A API roda **direto do TypeScript via `tsx`**, sem build (`start` = `tsx src/server.ts`).
- O SQLite (`env.SQLITE_PATH`, default `./data/esteira.db`) é o **mesmo arquivo** para o banco
  local e para a esteira SoD (`sod/rotas.ts:154`).

**Consequências que o Discovery precisa encarar de frente:**

1. Os logs pino em JSON vão para o stdout de um terminal na máquina do operador. **Fechar o
   terminal perde tudo.** Não há coleta, arquivo, rotação nem agregação.
2. A trilha de auditoria — o controle regulatório — mora num arquivo SQLite **na máquina do
   operador**, sob o controle dele. As triggers append-only protegem contra bug de aplicação;
   **não protegem contra quem tem acesso ao arquivo.** Para um controle exigido pelo BACEN, isso
   é uma questão aberta séria, não um detalhe.
3. Se cada operador tem o seu próprio `esteira.db`, **como o maker-checker funciona entre duas
   pessoas?** Ou existe um banco compartilhado que não está documentado no README, ou a esteira
   pressupõe um modo de execução diferente do descrito. **Isto precisa ser confirmado com o TL
   logo no início do Discovery** — a resposta muda completamente o desenho de tudo o que vem
   depois.

---

## 4. Candidatos — Trilha auditável em banco

> Lista de **candidatos levantados do código**, não backlog aprovado. O Discovery prioriza.

**Cobertura (o que hoje não deixa rastro)**
1. Autenticação: login OK, login falho (com motivo), logout, expiração de sessão, sessão
   invalidada durante execução.
2. Ações do **fluxo direto** (flag inativa): cadastro individual e em lote, criação de proposta,
   movimentação, alteração de situação, cálculo e verificação. Hoje só existem 3 tipos de evento
   em `eventos`, cobrindo uma fração.
3. Leitura/consulta de dado pessoal: listagem de clientes, abertura de ficha, exportação,
   download de template preenchido. (Verificar com Segurança/Compliance se é exigível.)
4. Ciclo de vida dos jobs: início, fim, contadores, interrupção por queda do processo, abortos
   por sessão expirada.
5. Falhas de integração com a Sinqia — hoje visíveis só na tela de quem disparou.
6. Mudança de configuração/ambiente (troca hml↔prod, mudança de env).

**Estrutura e integridade**
7. Unificação (ou não) de `sod_auditoria` e `eventos`: duas trilhas com propósitos parecidos e
   garantias muito diferentes. Convergir? Manter separadas com fronteira explícita? Trade-off
   real — `sod_auditoria` é o controle regulatório e não deveria diluir.
8. Correlação: `correlationId`/`traceId` atravessando UI → BFF → Sinqia → trilha.
9. Contexto do ator além do login: sessionId, IP/host, ambiente, versão da aplicação.
10. Integridade **verificável**: hash encadeado, assinatura, ou WORM externo. Responde à pergunta
    "como provamos que ninguém editou o arquivo?".
11. Centralização: se hoje a trilha é por máquina, o controle não é auditável de fato. Servidor
    compartilhado, sincronização, ou banco central — decisão de arquitetura, não de log.

**Uso**
12. Console de auditoria na UI (o endpoint `/api/sod/auditoria` já existe e não tem tela).
13. Exportação para auditoria (CSV/planilha assinada) — formato a definir com quem consome.
14. Política de retenção e expurgo — e como expurgar uma tabela append-only sem quebrar a
    garantia.
15. Leitura da tabela `eventos`, hoje write-only.

---

## 5. Candidatos — Log de aplicação (stdout / observabilidade)

**Fundação**
1. Nível de log por env (`LOG_LEVEL`), hoje hardcoded em `server.ts:13`.
2. `NODE_ENV`/`SERVICE_NAME`/versão no log — hoje `SINQIA_ENV` é a única noção de ambiente.
3. Destino: stdout puro hoje. Arquivo com rotação? `pino-pretty` em dev? Coletor? Depende
   inteiramente da resposta de 3.3.
4. `setErrorHandler` + `setNotFoundHandler` globais: nenhum erro devolvido ao usuário deveria
   sair sem log correspondente.
5. Handlers de `uncaughtException`, `unhandledRejection` e `SIGTERM` (shutdown gracioso —
   relevante porque jobs em memória morrem sem deixar rastro).

**Cobertura**
6. Instrumentação do `sinqia-client.ts`: endpoint, status, latência, tamanho, tentativa
   (attempt/retry) — sem corpo, sem credencial. É aqui que mora o diagnóstico de "a Sinqia está
   lenta" vs "nosso código está lento".
7. Log de falha de login com motivo classificado (credencial × VPN × indisponibilidade). Hoje é
   o silêncio mais caro do sistema: o operador vê "erro" e ninguém sabe o que houve.
8. Log estruturado do ciclo de vida dos jobs (início, progresso agregado, fim, duração, contagem
   de sucesso/erro, motivo de interrupção).
9. Distinguir no log o que é **indisponibilidade esperada da Sinqia** (fora do horário comercial
   — ver `CONTEXTO-SOD.md`, seção final) de erro real. Sem isso, o log noturno é ruído puro.

**Frontend**
10. `ErrorBoundary` na raiz + captura de `window.onerror` / `unhandledrejection`. Hoje um erro de
    render é tela branca sem registro.
11. Canal de reporte de erro do frontend para o BFF (mesmo que só grave no log local) — sem isso,
    erro de UI só existe se o operador contar.
12. Correlação ponta a ponta: o id que o BFF gera precisa aparecer na tela do erro, para o
    operador conseguir citá-lo ao pedir suporte.

**Operação**
13. Endpoint de health/diagnóstico (VPN, Sinqia alcançável, banco acessível, versão).
14. Métricas mínimas, se fizer sentido no modelo local (contadores por operação, latência p95).
15. Documentação de "como ler o log" no README — hoje há 3 menções a log, todas sobre o que
    **não** é logado.

---

## 6. Aspectos técnicos a se atentar

Estes são os pontos onde o Discovery erra se não prestar atenção. Cada um é uma **restrição
real do repositório**, não teoria.

**1. Segurança — herdada do `CONTEXTO-SOD.md`, seção 5, e inegociável.**
Nunca persistir token, senha ou credencial Sinqia — em tabela, log ou auditoria. A redação atual
(`server.ts:15-23`) cobre `authorization`, `password` e `token`; qualquer log novo precisa ser
auditado contra vazamento. Atenção especial ao `sinqia-client.ts`, onde a resposta bruta
(`rawBody`, truncada em 2000 chars) circula em memória e hoje não vai a log nenhum — se passar a
ir, é o ponto mais provável de vazamento do sistema.

**2. Dado pessoal — CPF é a chave de negócio, não um detalhe.**
A trilha de auditoria *precisa* do CPF (é como se identifica a ação). O log de aplicação
*não deveria* tê-lo. Existe um precedente no próprio código: `routes-propostas.ts:1813` grava
`documento: "...1234"` mascarado. O Discovery precisa decidir a régua e aplicá-la
consistentemente — e envolver Segurança/Compliance sobre retenção de dado pessoal em log.

**3. Portabilidade SQLite → PostgreSQL.**
Migração já planejada (`CONTEXTO-SOD.md`, seção 5). Toda estrutura nova de banco entra com SQL
portável e `// MIGRATION-NOTE:` nas exceções, no padrão já estabelecido em `sod/repositorio.ts`.
Cuidado específico: as triggers append-only são `RAISE(ABORT)` do SQLite e viram função PL/pgSQL
no Postgres — nota já registrada em `repositorio.ts:336-337`.

**4. Volume e custo de escrita.**
Um lote roda até 70+70 itens; o overhead medido da esteira é de ~0–3 ms/item
(`CONTEXTO-SOD.md`, US-06). Auditar cada item, cada chamada Sinqia e cada consulta pode mudar
essa ordem de grandeza. SQLite em WAL num arquivo local tem limite de escrita concorrente que o
Postgres não tem — e o modelo hoje é single-process, o que ajuda, mas não é para sempre.

**5. Zero dependência nova sem checkpoint.**
Regra herdada (`CONTEXTO-SOD.md`, seção 5): não introduzir ORM ou biblioteca nova sem propor no
checkpoint. Isso vale em cheio aqui — pino já vem embutido no Fastify; OpenTelemetry, Sentry,
transports e coletores são decisão de arquitetura com custo de operação, não escolha de
implementação. O repo hoje tem **zero** dependência de observabilidade, e isso é uma posição, não
um esquecimento.

**6. Não regressão.**
Fluxos diretos e a esteira já entregue permanecem intactos. Instrumentar não pode mudar
comportamento — em particular, log ou auditoria de apoio **nunca** pode derrubar um fluxo de
negócio (`db.ts:19-20`), enquanto a gravação da trilha regulatória **precisa** derrubar
(`sod/repositorio.ts:21-23`). Preservar as duas posturas.

**7. Jobs em memória são o maior buraco de rastreabilidade.**
Não é problema de log — é de arquitetura. Nenhuma quantidade de `app.log.info` resolve o fato de
que um lote interrompido não deixa registro do que foi efetivado na Sinqia. Se o Discovery tratar
isso só como "logar mais", vai entregar a percepção de rastreabilidade sem a rastreabilidade.

**8. Sem build, sem Docker, sem CI, sem servidor.**
Qualquer proposta que pressuponha coletor, agente APM, sidecar ou pipeline **está propondo
infraestrutura que não existe** — e essa infraestrutura é, provavelmente, uma entrega maior que a
de logs em si. Dimensione honestamente, e trate como dependência externa (possivelmente com
Infra/TI), não como parte do escopo.

**9. Janela da Sinqia.**
As APIs só operam em horário comercial, dias úteis (`CONTEXTO-SOD.md`, seção final). Timeout à
noite ou no fim de semana **não é bug** — e o desenho de log/alerta precisa saber disso, senão
gera alarme falso todo fim de semana. Testes usam sempre mock; validação real só na janela.

**10. Ausência de teste de frontend.**
Registrado desde a US-02 do SoD: o repo não tem infra de teste de frontend. Qualquer proposta de
`ErrorBoundary`/captura global precisa considerar como será verificada.

---

## 7. Perguntas em aberto — abrir o Discovery por elas

Estas são as perguntas cuja resposta **muda o desenho**. Não devem ser respondidas pelo agente
sozinho (`CONTEXTO-SOD.md`, regra 5: propor 2–3 opções com trade-offs e parar).

**Para o TL / arquitetura**
1. O `esteira.db` é mesmo por máquina, ou existe banco compartilhado não documentado? Como o
   maker-checker funciona hoje entre dois operadores? **Esta é a primeira pergunta — tudo depende
   dela.**
2. Existe intenção de sair do modelo local para um servidor? Em que horizonte? Faz sentido
   desenhar observabilidade para o modelo local ou esperar?
3. Onde a trilha de auditoria deve viver para ser considerada confiável?

**Para o Head SCD / Compliance / Segurança**
4. Qual é a exigência **formal** de log auditável para este produto? Existe norma, política
   interna ou resposta a apontamento de auditoria que possamos ler? (Hoje trabalhamos com o
   princípio geral, não com um requisito escrito.)
5. Prazo de retenção da trilha? E do log de aplicação?
6. Consulta/leitura de dado pessoal precisa ser auditada, ou só a alteração?
7. Quem consome a trilha, com que frequência e em que formato? (Isso define se o entregável é
   tela, exportação ou só banco.)
8. A trilha precisa ser **demonstravelmente imutável** (hash/assinatura/WORM) ou "append-only
   pela aplicação" satisfaz?

**Para o PM / priorização**
9. O que dói **hoje** na operação? Já houve incidente em que faltou informação para investigar?
   (O caso mais provável: falha de login sem motivo registrado.)
10. Com as flags SoD ainda inativas, a falta de auditoria do fluxo direto é risco aceito
    temporariamente ou lacuna a fechar já?

---

## 8. Como conduzir

- Este Discovery segue o padrão Opea. Use a skill `write-discovery` (nível L2 padrão; L3 se a
  dimensão regulatória se confirmar crítica) — contexto do stakeholder, dor relatada, 5 porquês,
  dimensionamento de impacto, soluções consideradas com RICE, solução escolhida validada com
  TL/GPM/stakeholder, próximos passos.
- **Separe os dois produtos** (seção 2) desde o início. É provável que a trilha auditável seja
  entrega regulatória priorizada e o log de aplicação seja melhoria de sustentação — com RICE,
  donos e prazos diferentes. Tratá-los como um épico único é o erro mais fácil de cometer aqui.
- **Confirme a premissa de execução (3.3) antes de qualquer estimativa.** Se a aplicação é local
  por operador, boa parte da lista da seção 5 não tem onde pousar, e a seção 4 vira uma discussão
  de arquitetura antes de virar uma de log.
- Levante evidência antes de opinião: os números da seção 3 vieram do código em 2026-08-10 e são
  verificáveis. Reverifique-os antes de citá-los como fato — o repositório continua andando.

---
*Origem: PM Cassio (PPM), Opea SCD/Produtos — 2026-08-10. Continuidade do Discovery "Esteira de
Aprovação (SoD)" (`CONTEXTO-SOD.md`), cujas 12 histórias foram concluídas nesta data. Levantamento
da seção 3 feito por leitura direta do repositório na branch `feature/sod-onda-2`.*
