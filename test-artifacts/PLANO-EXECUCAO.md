# Plano de execução — validação de integração em homologação (SoD US-01..US-12)

**Checkpoint A.** Ambiente confirmado, smoke de conectividade verde, matriz
instanciada com dados reais. Aguardando OK do PM para executar a seção 3.

---

## 1. Confirmação de ambiente (obrigatória antes de qualquer chamada)

| Verificação | Resultado |
|---|---|
| `GET /api/health` | `{"ok":true,"env":"hml","baseUrl":"https://<HOST_HML>"}` |
| `GET /api/env` | `env=hml`, `isProd=false` |
| `apps/api/.env` | idêntico a `.env.hml`; `SINQIA_ENV=hml`; base URL ≠ base de `.env.prod` |
| `apps/web/.env` | idêntico a `.env.hml`; `VITE_SINQIA_ENV=hml` |
| Paths Sinqia | todos sob **`/BJ21M05/...`** |
| `.env.test` | existe na raiz, com as 4 variáveis preenchidas, e está no `.gitignore` |
| Janela Sinqia | segunda-feira 2026-08-10, ~09:00 (horário comercial) — aberta |

**Guarda automática:** `00-smoke.mjs` aborta com exit 2 se `env≠hml`,
`isProd≠false` ou se o host não contiver `hml` — antes de qualquer login.

## 2. Smoke de conectividade (executado)

| Item | Resultado |
|---|---|
| Login operador A (`SINQIA_HOMOLOG_USER_A`) | HTTP 200, token JWT |
| Login operador B (`SINQIA_HOMOLOG_USER_B`) | HTTP 200, token JWT |
| Identidades distintas (maker-checker viável) | SIM |
| `GET /api/session` nas duas jars de cookie | 200 / 200 |

Evidência: `test-artifacts/evidencias/00-smoke-ambiente.json`.

**Segurança:** as credenciais são lidas de `.env.test` e usadas apenas no corpo
do `POST /api/login` local. Toda saída (log e evidência) passa por redação: os
logins viram `<OPERADOR_A>` / `<OPERADOR_B>`; senhas nunca são impressas nem
gravadas. Nenhum valor aparece em arquivo, relatório ou terminal.

## 3. Feature flags (executado)

As 8 flags `aprovacao.*` foram ATIVADAS em `hml` pelo CLI auditado
(`npm run sod:flag -- <tipo> on --por <OPERADOR_A>`); 8 eventos
`flag_alterada` na trilha. `GET /api/env` passou a devolver `true` **sem
restart** do servidor (prova da leitura em runtime, RN da US-05).

## 4. Higiene de dados

- Prefixo `TESTE-SOD-` em todo nome criado; CPFs sintéticos com DV válido.
- Registro em `test-artifacts/entidades.md` (preenchido durante a execução).
- Backup da base local SQLite feito antes de qualquer mutação (scratchpad da
  sessão). Estado inicial: 1 requisição terminal (`cancelada`), 0 flags — ou
  seja, contagens de badge praticamente determinísticas.
- Nada roda em produção.

## 5. Dados reais colhidos para instanciar a matriz (somente leitura)

| Insumo | Valor |
|---|---|
| Produtos | 1015 CDC Price Pré, 1023 CDC SAC Pré, 10359 CDC Pós IGPM, 10367 CDC Pós IPCA |
| Convênios | 1 Shelf, 111 OPEA SCD, 666 OPEA SCD |
| Filiais | nenhuma retornada (proposta sem `cdLoja`) |
| Parâmetros de proposta | `txJuros=12`, `cdProd=1015`, `idCarCtr=31`, `cdConven=111`, `dtContra=hoje` (defaults da tela) |
| Fila de origem das movimentações | **20050 Contrato em Assinatura** (452 propostas em HML) |
| Transições válidas de 20050 | → 20051 Contrato Assinado (**exige observação**); → 20056 Cancelado (exige observação) |
| Campos obrigatórios do cadastro | 40 caminhos (`dsNome`, `nrCpfCnpj`, `dadosPf.*`, `dadosProfissionais.*`, `refPessoais`, `conjuge.*`, `cdPess`) — cobertos pelo `EXEMPLO_PF` |

Evidências: `01-recon.json`, `02-recon-painel.json`.

## 6. Matriz instanciada (ordem de execução)

Legenda: **A** = operador requisitante, **B** = operador aprovador.
Em cada tipo, a violação de SoD é testada (A tenta decidir o que A criou).

### US-01/02/03 — Tomador individual
| # | Cenário | Dados | Como | Evidência esperada |
|---|---|---|---|---|
| 1.1 | Criar requisição | `TESTE-SOD-T01` CPF sintético #1 | A → `POST /api/cadastrar` (flag ON) | 201 `aprovacao:true`, requisição `pendente`, zero Sinqia |
| 1.2 | Validação antes da requisição | mesmo payload com `dsNome` vazio | A → `POST /api/cadastrar` | `valido:false` + erros, nenhuma requisição criada |
| 1.3 | Duplicidade pendente (RN02) | repetir T01 | A → `POST /api/cadastrar` | 409 `DUPLICIDADE_PENDENTE` + `requisicaoExistente` |
| 1.4 | **Violação de SoD** | requisição de 1.1 | A → `POST /api/sod/requisicoes/:id/decisao {aprovar}` | 403 `VIOLACAO_SOD`, estado intacto, tentativa auditada |
| 1.5 | Aprovar + executar (B2') | requisição de 1.1 | B → decisão `aprovar` | `executada`, resposta Sinqia integral anexada, auditoria `execucao_iniciada`+conclusão |
| 1.6 | Tomador visível na Sinqia | CPF de T01 | `GET /api/clientes/:cpf/propostas` + `/api/clientes` | tomador encontrado (nrClient) |
| 1.7 | Reprovação com motivo + novo ciclo | `TESTE-SOD-T02` CPF #2 | A cria → B `reprovar` (motivo) → A recria → B aprova | `reprovada` (motivo na trilha, zero Sinqia) e depois `executada` |
| 1.8 | Cancelamento pelo criador | `TESTE-SOD-T03` CPF #3 | A cria → A `cancelar`; e B tenta cancelar (deve negar) | `cancelada`; tentativa de B → 403 `CANCELAMENTO_NEGADO` |

### US-04 — Proposta individual
| # | Cenário | Dados | Como |
|---|---|---|---|
| 4.1 | Cálculo do requisitante (pré-requisito) | CPF T01, `vlLiquido=10.000`, 12 parcelas, 1º vcto = 1º dia útil do mês seguinte | A → `POST /api/propostas/calcular-uma` |
| 4.2 | Criar requisição | `calcId` de 4.1 + params (1015/31/111) | A → `POST /api/propostas/criar-uma` → 201 pendente |
| 4.3 | Violação de SoD | — | A tenta aprovar → 403 |
| 4.4 | Aprovar + cálculo OFICIAL na execução | — | B aprova → `executada` com parcelas/CET/IOF do recálculo + `divergenciasReferencia` |
| 4.5 | Proposta no painel | nº devolvido | `POST /api/propostas/painel` filtrando o nº → etapa 20050 |
| 4.6 | Falha real (se viável) | proposta duplicada (mesma assinatura, `forcarDuplicada:false`) | espera-se `falha` com `causa` distinguível — **só se não houver efeito colateral indesejado** |

### US-05 — Flags e corte
| # | Cenário | Como |
|---|---|---|
| 5.1 | Flag ATIVA → rota direta não executa | `POST /api/cadastrar` e `POST /api/propostas/criar-uma` devolvem requisição (201) e **zero** chamada Sinqia |
| 5.2 | Corte na UI | tela de Tomador individual com flag ON: CTA de aprovação, sem gesto de cadastro direto |
| 5.3 | Flag INATIVA → fluxo direto intacto | `sod:flag -- tomador.cadastrar off` → A cadastra `TESTE-SOD-T05` **direto na Sinqia** (não-regressão) → flag ON de volta |
| 5.4 | Mudança de flag auditada | `GET /api/sod/auditoria` mostra `flag_alterada` com ator e antes/depois |
| 5.5 | Guard centralizado (`ACAO_SOB_APROVACAO`) | coberto pela suíte mockada `us05-flags` (a corrida não é reproduzível em HML) — reportado como tal |

### US-06 — Lote de tomadores (3 itens)
| # | Cenário | Como |
|---|---|---|
| 6.1 | Criar lote | CSV com `TESTE-SOD-L1a/L1b/L1c` (CPFs #6..#8) → A → `POST /api/import` (multipart) → 201 lote pendente |
| 6.2 | Violação de SoD | A tenta decidir → 403 |
| 6.3 | Decisão bidirecional "aprovar exceto 1" | B → `aprovar` + exceção reprovando `L1b` (motivo obrigatório) |
| 6.4 | Execução sequencial + placar | polling do detalhe: 2 `executada`, 1 `reprovada`; `placar` coerente; item reprovado com motivo na trilha |
| 6.5 | Duplicidade tridimensional (RN06) | tentar individual pendente com CPF de `L1a` → bloqueio recíproco |

### US-07 — Lote de propostas + composto (3+3)
| # | Cenário | Como |
|---|---|---|
| 7.1 | Criar lote composto | Emissões CSV com 3 linhas (`TESTE-SOD-C1..C3`) + CSV de 3 tomadores novos (CPFs #9..#11) → A → `POST /api/propostas/criar` |
| 7.2 | Encadeamento e vínculo | detalhe mostra 3 itens `tomador.cadastrar` + 3 `proposta.criar` com `dependeDeItemId` |
| 7.3 | Propagação de exceção + aviso de impacto | B reprova o tomador de C2 → a proposta vinculada cai `reprovada` por `propagacao`; aviso de impacto conferido na UI **antes** da confirmação |
| 7.4 | Conferência na execução (RN02) | itens aprovados: cálculo oficial + conferência contra a planilha (1 centavo) |
| 7.5 | Placar por tipo | `placarPorTipo` distingue tomadores × propostas |

### US-08 — Movimentação individual (⚠️ bug reportado)
| # | Cenário | Como |
|---|---|---|
| 8.1 | Criar requisição | proposta da US-04, `20050 → 20051`, observação `TESTE-SOD-US08` → A → `POST /api/propostas-transferir` → 201 pendente |
| 8.2 | Indicador no painel | `GET /api/sod/movimentacoes-ativas` + chip na UI do Painel de Propostas |
| 8.3 | Bloqueio de 2ª requisição (RN03) | A repete → 409 `MOVIMENTACAO_BLOQUEADA` com `requisicaoExistente` |
| 8.4 | Violação de SoD | A tenta aprovar → 403 |
| 8.5 | **Aprovar → executar** | B aprova → esperado `executada` + `transfStatus` na Sinqia |
| 8.6 | Etapa refletida | histórico da proposta mostra 20051; painel atualizado |
| **8.B** | **Investigação do bug** | reproduzir com payload, estado antes/depois, resposta do BFF, presença/ausência de chamada à Sinqia, logs e auditoria → diagnóstico de causa raiz → **PROPOSTA de correção e PARADA** (sem corrigir) |

Hipóteses a testar em 8.B (ordem de custo): (i) conferência de etapa atual pelo
histórico elegendo o registro errado (`maior nrSeq` ≠ vigente) ou comparando
tipos diferentes → `falha` por `divergencia_externa`; (ii) transição 20050→20051
exigir **ocorrência** (`incluirOcorrencia`, ocorrências 10/11) além do
`transfStatus`, como o Portal faz → rejeição da Sinqia; (iii) payload/`request`
persistido incompleto; (iv) ausência de executor/registro para o tipo.

### US-09 — Movimentação em massa (2–3 propostas)
| # | Cenário | Como |
|---|---|---|
| 9.1 | Elegibilidade (RN04) | selecionar 3 propostas da fila 20050, uma delas já bloqueada pela US-08 → 409 `SUBCONJUNTO_NAO_CONFIRMADO` |
| 9.2 | Lote-subconjunto confirmado | repetir com `confirmarSubconjunto:true` → 201 |
| 9.3 | Violação de SoD + decisão bidirecional | A tenta decidir → 403; B aprova com 1 exceção reprovada |
| 9.4 | Execução + bloqueio unificado | itens executam; individual sobre proposta de item ativo → 409 (fonte única) |

### US-10 — Retry e descarte
| # | Cenário | Como |
|---|---|---|
| 10.1 | Falha real | usar a falha produzida na US-08/09 (ou provocar divergência externa movendo a proposta por fora) |
| 10.2 | Retry vedado ao requisitante | A → `POST .../retry` → 403 |
| 10.3 | Retry por B | B → `POST .../retry` → nova tentativa com o payload original imutável; histórico numerado |
| 10.4 | Descarte com motivo libera bloqueio | B → `POST .../descarte {motivo}` → `descartada`; nova requisição de movimentação da mesma proposta passa a ser aceita |

### US-11 — Badge
| # | Cenário | Como |
|---|---|---|
| 11.1 | Contagem por operador | `GET /api/sod/pendencias-badge` para A e B no cenário misto (próprias fora da conta; lote = 1) |
| 11.2 | Atualização pós-decisão | medir antes/depois de cada decisão (delta), inclusive falhas tratáveis |
| 11.3 | Badge na UI | topbar com o contador e atualização após decisão |

### US-12 — Situação de tomador
| # | Cenário | Como |
|---|---|---|
| 12.1 | Individual, ciclo completo | inativar `TESTE-SOD-T05` (cdSituacao 2) → A cria, B aprova, execução real |
| 12.2 | Aviso de impacto | inativar o tomador T01 (**com proposta em andamento**) → aviso ANTES da confirmação; conferir se existe consulta de impacto pré-decisão ou só registro pós-execução |
| 12.3 | Massa pequena | 2 tomadores do lote da US-06 → lote `situacao_tomador_lote`, decisão bidirecional, execução |
| 12.4 | Violação de SoD | A tenta aprovar → 403 |

## 7. Achados já registrados antes da execução (pré-existentes, fora da matriz)

1. **`us10-retry.test.ts` está quebrado e fora do `npm test`** — escrito contra
   APIs que não existem (`abrirBancoSod()` sem caminho, 2º parâmetro de
   `criarSodServico`, hook falso de sessão, tabelas `sod_itens_lote` /
   `sod_workflow_historico` no lugar de `sod_lote_itens`), com `@ts-nocheck` no
   topo. Resultado: **US-10 não tem cobertura automatizada** (7 testes,
   0 passando quando executado isoladamente). Suíte oficial: 152/152 verdes.
2. **`npm run typecheck` falha** — 4 erros em `us12-situacao.test.ts`, incluindo
   `alterarSituacaoClienteFn` que não existe em `RegisterRoutesDeps` (o teste
   injeta uma dependência que a rota ignora).
3. **`/api/env` não expõe as flags de situação** (`situacao_tomador*`) — a UI não
   tem como saber que o tipo está sob aprovação. A confirmar no cenário 12.
4. Comentário incorreto em `execucao.ts:561` (“cdSituacao = 7”): 7 não é código
   válido de situação; o código real usa `cdSituacao !== 1`.

Os itens 1 e 2 são de qualidade de entrega (não bloqueiam a validação em HML) e
entram no relatório final; 3 e 4 serão confirmados na execução da matriz.

## 8. O que já se sabe que ficará BLOQUEADO/limitado

- **Corridas de concorrência** (duas decisões simultâneas, criação simultânea da
  mesma movimentação): não são reproduzíveis com confiabilidade em HML por HTTP;
  ficam cobertas pela suíte mockada e reportadas como tal.
- **Guard `ACAO_SOB_APROVACAO`**: inalcançável em operação normal (o desvio vem
  antes) — evidência mockada.
- **Testes de frontend**: não existe infra no repo (registrado desde a US-02); a
  verificação de UI é manual/observada no navegador.
