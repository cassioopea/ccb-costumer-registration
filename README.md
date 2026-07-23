# Cadastro em Lote de Clientes — API Sinqia (BJ21M05)

Aplicação web **local** (roda na sua máquina, atrás da VPN da Opea) para cadastrar
tomadores de CCB em lote na API da Sinqia. Front separado do back-office, mesmo
design system (tema azul), monorepo com backend + frontend.

> ⚠️ **Requer a VPN da Opea ativa.** Sem VPN, o login na Sinqia falha.

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

> ⚠️ Em produção os cadastros são **reais**. Confirme o host real de produção da
> Sinqia com a Sinqia/BRQ antes (o `.env.prod` traz um palpite a validar).

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
npm run env:prod    # aponta para PROD (confirmar host real com Sinqia/BRQ)
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

## Fluxo de uso

1. **Credenciais** — usuário e senha da Sinqia (trafegam só na sessão).
2. **Arquivo** — arraste um `.csv` ou `.json` (ou baixe o `template.csv`).
3. **Validar (dry-run)** — faz login (confirma credencial+VPN), parseia, valida
   os campos e monta os payloads **sem cadastrar**. Mostra erros por linha.
4. **Executar lote** — só habilita após validar sem erros. Roda o lote com barra
   de progresso em tempo real (SSE) e tabela de resultados.
5. **Exportar CSV** — relatório com status, HTTP, status do envelope e mensagens
   de consistência de cada linha.

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
- `idAcao` (`IN`/`AL`/`EX`/`CO`) nos arrays; para cadastro novo use `IN`.

---

## Estrutura

```
cadastroClientes/
├── packages/shared/     # schemas zod (cliente, request, envelope) + analyzeEnvelope
├── apps/api/            # Fastify + TS (login, lote, SSE, template, relatório)
├── apps/web/            # Vite + React 19 + Tailwind v4 + shadcn (new-york)
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

- Senha digitada na tela, mantida só em memória durante o processamento, descartada
  ao fim do lote. Nunca vai para código, `.env`, log ou disco.
- Logs do backend redigem `Authorization` e não registram corpos de requisição.
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
