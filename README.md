# Esteira de Originação — API Sinqia (BJ21M05)

Aplicação web **local** (roda na sua máquina, atrás da VPN da Opea) para originar
CCBs na Sinqia, em dois módulos:

- **Clientes** — cadastro individual e em lote, consulta e alteração de situação;
- **Propostas** — criação de propostas de crédito em lote a partir do
  `Emissoes.xlsx` (Fase 1: leitura/seleção; cálculo e criação nas Fases 2–3).

Front separado do back-office, mesmo design system (tema azul), monorepo com
backend + frontend.

> ⚠️ **Requer a VPN da Opea ativa.** Sem VPN, o login na Sinqia falha.

## Módulo Propostas (Esteira) — estado atual

Fluxo da API (gravado do Portal de Crédito): `calcProsp` → `primeiro-vencimento`
→ `cadastrarProposta`.

**Fase 1 entregue:** upload do `Emissoes.xlsx`, normalização (CPF com zeros à
esquerda, datas → AAAAMMDD, `ID_Sinqia "333-6"` → `nrClient` 3336 — dígitos
concatenados; quantidade de parcelas ausente = 1 com aviso), grade com seleção
por linha, filtro por Situação (canceladas desmarcadas por padrão) e parâmetros
do lote (`txJuros`, `cdProd`, `idCarCtr`, `cdConven`, `cdLoja`, data do contrato).

**Fase 2 entregue e validada em HML (linhas reais fechando no centavo):** botão
*Calcular selecionadas* roda o `calcProsp` linha a linha (sequencial, SSE, retry
leve, 401 aborta) e **confere** o calculado contra o Excel — parcela, financiado
e líquido, tolerância de R$ 0,01 (comparação em centavos inteiros). Resultado por
linha: OK / Divergência / Erro / Não enviado, com revisão expandível
(divergências campo a campo + o request exato enviado) e export CSV. **Nada é
criado na Sinqia** — o cálculo é só cálculo; a criação é a Fase 3. O bloco
`calculo` completo (com as prestações) fica retido no backend por linha, pronto
para montar o `cadastrarProposta` sem recalcular.

Semântica financeira (confirmada empiricamente): o request leva
`vlContra` = **Líquido** do Excel; a Sinqia financia TAC/Seguro/Outros
(`tpPg*="F"`) por cima e devolve `vlContra` = Financiado. A **data do contrato**
que reproduz a planilha é 1 mês antes do 1º vencimento — a UI sugere esse valor
automaticamente ao carregar o arquivo (editável).

**Verificação de clientes + relatório de pendências:** o botão *Verificar
clientes* consulta a Sinqia (somente leitura, `buscarCliente` por CPF — o
parâmetro chama `nrClient` mas recebe o CPF; resposta em XML) e marca cada
linha: ✓ encontrado (nrClient bate), *difere* (existe com outro nrClient — o
autoritativo é o da Sinqia) ou *não cadastrado* (bloqueia a criação). O botão
*Exportar pendências* gera um CSV consolidado com tudo que impede linhas de
virarem proposta — problemas de planilha, cliente não encontrado/divergente e
divergências/erros de cálculo — para quem corrige a planilha. A criação
(Fase 3) usará **apenas as linhas OK**; divergentes ficam de fora.

> ℹ️ A HML da Sinqia é **desligada fora do horário comercial** — um 502 à noite
> não é defeito da ferramenta.

> Quirk mapeado: a resposta do calcProsp usa `txAm`/`txCetAm`/`vlIof`/`prestacoes`
> (e `dtVctPre` com P maiúsculo); o cadastrarProposta usa `txFinmes`/`txCetMes`/
> `vlIofCob`/`parcelas` (`dtVctpre` minúsculo). O mapeamento é feito na Fase 3.

> 🔒 **LGPD:** `exemplos/Emissoes.xlsx` e `exemplos/payloads_proposta_referencia.json`
> contêm **dados reais** e são gitignored — ficam só na máquina do operador.

---

## Pré-requisitos

- **Node.js LTS** (>= 20; testado em Node 26).
- **VPN da Opea** conectada.
- Credenciais da Sinqia (usuário/senha) — **digitadas na tela**, nunca no código.

## Instalação

```bash
npm install            # instala tudo (workspaces: shared, api, web)
```

## Como rodar (2 terminais)

```bash
# Terminal 1 — backend (porta 3333)
npm run dev:api

# Terminal 2 — frontend (porta 5173)
npm run dev:web
```

Abra **http://localhost:5173**. O front faz proxy de `/api` para o backend.

---

## Rodar em PRODUÇÃO (na sua máquina, atrás da VPN)

Esta é uma ferramenta **local**: "produção" significa apontar para o ambiente de
**produção da Sinqia** e rodar os artefatos de build (não o dev server). Continua
rodando na sua máquina, atrás da VPN da Opea — não é um deploy em servidor.

> ⚠️ Em produção os cadastros são **reais**. Garanta que `SINQIA_BASE_URL` no seu
> `apps/api/.env.prod` é o host de produção correto (mesmo padrão do host de HML,
> com o prefixo de produção) antes de executar qualquer lote.

### 1. Selecionar o ambiente de produção

```bash
cd apps/api && npm run env:prod && cd ../..
cd apps/web && npm run env:prod && cd ../..
```

Isso copia `.env.prod` → `.env` nos dois apps: o backend passa a usar
`SINQIA_BASE_URL` de produção e a UI mostra o badge **PRODUÇÃO** (vermelho) e exige
confirmação extra antes de executar o lote.

### 2. Build do front

```bash
npm run build --workspace @cadastro-lote/web    # gera apps/web/dist (front estático)
# (ou `npm run build` na raiz para também rodar o typecheck de shared/api)
```

O backend roda direto do TypeScript via `tsx` (não precisa de build) — é uma
ferramenta local, sem etapa de compilação para servidor.

### 3. Subir os dois processos

```bash
# Terminal 1 — backend em produção (porta 3333, lê apps/api/.env)
npm run start --workspace @cadastro-lote/api

# Terminal 2 — front estático servido pelo Vite preview (porta 5173)
npm run preview --workspace @cadastro-lote/web
```

Abra **http://localhost:5173**. O `vite preview` faz o mesmo proxy de `/api` para o
backend (sem CORS), igual ao dev.

### 4. Conferir antes de cadastrar
- O header deve mostrar o badge **PRODUÇÃO** (vermelho).
- Rode **Validar (dry-run)** primeiro; só então **Executar** (que pede confirmação
  extra em produção).

### Voltar para HML
```bash
cd apps/api && npm run env:hml && cd ../..
cd apps/web && npm run env:hml && cd ../..
```

> Observação: por ser local, não há PM2/systemd/Nginx. Se quiser deixar rodando,
> mantenha os dois terminais abertos (ou use um gerenciador de processos de sua
> preferência apontando para `tsx apps/api/src/server.ts` e `vite preview`).

---

## Ambientes (HML × Produção)

A URL da Sinqia **nunca** é hardcoded — vem de variáveis de ambiente.

### Backend (`apps/api`)
Arquivos: `.env.example` (versionado), `.env.hml` / `.env.prod` (gitignored).
Trocar de ambiente copia o arquivo correto para `.env`:

```bash
cd apps/api
npm run env:hml     # aponta para HML
npm run env:prod    # aponta para PROD
# Os hosts da Sinqia não são versionados — preencha SINQIA_BASE_URL nos seus
# .env.hml / .env.prod locais (peça à Sinqia/BRQ ou consulte a wiki interna).
```

Variáveis (ver `apps/api/.env.example`):

| Variável | Descrição |
|---|---|
| `SINQIA_ENV` | `hml` ou `prod` — rótulo/aviso. |
| `SINQIA_BASE_URL` | URL base da Sinqia (troca de ambiente aqui). |
| `SINQIA_LOGIN_PATH` | `/BJ21M05/user` |
| `SINQIA_CADASTRO_PATH` | `/BJ21M05/BJ21M05/BJ21SS0501F/cadastrarCliente` |
| `SINQIA_CLIENTES_PATH` | Listagem de clientes. Default `/BJ21M05/v1/cliente` — **prefixo não confirmado**. |
| `SINQIA_SITUACAO_PATH` | Alteração de situação. Default `/BJ21M05/situacao/alterar-situacao-cliente` — **prefixo não confirmado**. |
| `PORT` | Porta do backend (3333). |
| `WEB_ORIGIN` | Origem do front no CORS. |
| `REQUEST_TIMEOUT_MS` / `RETRY_COUNT` | Timeout e retry por chamada. |

> As env são validadas com zod no boot. Se faltar `SINQIA_BASE_URL`, o servidor
> falha rápido com mensagem clara.
> **Nunca** coloque usuário/senha da Sinqia em env.

### Frontend (`apps/web`)
Arquivos: `.env.example`, `.env.hml` / `.env.prod` (gitignored).

```bash
cd apps/web
npm run env:hml
npm run env:prod
```

| Variável | Descrição |
|---|---|
| `VITE_API_URL` | URL do backend local. |
| `VITE_SINQIA_ENV` | `hml`/`prod` — badge de ambiente na UI. |

A UI exibe um **badge de ambiente**: azul “HML” ou vermelho pulsante “Produção”.
Em produção, executar o lote exige **confirmação extra** num diálogo.

---

## Login e sessão

A aplicação abre numa **tela de login**. Você entra **uma vez** com usuário e
senha da Sinqia; a partir daí as duas telas usam a mesma sessão — a senha não é
pedida de novo.

### Como funciona

- O backend faz o login na Sinqia, guarda o **token** em memória e devolve um
  cookie `sid` **httpOnly** (invisível ao JavaScript da página).
- **A senha nunca é guardada** — é usada para obter o token e descartada. Nem em
  memória, nem em disco, nem em log.
- O cookie sobrevive ao **F5**: recarregar a página não pede login de novo.
- Reiniciar o backend apaga todas as sessões.

Cookie e não header porque `EventSource` não permite headers customizados, e as
duas telas usam SSE para o progresso dos lotes.

### Validade

O header do sistema mostra o usuário e quanto tempo resta. A sessão morre no
**primeiro** destes prazos:

| Prazo | Valor |
|---|---|
| Inatividade | 30 min (qualquer requisição renova) |
| Teto absoluto | 8 h |
| Expiração do token da Sinqia | depende do token — ver abaixo |

### Quanto tempo o token da Sinqia fica ativo?

Depende do formato, e o sistema detecta qual é:

- **JWT** — dá para saber exatamente: o backend decodifica a claim `exp` (ler
  claims não exige o segredo; só validar a assinatura exigiria). O TTL aparece no
  log do backend no login (`token jwt, TTL 1800s (~30 min)`) e no tooltip do
  contador no header.
- **Opaco** — não há como deduzir. O log diz `validade não informada pelo token`
  e a UI diz o mesmo em vez de fingir precisão. Para saber o valor real, perguntar
  à Sinqia/BRQ.

Em nenhum caso o token vai para o log — só o formato e o TTL.

### Quando a sessão expira

**Não há renovação automática**: a API Sinqia não tem refresh token, e como não
guardamos a senha, não é possível relogar sozinho. Em vez de derrubar a tela, o
sistema abre um **modal pedindo só a senha** (o usuário já é conhecido) e você
continua de onde parou — arquivo selecionado, base de clientes carregada e
seleção acumulada permanecem intactos.

Se a sessão expirar **no meio de um lote**, o job para e as linhas ainda não
tentadas ficam com status **`NÃO ENVIADO`** — não `ERRO`, porque não foram
recusadas por ninguém. O relatório mostra exatamente o que refazer. Quando restam
menos de 5 minutos de sessão, as duas telas avisam antes de você iniciar um lote
longo.

## Telas

Depois do login, duas telas alternadas pelas abas abaixo do header:

1. **Cadastro em Lote** — importa tomadores a partir de CSV/JSON (fluxo abaixo).
2. **Situação de Clientes** — lista os clientes já cadastrados e altera a
   situação de um ou vários (ver seção própria).

## Fluxo de uso (Cadastro em Lote)

1. **Arquivo** — arraste um `.csv` ou `.json` (ou baixe o `template.csv`).
2. **Validar (dry-run)** — parseia, valida os campos e monta os payloads **sem
   cadastrar**. Mostra erros por linha.
3. **Executar lote** — só habilita após validar sem erros. Roda o lote com barra
   de progresso em tempo real (SSE) e tabela de resultados.
4. **Exportar CSV** — relatório com status, HTTP, status do envelope e mensagens
   de consistência de cada linha.

### Controles do lote (tela)

Ficam no card **Arquivo do lote** e valem para **todas** as linhas:

| Controle | Default | O que faz |
|---|---|---|
| **Ação do lote** (`idAcao`) | *Do arquivo* | Força `IN`/`AL`/`EX`/`CO` em todas as linhas. |
| `idIntegracaoCadastro` | **`S`** | `S` integra automaticamente com o módulo de cadastro; `N` não integra. |
| `idRetConsistencias` | vazio | Flag de retorno das mensagens de consistência. |
| Finalizar (`step="FI"`) | desmarcado | Finaliza e envia ao Motor de Crédito. |

#### Ação do lote (`idAcao`)

- **Do arquivo (padrão)** — nada é injetado: cada linha usa o `idAcao` que vier
  do CSV/JSON e a Sinqia assume inclusão. É o comportamento validado em HML.
- **`IN` / `AL` / `EX` / `CO`** — a ação é **autoritativa**: sobrescreve o que
  estiver no arquivo e é aplicada em `idAcaoCliente`, `idAcaoEndereco` e no
  `idAcao` de `bensImoveis`, `bensMoveis`, `cartoesCredito`, `dadosBancarios`,
  `enderecos`, `socios` e `dadosPj`.
- `dadosPf` e `dadosProfissionais` **não** recebem `idAcao` de propósito — o
  payload PF validado em HML não envia esse campo neles.

> ⚠️ **`EX` exclui cadastros.** A tela pede confirmação digitada (`EXCLUIR`) em
> **qualquer** ambiente, não só em produção, e não há desfazer pela ferramenta.

> ⚠️ Só `IN` foi exercitado ponta a ponta contra a API real (HML). `AL`, `EX` e
> `CO` seguem o enum do modelo Sinqia, mas o comportamento do endpoint
> `cadastrarCliente` para essas ações **ainda não foi confirmado** — teste em
> HML, com poucas linhas, antes de usar em produção.

### O que acontece no lote
- Login **uma vez**; o token (header `Auth`) é reusado no lote inteiro.
- Processamento **sequencial**; continua em caso de erro.
- **HTTP 401 no meio** → relogin automático + reenvio da linha 1x.
- **Sucesso/falha por linha** é decidido pela análise do envelope de resposta
  (`status`, `globalMessage`, `messages[]`), **não** só pelo HTTP 200.
  `status: "OK"` = registro salvo (confirmado em HML).

### Linhas inválidas são puladas (não bloqueiam o lote)
- O **Validar** aponta as linhas com erro. Na **execução**, essas linhas ficam com
  status **`PULADO`** e **não são enviadas** à Sinqia — só as válidas são cadastradas.
- A execução só é bloqueada se **nenhuma** linha for válida.
- Cada linha no relatório tem status **`OK`** (cadastrada), **`ERRO`** (recusada pela
  Sinqia) ou **`PULADO`** (reprovada na validação, não enviada).

### Arquivo de exemplo com erros
Para testar o fluxo "identifica erros → executa só os OK", gere um lote de exemplo:

```bash
node scripts/gerar-lote-exemplo.mjs
```

Cria `exemplos/tomadores-ccb-exemplo.csv` com **70 tomadores fake** (mix PF/PJ), sendo
**12 com erros injetados** de propósito (documento inválido, bloco PF/PJ trocado, tipo
errado, enums fora do domínio). No dry-run, as 12 são reprovadas e 58 seguem válidas.

---

## Situação de Clientes

Segunda tela. Busca os clientes já cadastrados e altera a situação — de um em
um ou em lote.

### Fluxo

1. **Carregar clientes** — o backend varre **todas** as páginas de
   `GET /v1/cliente` com o token da sessão e devolve a base inteira.
2. **Filtrar** — busca **local** por número do cliente, nome ou CPF/CNPJ.
3. **Selecionar** — checkbox por linha, ou "Selecionar os N filtrados".
4. **Nova situação** — escolha o `cdSituacao` alvo.
5. **Alterar** — `POST /situacao/alterar-situacao-cliente` por cliente, sequencial,
   com barra de progresso (SSE) e retry leve em 5xx. Em produção pede confirmação
   extra.
6. **Exportar CSV** — relatório com situação anterior, nova, status e mensagens.

### Por que carregar tudo em vez de buscar no servidor

A busca é local de propósito. A base tem muito mais clientes do que cabe numa
página (o `size` da API vai até 200), então filtrar só o que está carregado não
encontraria quem está na página 30. Carregar tudo uma vez e filtrar em memória
acha qualquer cliente, e o filtro fica instantâneo.

O parâmetro `search` da API **não é usado** — o campo saiu da tela e o valor fica
no default. A paginação também não aparece mais: o backend percorre as páginas
sozinho.

Limites da carga (em `apps/api/src/sinqia-client.ts`): 200 registros por
requisição, teto de 20.000 registros e 200 páginas. Se bater no teto, a tela
avisa que a lista **pode estar incompleta** — nesse caso use o filtro de tipo de
pessoa, que é aplicado no servidor, para reduzir o conjunto.

### Seleção acumulativa

A seleção vive fora da lista exibida: **filtrar, recarregar ou trocar o tipo de
pessoa não desmarca nada**. Dá para buscar "Silva", marcar alguns, buscar um CPF,
marcar mais, e alterar todos de uma vez. O painel "N selecionado(s)" lista tudo
que está marcado e permite remover item a item.

O botão "Selecionar os N filtrados" marca **todos** os resultados do filtro,
inclusive os que não estão sendo exibidos — a tabela renderiza no máximo 200
linhas por vez para não travar o navegador.

### Códigos de situação (`cdSituacao`)

`1` ATIVO · `2` INATIVO · `3` BLOQUEADO JUDICIALMENTE · `4` BLOQUEADO INSTITUIÇÃO ·
`5` PROVISÓRIO · `10` EM PREENCHIMENTO · `11` EM ANÁLISE · `12` APROVADO ·
`13` CANCELADO · `14` DEVOLVIDO PARA REGULARIZAÇÃO · `15` AGUARDANDO DOCUMENTAÇÃO ·
`98` INATIVO · `99` CANCELADO

A tabela tem rótulos repetidos (2/98 INATIVO, 13/99 CANCELADO) — por isso a UI
sempre mostra o código junto do rótulo. Códigos fora da tabela são reprovados
antes de sair da ferramenta.

### `nrCliente`, não CPF

O `POST` usa `nrCliente` (número de cadastro na Sinqia), **não** o CPF/CNPJ. Ele
vem da listagem; linhas que não trouxerem esse campo aparecem com a seleção
desabilitada e um aviso.

> ⚠️ **Contrato ainda não confirmado.** Os nomes de campo da resposta de
> `GET /v1/cliente` e o prefixo das duas rotas não foram exercitados contra a API
> real. O backend normaliza as formas plausíveis (página Spring `content`,
> array cru, wrappers `data`/`clientes`) e cada linha da tabela pode ser expandida
> para ver o **JSON bruto** que a Sinqia devolveu. Se a listagem vier vazia ou sem
> `nrCliente`, use o JSON bruto para ajustar `normalizeClienteItem`
> (`packages/shared/src/situacao.schema.ts`); se der 404, ajuste
> `SINQIA_CLIENTES_PATH`/`SINQIA_SITUACAO_PATH` no `.env`.

## Formatos de arquivo

### JSON
Aceita as duas variações (normalizadas automaticamente):

```jsonc
// (a) array de objetos cliente
[ { "dsNome": "...", "nrCpfCnpj": "15032465070", ... } ]

// (b) array com wrapper cliente
[ { "cliente": { "dsNome": "...", "nrCpfCnpj": "15032465070", ... } } ]
```

### CSV
Colunas achatadas. O backend remonta o objeto `{ cliente: {...} }`:

- campo raiz: `dsNome`, `nrCpfCnpj`, `sgEstado`, …
- objeto aninhado (ponto): `dadosPf.dtNasc`, `dadosProfissionais.vlRendaBruta`
- array (índice): `bensImoveis[0].nmImovel`, `dadosBancarios[0].nrConta`

Baixe o **template.csv** pela UI (traz 1 linha PF + 1 PJ de exemplo) ou em
`GET /api/template.csv`.

### Detecção PF/PJ e tipos
- **11 dígitos** em `nrCpfCnpj` → PF (usa `dadosPf`); **14** → PJ (usa `dadosPj`).
- Datas são inteiros `AAAAMMDD` (ex.: `20090416`). Documento sem máscara.
- Alguns "códigos numéricos" trafegam como **string** e não são convertidos:
  `nrCpfCnpj`, `nrCep`, `nrConta`, `dvConta`, `nrDoc`, `nrEnd`, `idUniao`, `tpImovel`.
- `idAcao` (`IN`/`AL`/`EX`/`CO`) nos arrays; para cadastro novo use `IN`. Dá para
  forçar uma ação para o lote inteiro pela tela — ver **Ação do lote** abaixo.

---

## Estrutura

```
cadastroClientes/
├── packages/shared/     # schemas zod (cliente, request, envelope, situação) + analyzeEnvelope
├── apps/api/            # Fastify + TS (login, lote, situação, SSE, template, relatório)
├── apps/web/            # Vite + React 19 + Tailwind v4 + shadcn (new-york) — 2 telas
└── scripts/use-env.mjs  # troca .env.hml/.env.prod → .env
```

## Testes / verificação

```bash
npm run typecheck                          # typecheck de todos os workspaces
npm run smoke --workspace @cadastro-lote/api   # smoke test offline (sem VPN)
```

O smoke test valida parsing/coerção CSV, detecção PF/PJ, enums, refino PF/PJ,
montagem do request e `analyzeEnvelope` — tudo sem chamar a API real.

> Os testes de `/api/validate` e `/api/import` end-to-end exigem VPN + credencial
> real. Use sempre o **dry-run** e o ambiente **HML** ao testar.

## Segurança

- Senha digitada na tela de login, usada só para obter o token da Sinqia e
  **descartada em seguida**. Não é guardada nem em memória — é por isso que não
  existe renovação automática de token. Nunca vai para código, `.env`, log ou disco.
- A sessão guarda em memória apenas `{ id, usuário, token }`. O **token nunca vai
  para o browser**: o front recebe um cookie `sid` httpOnly, que o JavaScript da
  página não consegue ler.
- Sessão expira por inatividade (30 min), teto absoluto (8 h) ou expiração do
  token — o que vier primeiro. Reiniciar o backend apaga todas.
- Um job de lote só pode ser acompanhado pela sessão que o iniciou.
- Logs do backend redigem `Authorization` e não registram corpos de requisição.
  No login registram só o **formato** e o **TTL** do token, nunca o token.
- `.env`, `.env.hml`, `.env.prod` estão no `.gitignore`; só os `.env.example` são versionados.
- O backend escuta **somente em `127.0.0.1`** e não tem autenticação própria — ele
  repassa credenciais à Sinqia. **Nunca** exponha em `0.0.0.0`, rede ou deploy
  público; é uma ferramenta estritamente local (1 operador por máquina).
- O parser de CSV rejeita cabeçalhos perigosos (`__proto__` etc.) e índices de
  array absurdos; o relatório exportado neutraliza fórmulas (`=`, `+`, `-`, `@`)
  contra CSV injection no Excel.
- Resultados de lote (contêm nome/CPF) ficam só em memória e apenas os últimos
  10 jobs são retidos; reiniciou o backend, apagou tudo.

## Fonte Degular (licenciada — não versionada)

A Degular é fonte **comercial** licenciada pela Opea e os `.ttf` **não vão para o
repositório**. Após clonar, copie os arquivos para `apps/web/public/fonts/`:

```
DegularText-Regular.ttf · DegularText-Semibold.ttf · DegularText-Bold.ttf
```

(Peça ao time de design/marketing da Opea.) Sem eles a UI funciona normalmente
com a fonte de fallback (Inter/system-ui).

## Antes de publicar o repositório (checklist)

1. `git status` — confirme que **nenhum** `.env`, `.env.hml`, `.env.prod` ou `.ttf`
   aparece para commit (o `.gitignore` já cobre; verifique mesmo assim).
2. Nenhuma credencial da Sinqia em código, docs ou histórico de commits.
3. Os hosts reais da Sinqia ficam **fora** do repo (placeholders no `.env.example`).
4. `exemplos/tomadores-ccb-exemplo.csv` contém **somente dados fictícios** gerados
   por script (nomes/documentos sintéticos). Nunca commite arquivos com tomadores
   reais — trate qualquer CSV/relatório real como dado pessoal (LGPD).
