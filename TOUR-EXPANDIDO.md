# Tour Guiado Expandido — Relatório da Fase 0 e Roteiro

> Documento de checkpoint da FASE 0. Nenhum código de feature foi escrito.
> Fonte da verdade do roteiro para as Fases 1–4.

---

## 1. Como o tour funciona hoje

| Peça | Onde | O que faz |
|------|------|-----------|
| Biblioteca | `driver.js@1.8.0` (`apps/web/package.json:22`) | Overlay + popover; CSS da marca em `apps/web/src/index.css:375-440` (`.opea-tour`) |
| Roteiro | `apps/web/src/lib/onboarding-roteiro.ts` | `ROTEIRO_TOUR` (6 passos), `CHECKLIST_ITENS` (5), `HINTS` (9) |
| Motor | `apps/web/src/components/onboarding/ProductTour.tsx` | Monta os steps, navega antes de cada passo, espera o elemento |
| Estado | `apps/web/src/lib/onboarding.tsx` + `apps/api/src/db.ts:72` | Contexto React → `GET/PUT /api/onboarding` → tabela `onboarding_estado` |
| Convite | `components/onboarding/PrimeiroAcessoDialog.tsx` | Dialog de 1º acesso (Fazer o tour / Pular) |
| Checklist | `components/onboarding/ChecklistOnboarding.tsx` | Painel recolhível, canto inferior direito |
| Hints | `components/onboarding/Hint.tsx` | Ícone "?" ancorado, dispensável por usuário |
| Reabrir | `components/Topbar.tsx:62-72` | Botão "Tour" (bússola) no header |

**Ancoragem.** Cada passo declara `seletor`, que vira `[data-tour="<seletor>"]`. Existem **apenas 5 âncoras `data-tour` em todo o frontend**:
`inicio-saude` (VisaoGeralEsteira.tsx:64), `tomadores-tabela` (SituacaoClientes.tsx:611), `painel-esteira` (PainelPropostas.tsx:875), `lote-upload` (PropostasLote.tsx:845), `individual-cliente` (PropostaIndividual.tsx:465).

**Navegação.** Não há router. O App guarda a tela em estado (`modulo` + `telaClientes`/`telaPropostas`/`telaRequisicoes`) e **mantém todas as telas montadas** com `hidden` (App.tsx:95-96) — por isso `esperarVisivel` testa `offsetParent !== null` e não só a existência do nó. O tour navega chamando `irParaPaginaTour` (App.tsx:64-73).

**Persistência.** `onboarding_estado(ambiente, usuario, tour_concluido, checklist_itens, hints_dispensados)`. `checklist_itens` é um JSON livre `Record<string, boolean>` — merge incremental no PUT (db.ts:235-265).

---

## 2. Inventário de telas e funcionalidades

### Topbar (todas as telas)
Chip de ambiente **HML/PRODUÇÃO** (vermelho em prod, com tooltip); "Originação CCB · Sinqia BJ21M05"; data; logo; navegação de 4 módulos (Início, Tomadores, Propostas, Requisições) — **Requisições com badge de pendências** (polling 30 s + evento `sod:decisao`); usuário; **timer de sessão** (menor prazo entre inatividade 30 min, teto 8 h e expiração do token; tooltip explica quando o token é opaco); botão **Tour**; **Sair**. Dialog de reautenticação sem perder o estado da tela.

### 1. Início (dashboard, 4 camadas)
- **Filtro global de convênio** (combobox pesquisável) + **refresh que ignora o cache**; chip do convênio ativo com "limpar".
- **Fluxo — Saúde da esteira**: 4 stats (Ativas no fluxo · Aguardando ação · Atrasadas > 72 h · Concluídas, com canceladas/negadas no rodapé); **donut por categoria** com legenda, contagem e %; **"Onde está travando"** — top 8 etapas por tamanho de fila, barra colorida por categoria, ⚠ laranja com o nº de atrasadas, **clique abre a fila no Painel levando o convênio junto**; aviso de varredura parcial em base grande.
- **Valor — Valor originado**: originado no mês + variação vs. mês anterior; ticket médio + mediana + nº de contratos; **líquido liberado com cobertura explícita** (só existe para o que a ferramenta criou); barras mensais **empilhadas por convênio** com legenda.
- **Velocidade**: tempo de ciclo (média + mediana), throughput semanal, **tempo médio por etapa** — duração, não fila (a descrição do card já faz essa distinção).
- **Conversão — Funil**: tomadores (persona) → propostas → aprovadas* → contratos, % de passagem por degrau, **maior perda em destaque**, taxa total; nota de que o degrau de tomadores sai do cálculo quando há filtro de convênio.
- Cards de navegação para os dois módulos.
- Hints existentes: `filtro_convenio`, `aguardando_acao`.

### 2. Tomadores › Base de tomadores
Carga automática; **toggle Todos/PF/PJ** (recarrega já filtrado na Sinqia); refresh; **filtro local instantâneo** (nº do tomador casa exato; nome e CPF/CNPJ por parte do texto, com ou sem máscara); contador de resultados; teto de 200 linhas renderizadas com aviso; aviso de carga truncada; aviso de registros sem `nrCliente`; **"Selecionar os N filtrados"** (inclusive os não exibidos); coluna **Persona** clicável (PF nasce tomadora, PJ só se promovida — é o que alimenta o funil); por linha: **Propostas** (diálogo com as propostas do tomador na Sinqia → **"Ver dados"** → campos principais + **plano de parcelas** + JSON cru) e **Editar** (leva ao Cadastro individual com `idAcao=AL`); CTA **"Alterar situação (N)"** → modal com a lista dos selecionados, remoção individual e, **em produção, confirmação digitada "ALTERAR"**; progresso por SSE + tabela de resultado com **exportar CSV**; aviso de sessão curta; banner SoD quando a flag está ativa; banner de requisição criada.
Hints: `tipo_pessoa`, `persona_tomador`.

### 3. Tomadores › Cadastro individual
Tipo PF/PJ detectado pelo documento; contador de campos preenchidos; **Exemplo PF / Exemplo PJ / Limpar**; card **Campos obrigatórios da Sinqia** (`consultarCamposObrigatorios`, somente leitura — marca `*` no formulário, mostra formato reconhecido e HTTP status); card **Controles do cadastro** (`step="FI"` = finalizar e enviar ao Motor de Crédito; `idAcao` IN/AL/EX com aviso em EX; `idIntegracaoCadastro`; `idRetorno`); formulário em seções; **Validar** (dry-run) e **Cadastrar** com confirmação; resultado com payload; banner SoD + atalho "Ver requisições"; faixa de modo edição vinda da Base.
Hints: `campos_obrigatorios`, `controle_idacao`.

### 4. Tomadores › Cadastro em lote
Upload **.csv/.json** + **template CSV**; **mesmos controles** do individual (valem para todas as linhas); Validar → erros por linha (**sob aprovação o lote só vira requisição com todas as linhas válidas** — o aprovador confere mérito, não formato); execução com progresso e resultado; banner SoD; aviso de sessão curta.

### 5. Propostas › Painel de propostas
- Card **Esteira**: todas as etapas com contagem, **etapas vazias ocultas** (inclusive as de passagem automática), cor por categoria, clique seleciona a fila; refresh.
- **Fila**: título da etapa, **agrupamento por convênio** (com soma de valor e checkbox por grupo), **filtros recolhíveis** (nº, CPF, convênio, nome, data inicial/final) com contador de filtros ativos, **Exportar CSV** da fila como está na tela, paginação por cursor ("Carregar mais"), estado vazio com "Limpar filtros e recarregar".
- Colunas: Nº, Tomador, CPF/CNPJ, Produto, Valor, Status, Entrada, **SLA** (horas até 72 h, dias depois, destaque acima do SLA), Contrato, **Histórico** expansível por proposta.
- **Movimentação**: gesto **Mover** por linha (só com a flag ativa) e **"Mover selecionadas (N)"** — modal com destino revalidado no `consultarStatusTransf`, **observação obrigatória que vai para o histórico de todas as propostas**, confirmação digitada "MOVER", aviso de propostas bloqueadas e etapa de confirmação de subconjunto.
- **Indicador de movimentação ativa** por proposta (chip "pendente (→ destino)" / "executando" / "falhou") → abre o drawer da requisição, com cancelamento.
Hint: `painel_sla`.

### 6. Propostas › Lote de propostas
`PipelineSteps` de 4 passos; upload **Emissoes .xlsx/.csv** + modelo CSV; (sob aprovação) **upload opcional de tomadores** .csv/.json, vinculados por CPF, que executam **antes** das propostas; **parâmetros do lote** (produto, convênio e loja das listas da Sinqia; taxa e data do contrato definidos aqui); tabela de linhas com seleção e filtro por situação; **verificação de clientes** (ok / divergentes / não cadastrados); **cálculo** (`calcProsp` — **não grava nada na Sinqia**) com divergências; conferência; **criação** com confirmação (modo piloto e forçar) — ou **"Enviar para aprovação"** quando a flag está ativa; resumo vivo com o CTA da fase.
Hint: `params_lote`.

### 7. Propostas › Proposta individual
4 passos; busca do tomador por CPF; **parâmetros vindos das listas da Sinqia**; **dados da operação** (líquido é o que o tomador recebe; TAC, seguro e outros são financiados por cima); cálculo e **conferência**; criar com confirmação; "Nova proposta deste cliente".
Hint: `dados_operacao`.

### 8. Requisições › Pendências e Falhas (SoD)
Dois **chips Pendentes | Falhas** com contagem (mesma fonte do badge); filtros **Tipo de ação** e **Criador**; Atualizar; tabela (Criada em, Tipo, Criador com marca "você", Tomador/nº de itens, Documento, ação **Revisar e decidir** / **Analisar Falha** / Detalhes); paginação. **Drawer de decisão**: renderizador por tipo de payload, **Histórico/trilha com contagem de tentativas**, **Resultado da execução** com resposta integral da Sinqia, **marcação de exceções** em lotes (decisão bidirecional, motivo obrigatório nas duas direções), **aviso de impacto** (propostas vinculadas a tomador reprovado; inativação com propostas em andamento), **Aprovar / Reprovar** com motivo obrigatório, **bloqueio maker-checker visível** ("Você criou esta requisição — outro operador precisa decidi-la"), **Reprocessar / Descartar** em falha (também por item de lote).

### 9. Requisições › Minhas requisições
Filtros Estado e Tipo; tabela; detalhe em drawer; **Cancelar** (só o criador, só em pendente).

---

## 3. Cobertura do tour atual

| Passo atual | Cobre | Não cobre |
|---|---|---|
| `boas-vindas` | Enquadramento (~2 min) | Não anuncia capítulos nem o que vem |
| `inicio-saude` | 1 parágrafo sobre a camada Fluxo | Valor, Velocidade, Funil, gargalos clicáveis, filtro, refresh |
| `tomadores` | Frase genérica sobre a base | Filtro instantâneo, PF/PJ, seleção em massa, situação, Propostas/Ver dados, Editar, persona |
| `painel` | Frase genérica sobre o painel | Filas, agrupamento, filtros, CSV, SLA, histórico, movimentação individual e em massa |
| `lote` | Upload do Emissoes | Os 4 passos, parâmetros, verificação, cálculo que não grava, criação |
| `individual` | Busca do tomador | Parâmetros, dados da operação, conferência, criação |
| — | — | **Cadastro individual e em lote de tomadores (telas inteiras)** |
| — | — | **Todo o módulo Requisições / Esteira de Aprovação (SoD)** |
| — | — | **Sessão, ambiente, badge, onde reabrir tour e checklist** |

**Resumo:** 6 passos cobrem 5 das 9 telas, nenhuma em profundidade; 4 telas (2 de cadastro + 2 de SoD) não são visitadas.

---

## 4. Limitações da arquitetura atual (o que precisa mudar na Fase 1)

| # | Limitação | Evidência | Impacto |
|---|---|---|---|
| L1 | `PaginaTour` conhece só 5 páginas | `onboarding-roteiro.ts:9-14`, `App.tsx:64-73` | Impossível visitar Cadastro individual/lote e Requisições (e escolher a aba) |
| L2 | Array plano de passos, progresso "N de M" | `ProductTour.tsx:65-68` | Sem capítulos, índice, "pular capítulo" ou entrada direta |
| L3 | Estado é um booleano `tourConcluido` | `db.ts:75`, `onboarding.tsx:87` | Sem retomada de onde parou |
| ~~L4~~ | ~~Teclado quebra a navegação entre rotas~~ **— RETIRADO, não procede** | Verificado no `driver.js.mjs` 1.8: os handlers de `arrowRightPress`/`arrowLeftPress` chamam `onNextClick`/`onPrevClick` antes de cair no `moveNext/movePrevious`. O teclado passa pelo mesmo pipeline do clique | Nenhum. O tour atual navega corretamente por teclado; a Fase 1 só acrescenta uma trava contra avanço duplo durante a preparação assíncrona |
| L5 | Não abre modais/drawers nem prepara dados | `prepararPasso` só faz `navegar` + `esperarVisivel` | Não dá para mostrar a modal de movimentação, o diálogo de propostas do tomador nem o drawer de decisão |
| L6 | Sem tratamento de elemento ausente | `esperarVisivel` resolve por timeout, sem sinal de falha | Passo ancora em nada silenciosamente. **Crítico no cap. 4**: as flags SoD nascem inativas e vários gestos não renderizam; a fila de pendências pode estar vazia |
| L7 | 5 âncoras `data-tour` no código todo | grep | O roteiro expandido exige ~40 âncoras novas (mudança só de marcação) |
| L8 | Checklist fixo e desconectado | `CHECKLIST_ITENS` | Não reflete capítulos |
| L9 | `stagePadding/stageRadius` fixos | `ProductTour.tsx:57-58` | Recorte fica folgado em alvos pequenos (chip, botão de ícone) |

---

## 5. Arquitetura proposta

### 5.1 Roteiro em capítulos
```ts
export interface CapituloTour {
  id: string;            // "dashboard", "tomadores", ...
  titulo: string;        // "Dashboard — a saúde da originação"
  resumo: string;        // uma linha, mostrada no índice
  passos: PassoTour[];
}

export interface PassoTour {
  id: string;
  destino: DestinoTour;          // rota estruturada (substitui PaginaTour)
  seletor?: string;              // data-tour; ausente = card centralizado
  titulo: string;
  texto: string;
  acao?: AcaoTour;               // preparar a tela (abrir modal, selecionar fila)
  requer?: RequisitoTour;        // "flag SoD ativa", "fila não vazia"
  aoFaltar?: "pular" | "centralizar"; // fallback quando o alvo não existe
}

export type DestinoTour =
  | { modulo: "inicio" }
  | { modulo: "clientes"; tela: "situacao" | "individual" | "cadastro" }
  | { modulo: "propostas"; tela: "painel-propostas" | "lote-propostas" | "proposta-individual" }
  | { modulo: "requisicoes"; aba: "pendencias" | "minhas" };
```

### 5.2 Controlador do tour (`lib/tour.tsx`)
Contexto com um **registro de ações de tela**: cada tela registra o que sabe fazer (`registrarAcaoTour("painel.selecionarPrimeiraFila", fn)`, `"tomadores.abrirPropostasDoPrimeiro"`, `"pendencias.abrirPrimeiraRequisicao"`), e o passo apenas declara a ação. O tour **não reimplementa nada** — chama o que a tela já faz, e desfaz no `limpar`. Isso mantém a regra "só UI/onboarding" e evita que o tour toque em lógica de negócio.

### 5.3 Motor (`ProductTour.tsx` reescrito)
- **Um driver por capítulo**, steps montados na entrada do capítulo (já filtrados por `requer`).
- Pipeline único de transição: `navegar(destino) → executar(acao) → esperarElemento(seletor)` — usado por **clique, teclado e entrada direta em capítulo** (corrige L4).
- `allowKeyboardControl: false` + handler próprio de `←/→/Esc` (e `Tab` livre para o foco do popover).
- `esperarElemento` devolve `boolean`; falha aplica `aoFaltar` (pular o passo ou virar card centralizado com texto alternativo) e registra aviso em dev (insumo da Fase 4).
- Rodapé do popover com **"Pular capítulo"** e **"Índice"** via `onPopoverRender`.
- `stagePadding/stageRadius` por passo (padrão atual como default).
- Acessibilidade: `role="dialog"` + `aria-labelledby` que o driver.js já provê; devolver o foco ao elemento de origem ao encerrar; índice navegável por teclado.

### 5.4 Persistência do progresso — **decisão pendente**
| Opção | Como | Prós | Contras |
|---|---|---|---|
| **A (recomendada)** | Capítulo concluído em `checklistItens` com chave reservada `tour:cap:<id>`; posição fina dentro do capítulo em `localStorage` | **Zero migração**; retomada por capítulo vale entre navegadores; o passo exato é descartável | Retomada no passo exato não atravessa máquinas |
| B | Coluna nova `tour_progresso TEXT` em `onboarding_estado` + campo no GET/PUT | Retomada exata, cross-device | Migração no banco (`db.ts`) + shared + zod |
| C | Tudo em `localStorage` | Nenhum toque no backend | Perde progresso ao trocar de navegador; foge do padrão "estado na base, não no browser" (db.ts:69-71) |

**Migração de quem está no meio do tour:** `tourConcluido === true` → todos os capítulos entram como vistos (não reabre o convite; "Refazer" continua disponível por capítulo). Quem nunca fez segue vendo o convite de 1º acesso. Nada quebra em nenhum dos três caminhos.

### 5.5 Checklist "Primeiros passos"
Um item por capítulo (marcado ao concluir o capítulo) + os itens de ação atuais preservados **pelos mesmos ids** (`ver_saude`, `consultar_tomador`, `abrir_painel`, `proposta_individual`, `rodar_lote`), para não zerar progresso de ninguém. Item novo: `decidir_requisicao` ("Revisar uma requisição em Requisições").

---

## 6. Roteiro completo (versão longa — SUPERSEDIDA pela seção 10)

> O PM aprovou o roteiro com corte ("só os mais importantes"). A versão vigente é a
> da **seção 10**; esta fica como banco de textos para passos que quisermos reintroduzir.

Convenções: **[flag]** = passo condicionado a flag SoD ativa; **[dado]** = depende de dado em tela; **[modal]** = o tour abre algo.

### Capítulo 0 — Abertura (2 passos)

**0.1 · Bem-vindo à Esteira de Originação** — *centralizado*
A Esteira automatiza a originação de CCB sobre a Sinqia: cadastro do tomador, proposta, movimentação pelo workflow e governança. Vou percorrer isso em cinco capítulos — você pode fazer tudo em sequência ou entrar direto no que interessa. `←/→` navegam, `Esc` sai a qualquer momento.

**0.2 · Escolha por onde começar** — *centralizado, índice*
Dashboard, Tomadores, Propostas, Esteira de Aprovação e Sessão. Cada capítulo dura cerca de dois minutos e pode ser pulado pelo rodapé. Seu progresso fica salvo — se sair no meio, você volta de onde parou.

---

### Capítulo 1 — Dashboard: a saúde da originação (8 passos)

**1.1 · Quatro camadas, quatro perguntas** — `inicio-cabecalho`
Este é o Início: fluxo, valor, velocidade e conversão. Cada camada responde uma pergunta diferente sobre a operação — onde as propostas estão, quanto originamos, quanto tempo levamos e onde perdemos negócio.

**1.2 · Filtre tudo por convênio** — `inicio-filtro-convenio`
O convênio escolhido governa as quatro camadas de uma vez — números, gráficos e funil. É como acompanhar um originador específico sem montar relatório à parte. O botão ao lado recarrega ignorando o cache.

**1.3 · Fluxo: onde cada proposta está agora** — `inicio-saude`
A camada operacional responde "o que está no fluxo hoje". Ativas, aguardando ação humana, atrasadas acima do SLA e concluídas — em um olhar, sem abrir o Portal.

**1.4 · Atrasadas: o número que exige ação** — `inicio-stat-atrasadas`
Propostas paradas há mais de 72 h na mesma etapa. É o indicador que separa "fila normal" de "proposta esquecida" — e proposta esquecida é prazo de emissão perdido.

**1.5 · Onde está travando** — `inicio-gargalos`
As etapas ordenadas por tamanho de fila, com o ⚠ marcando quantas passaram do SLA. **Clique numa barra e o Painel abre já naquela fila, com o convênio filtrado junto** — do diagnóstico à ação em um clique.

**1.6 · Valor: quanto a esteira originou** — `inicio-valor`
Contratos efetivados no mês, comparação com o mês anterior, ticket médio e mediana. O líquido liberado só existe para o que foi criado aqui — a cobertura fica sempre à vista, para o número nunca ser lido como maior do que é.

**1.7 · Velocidade: onde o tempo é consumido** — `inicio-velocidade`
Tempo de ciclo da criação ao contrato e duração média por etapa. Cuidado com a diferença: "Onde está travando" mostra **fila** (quantas paradas agora); aqui é **duração** (quanto tempo cada etapa consome). As duas juntas dizem se o gargalo é volume ou processo.

**1.8 · Conversão: onde o negócio se perde** — `inicio-funil`
Da persona tomadora ao contrato, com a passagem de cada degrau e a maior perda destacada. É a leitura executiva do funil — e o insumo para decidir onde atacar primeiro.

---

### Capítulo 2 — Tomadores (9 passos)

**2.1 · A base carrega sozinha** — `tomadores-tabela`
Toda a base de tomadores do ambiente, carregada automaticamente ao abrir. Daqui você consulta, edita, altera situação e cadastra novos — sem navegar no Portal.

**2.2 · Busca instantânea, sem ida ao servidor** — `tomadores-filtro`
Digite número, nome ou CPF/CNPJ, com ou sem máscara. O número casa exato; nome e documento casam por parte do texto. O filtro é local — responde enquanto você digita.

**2.3 · PF, PJ ou todos** — `tomadores-tipo-pessoa`
Trocar o tipo recarrega a base já filtrada na Sinqia; depois a busca volta a ser local. Em base grande, é o jeito de reduzir o conjunto antes de trabalhar nele.

**2.4 · Persona tomadora** — `tomadores-persona`
PF entra como tomadora automaticamente; PJ só se você marcar. Essa marcação alimenta o primeiro degrau do funil no dashboard — nem todo cliente da base é, de fato, um tomador.

**2.5 · Selecione os filtrados, não só os visíveis** — `tomadores-selecionar-filtrados`
A tabela desenha até 200 linhas, mas este botão seleciona **todos os resultados do filtro**, inclusive os que não aparecem. É o que torna a alteração em massa viável em base grande.

**2.6 · Alterar situação em massa** — `tomadores-alterar-situacao` **[modal]**
Ativar ou inativar vários tomadores de uma vez, com a lista à vista antes de confirmar. Em produção, a modal só libera depois que você digita ALTERAR — atrito proposital numa ação irreversível.

**2.7 · Propostas do tomador, sem sair da tela** — `tomadores-btn-propostas` **[modal]**
Consulta somente leitura das propostas daquele tomador na Sinqia. Em "Ver dados" você abre os dados completos e o **plano de parcelas** — suficiente para responder ao originador na hora.

**2.8 · Editar completa o que falta** — `tomadores-btn-editar`
Abre o Cadastro individual já preenchido, com a ação `AL` armada. Serve para completar cadastro incompleto sem recriar o tomador — e sem risco de duplicar.

**2.9 · Cadastro individual e em lote** — `tomadores-ctas-cadastro`
Dois caminhos para a mesma rota e a mesma validação: um formulário para casos avulsos, um arquivo para volume. Vamos ver os dois agora.

**2.10 · Campos obrigatórios vêm da Sinqia** — `cadastro-obrigatorios` *(Cadastro individual)*
A ferramenta pergunta à Sinqia o que este ambiente exige (`consultarCamposObrigatorios`) e marca os campos com `*`. O cadastro é aceito incompleto, com avisos — mas completar aqui evita retrabalho no Motor de Crédito.

**2.11 · Controles do cadastro** — `cadastro-controles` *(Cadastro individual)*
`step="FI"` finaliza e envia ao Motor de Crédito; `idAcao` define incluir, alterar ou excluir; `idIntegracaoCadastro` controla a integração. São os parâmetros que o Portal esconde — aqui ficam explícitos e auditáveis.

**2.12 · Exemplos prontos para testar** — `cadastro-exemplos` *(Cadastro individual)*
Exemplo PF e Exemplo PJ preenchem o formulário com dados válidos. Serve para conhecer a tela, treinar alguém ou validar o ambiente sem inventar dados.

**2.13 · Cadastro em lote: o mesmo motor, por arquivo** — `cadastro-lote-upload` *(Cadastro em lote)*
CSV ou JSON, com template para baixar. Mesma rota e mesma validação do individual — o que muda é o volume. Validar antes mostra os erros linha a linha, sem enviar nada.

---

### Capítulo 3 — Propostas (11 passos)

**3.1 · Cada etapa vira uma fila** — `painel-esteira`
O workflow inteiro em uma faixa, com a contagem de cada etapa. Etapas vazias — inclusive as de passagem automática — ficam ocultas, para a tela mostrar só o que existe. Clique numa etapa para abrir a fila dela.

**3.2 · A fila, agrupada por convênio** — `painel-fila`
Dentro da etapa, as propostas vêm agrupadas por convênio, com total e soma de valor por grupo. É a leitura que o originador cobra — e dá para selecionar um convênio inteiro de uma vez.

**3.3 · Filtros da fila** — `painel-filtros`
Número, CPF, convênio, nome e período. Os filtros ficam recolhidos para a tabela ser a protagonista; o contador ao lado mostra quantos estão ativos mesmo com o painel fechado.

**3.4 · SLA por proposta** — `painel-sla`
Há quanto tempo aquela proposta está parada **nesta** etapa: horas até 72 h, dias depois. Acima do SLA ela ganha destaque — é o mesmo número que aparece como "atrasadas" no dashboard.

**3.5 · Histórico sem sair da fila** — `painel-historico`
Expanda a linha e veja as transições da proposta na esteira, com observações. Evita abrir o Portal só para responder "por que essa proposta está aqui?".

**3.6 · Exportar a fila** — `painel-exportar`
Baixa a fila exatamente como está na tela — etapa e filtros aplicados. É o atalho para mandar a posição do dia sem montar planilha à mão.

**3.7 · Mover uma proposta** — `painel-mover-linha` **[flag]**
Move a proposta para a próxima etapa válida do workflow. Os destinos são revalidados na Sinqia no momento da abertura — a ferramenta não oferece caminho que o workflow não aceita.

**3.8 · Mover em lote** — `painel-mover-lote` **[dado]**
Selecione as propostas e mova todas para a mesma etapa de uma vez. **A observação é obrigatória e entra no histórico de todas as propostas movidas** — é a diferença entre um lote rastreável e um lote sem contexto.

**3.9 · Lote de propostas: quatro passos** — `lote-pipeline` *(Lote de propostas)*
Carregar o Emissoes, verificar os clientes, calcular e conferir, criar. O indicador acompanha a fase — e você pode voltar a qualquer passo sem perder o que já fez.

**3.10 · O cálculo não grava nada** — `lote-calculo` *(Lote de propostas)*
O `calcProsp` calcula parcela, CET e IOF **sem gravar na Sinqia** — serve para conferir contra a planilha antes de qualquer coisa se tornar real. Só a criação escreve. **É o passo que mais reduz tempo frente ao Portal manual.**

**3.11 · Parâmetros valem para o arquivo todo** — `lote-parametros` *(Lote de propostas)*
Produto, convênio e loja vêm das listas da Sinqia; taxa e data do contrato você define aqui. Um preenchimento para dezenas de propostas — o ganho de escala do lote.

**3.12 · Proposta individual: o mesmo motor** — `individual-cliente` *(Proposta individual)*
Para casos avulsos: busca o tomador, monta a operação, calcula, confere e cria uma proposta só. Mesmas travas e mesmo cálculo do lote, sem planilha.

**3.13 · Dados da operação** — `individual-operacao` *(Proposta individual)*
O valor líquido é o que o tomador recebe; TAC, seguro e demais encargos são financiados por cima dele. A Sinqia calcula parcela e CET a partir daqui — e a conferência mostra o resultado antes de criar.

---

### Capítulo 4 — Esteira de Aprovação (SoD) (9 passos)

**4.1 · Nada sensível executa direto** — *centralizado*
Somos regulados pelo Banco Central: toda ação com impacto financeiro exige segregação de funções. Com a esteira ativa, cadastrar, criar proposta, mover ou alterar situação **não vai direto à Sinqia** — vira uma requisição que outro operador precisa aprovar.

**4.2 · O aviso na própria tela da ação** — `sod-banner-acao` **[flag]**
Quando a ação está sob aprovação, a tela avisa antes de você submeter: o envio cria uma requisição pendente, não um cadastro. Nenhum operador descobre a governança pela mensagem de erro.

**4.3 · A fila de quem aprova** — `pendencias-fila`
Requisições esperando decisão, da mais antiga para a mais nova, com quem pediu e quando. Os dois chips mostram pendências e falhas ao mesmo tempo — o mesmo número que aparece no badge da navegação.

**4.4 · Filtre por tipo e por criador** — `pendencias-filtros`
Tipo de ação e criador. Em dia cheio, é como o aprovador escolhe o que decidir primeiro sem varrer a lista inteira.

**4.5 · Revisar antes de decidir** — `pendencias-detalhe` **[dado, modal]**
O drawer mostra o payload exato que será executado — dados do tomador, da proposta ou da movimentação. O aprovador confere **mérito**: o formato já passou pelas mesmas validações do fluxo direto.

**4.6 · Quem cria não aprova** — `pendencias-maker-checker` **[dado]**
Se a requisição for sua, os botões ficam desabilitados com a razão à vista. **Não é convenção de tela: o bloqueio está na camada de domínio** — a tentativa é recusada e registrada mesmo que alguém chame a API direto.

**4.7 · Aprovar executa no ato; reprovar exige motivo** — `pendencias-decisao` **[dado]**
Aprovar executa na Sinqia **na sessão de quem aprova**, na hora. Reprovar exige um motivo, que fica visível ao requisitante. Em lotes, dá para marcar exceções — linhas que recebem a direção contrária à decisão do lote, cada uma com o seu motivo.

**4.8 · A trilha responde "quem pediu"** — `pendencias-historico` **[dado]**
A Sinqia registra o aprovador como executor; **quem pediu existe aqui** — requisitante, aprovador, horário, tentativas e a resposta integral da Sinqia. A trilha é append-only: parte do controle, não um log acessório.

**4.9 · Falha não se resolve sozinha** — `pendencias-falhas`
Requisição que falhou na Sinqia fica em repouso, sem retentativa automática. Um aprovador — nunca o requisitante — analisa, reprocessa com o payload original ou descarta com motivo. Nada some silenciosamente.

**4.10 · O que você pediu** — `minhas-requisicoes`
Do lado do requisitante: acompanhe suas requisições, veja o motivo de uma reprovação e cancele o que ainda está pendente. Nenhuma ação sua fica sem desfecho visível.

---

### Capítulo 5 — Sessão e ambiente (4 passos)

**5.1 · Você sabe sempre onde está** — `topbar-ambiente`
O chip mostra o ambiente. Em **PRODUÇÃO** ele fica vermelho — cadastros e propostas são reais e têm efeito financeiro. Em homologação, você pode testar à vontade.

**5.2 · A sessão tem prazo** — `topbar-sessao`
O relógio mostra quanto falta: o menor prazo entre inatividade, teto absoluto e validade do token da Sinqia. Não há renovação automática — antes de um lote longo, vale sair e entrar de novo.

**5.3 · O badge de pendências** — `topbar-badge`
Conta o que **você** pode decidir — requisições de outros operadores e falhas tratáveis. Suas próprias requisições não entram, porque quem cria não aprova.

**5.4 · Para rever qualquer capítulo** — `topbar-tour`
Este botão reabre o tour no índice, e o checklist "Primeiros passos" no canto continua acompanhando o que você já percorreu. Bom trabalho.

---

**Total: 45 passos em 6 capítulos** (0: 2 · 1: 8 · 2: 13 · 3: 13 · 4: 10 · 5: 4).

---

## 7. Funcionalidades encontradas fora do roteiro que você pediu — proposta de inclusão

Incluídas acima (marcadas aqui para decisão explícita):

1. **Persona tomadora** (2.4) — regra PF/PJ que alimenta o funil; explica um número do dashboard que hoje ninguém sabe de onde vem.
2. **Camada Velocidade × "Onde está travando"** (1.7) — a distinção fila × duração é a pergunta mais provável de um stakeholder.
3. **Editar cadastro / ação AL** (2.8) e **Exemplos PF/PJ** (2.12).
4. **Histórico por proposta e exportar CSV da fila** (3.5, 3.6).
5. **Minhas requisições / cancelamento** (4.10) — o lado do requisitante fecha o ciclo do SoD.
6. **Badge de pendências** (5.3) — regra de decidibilidade é conteúdo de governança, não enfeite.

Deixadas **de fora** de propósito (posso incluir se quiser):
- Modo piloto / forçar criação no lote de propostas (operacional demais para demo executiva).
- `idRetorno`, formato do envelope e JSON cru (detalhe de integração).
- Aviso de carga truncada e de registros sem `nrCliente` (estados de exceção).
- Lote **composto** tomador→proposta (US-07): é a funcionalidade mais impressionante da Onda 2, mas depende de flag ativa **e** de um defeito aberto (item 3 do `RELATORIO-HOMOLOG-SOD.md`: `emissoes.ts:201` exige `ID_Sinqia` em toda linha, o que bloqueia o uso real com tomador novo). **Recomendo não demonstrar até o defeito ser corrigido** — posso incluir um passo textual sobre o encadeamento, sem exercitar o fluxo.

---

## 8. Riscos para a demonstração ao vivo

| Risco | Detalhe | Mitigação proposta |
|---|---|---|
| **Flags SoD nascem inativas** | `sod_flags` sem linha = inativa (US-05, RN07); com flag off, os gestos de movimentação e os banners **não renderizam** | Definir com você quais flags ficam ON no ambiente da demo; passos `[flag]` usam `aoFaltar: "centralizar"` com texto alternativo |
| **Fila de pendências vazia** | Sem requisição pendente, os passos 4.5–4.8 não têm o que ancorar | Preparar 2–3 requisições pendentes antes da demo (criadas por outro operador, para o maker-checker aparecer) |
| **Janela da Sinqia** | APIs só respondem em dia útil, horário comercial | Demo e QA da Fase 4 dentro da janela; fora dela, telas sem dado |
| **Dados do dashboard** | Camadas Valor/Velocidade dependem de contratos concluídos no recorte | Verificar o recorte antes; senão os passos ancoram em estado vazio |

---

## 9. Perguntas de checkpoint

1. **Persistência do progresso:** Opção A (sem migração, retomada por capítulo) — confirma?
2. **Branch:** a Onda 2 do SoD (US-06..US-12) **não está em `development`** — vive só em `feature/sod-onda-2`. O capítulo 4 depende dela. Confirma `feature/tour-expandido` a partir de `feature/sod-onda-2`?
3. **Flags na demo:** quais tipos ficam sob aprovação no ambiente da apresentação?
4. **Lote composto (US-07):** entra como passo textual, ou fica fora até o defeito aberto ser corrigido?
5. **Tamanho:** 45 passos, ~12 min no total. Mantém, ou enxugo algum capítulo?

---

## 10. Decisões do checkpoint da Fase 0 (aprovado pelo PM — 2026-08-10)

1. **Persistência: Opção A.** Capítulo concluído em `checklistItens` com chave reservada
   `tour:cap:<id>` (campo já é JSON livre — **sem migração de banco**); posição fina dentro
   do capítulo em `localStorage` (descartável). Migração: `tourConcluido === true` → todos
   os capítulos entram como vistos, com "Refazer" disponível por capítulo.
2. **Branch:** `feature/sod-onda-2` foi mergeada em `development` (merge commit `fbcd946`,
   **local, sem push**) e `feature/tour-expandido` nasceu de `development`.
3. **Flags SoD:** **todas as ações ficam sob aprovação** no ambiente da demonstração. Os
   passos marcados `[flag]` no capítulo 4 renderizam normalmente; o fallback `aoFaltar`
   continua implementado como rede de segurança.
4. **Lote composto (US-07): FORA do tour.** Decisão de produto do PM: a feature composta
   tomador→proposta **não se sustenta** — o tomador sempre precisa existir antes da proposta.
   **Pendência registrada fora do escopo deste trabalho:** voltar ao lote composto para
   retirar a feature (hoje ela também está bloqueada pelo defeito aberto em `emissoes.ts:201`,
   item 3 do `RELATORIO-HOMOLOG-SOD.md`).
5. **Tamanho: enxugado de 45 para 33 passos** (~8 min completos), preservando a cobertura
   mínima pedida no prompt.

### 10.1 Roteiro final — 33 passos em 6 capítulos

Os textos completos de cada passo vivem em `apps/web/src/lib/onboarding-roteiro.ts`
(fonte única). Aqui fica a estrutura aprovada.

| # | Passo | Âncora | Observação |
|---|---|---|---|
| **Cap. 0 — Abertura** | | | |
| 0.1 | Bem-vindo + índice dos capítulos | centralizado | entrada direta em qualquer capítulo |
| **Cap. 1 — Dashboard** (6) | | | |
| 1.1 | Fluxo: a saúde da esteira num olhar | `inicio-saude` | enquadra as quatro camadas |
| 1.2 | Onde está travando | `inicio-gargalos` | ⚠ >72 h; clique abre a fila com o convênio |
| 1.3 | Filtre as quatro camadas por convênio | `inicio-filtro-convenio` | + refresh que ignora cache |
| 1.4 | Valor originado | `inicio-valor` | mês, ticket, cobertura do líquido |
| 1.5 | Velocidade: fila × duração | `inicio-velocidade` | distinção explícita do 1.2 |
| 1.6 | Funil de conversão | `inicio-funil` | maior perda; persona tomadora |
| **Cap. 2 — Tomadores** (8) | | | |
| 2.1 | A base e a busca instantânea | `tomadores-filtro` | nº exato, nome/CPF parcial, com ou sem máscara |
| 2.2 | PF/PJ e "selecionar os N filtrados" | `tomadores-selecao` | seleciona além das 200 linhas visíveis |
| 2.3 | Alterar situação em massa | `tomadores-alterar-situacao` | **[modal]** confirmação digitada em produção |
| 2.4 | Propostas do tomador, sem sair da tela | `tomadores-btn-propostas` | **[modal]** "Ver dados" → parcelas |
| 2.5 | Editar completa o que falta | `tomadores-btn-editar` | ação `AL` |
| 2.6 | Campos obrigatórios vêm da Sinqia | `cadastro-obrigatorios` | `consultarCamposObrigatorios` |
| 2.7 | Controles do cadastro | `cadastro-controles` | `step="FI"`, `idAcao`, `idIntegracaoCadastro`, exemplos PF/PJ |
| 2.8 | Cadastro em lote: mesma rota, por arquivo | `cadastro-lote-upload` | CSV/JSON + template |
| **Cap. 3 — Propostas** (7) | | | |
| 3.1 | Cada etapa vira uma fila | `painel-esteira` | etapas vazias ocultas |
| 3.2 | A fila: convênio, filtros e exportação | `painel-fila` | agrupamento + CSV da fila como está |
| 3.3 | SLA e histórico por proposta | `painel-sla` | horas até 72 h, dias depois |
| 3.4 | Mover: individual e em lote | `painel-mover-lote` | **observação obrigatória no histórico de todas** |
| 3.5 | Lote de propostas: os quatro passos | `lote-pipeline` | carregar → verificar → calcular → criar |
| 3.6 | O cálculo não grava nada | `lote-calculo` | + parâmetros do lote; maior ganho vs. Portal |
| 3.7 | Proposta individual | `individual-cliente` | mesmo motor; dados da operação |
| **Cap. 4 — Esteira de Aprovação (SoD)** (8) | | | |
| 4.1 | Nada sensível executa direto | centralizado | BACEN, segregação de funções |
| 4.2 | O aviso na própria tela da ação | `sod-banner-acao` | submissão cria requisição, não cadastro |
| 4.3 | A fila de quem aprova | `pendencias-fila` | chips Pendentes/Falhas + filtros |
| 4.4 | Revisar antes de decidir | `pendencias-detalhe` | **[modal]** payload exato; mérito, não formato |
| 4.5 | Quem cria não aprova | `pendencias-maker-checker` | bloqueio no domínio, não na UI |
| 4.6 | Aprovar executa no ato; reprovar exige motivo | `pendencias-decisao` | execução na sessão do aprovador |
| 4.7 | A trilha responde "quem pediu" | `pendencias-historico` | append-only; resposta integral da Sinqia |
| 4.8 | Falha não se resolve sozinha | `pendencias-falhas` | retry/descarte por aprovador; cancelamento pelo criador |
| **Cap. 5 — Sessão e ambiente** (3) | | | |
| 5.1 | Você sabe sempre onde está | `topbar-ambiente` | PRODUÇÃO em vermelho |
| 5.2 | Prazo de sessão e badge de pendências | `topbar-sessao` | sem renovação automática; badge = o que você pode decidir |
| 5.3 | Para rever qualquer capítulo | `topbar-tour` | tour + checklist "Primeiros passos" |

**Passos cortados** (textos preservados na seção 6, prontos para reintrodução): persona
tomadora como passo próprio, stat "Atrasadas", cabeçalho das quatro camadas, exemplos PF/PJ
como passo próprio, filtros da fila e exportação como passos próprios, mover individual
separado do lote, parâmetros do lote como passo próprio, dados da operação como passo
próprio, filtros do painel de pendências, "Minhas requisições" como passo próprio.
