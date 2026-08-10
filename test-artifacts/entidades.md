# Entidades criadas em HOMOLOGAÇÃO (BJ21M05) — validação SoD US-01..US-12

> Registro de higiene de dados da validação de 2026-08-10. Tudo criado usa o
> prefixo **`TESTE-SOD-`** no nome. Ambiente: `https://<HOST_HML>`
> (`SINQIA_ENV=hml`, `isProd=false`). **Nada foi criado em produção.**
>
> Os identificadores reais (CPF, nrCliente, nº de proposta) NÃO vão para este
> repositório, que é público: aparecem como placeholders. O mapa completo, para
> a limpeza, está no `test-artifacts/estado.json` da máquina que executou a
> validação (não versionado).

## Convenções usadas

- **Nome:** `TESTE-SOD-<id> GERALDO L B ARAGAO` (dados-base do `EXEMPLO_PF`, já
  validado em HML).
- **CPF:** sintético com DV válido (`cpfSintetico`, sementes `9008100xx`).
- **Propostas:** criadas pela ferramenta entram em 20010 e o motor da Sinqia as
  leva sozinho até **20050 — Contrato em Assinatura** (~1 a 2 min).
- **Movimentações:** observação sempre `TESTE-SOD-<US> ...` (as transições
  exigem observação).

## Tomadores (10)

| id | Nome | CPF | nrCliente | Origem | Situação final | Limpeza sugerida |
|----|------|-----|-----------|--------|----------------|------------------|
| T01 | TESTE-SOD-T01 … | <CPF_T01> | <CLI_T01> | US-01/02/03 (aprovado) | **2 — INATIVO** | já inativado na US-12 |
| T02 | TESTE-SOD-T02 … | <CPF_T02> | <CLI_T02> | US-01/02/03 (reprovado → novo ciclo) | 1 — ATIVO | inativar |
| T03 | TESTE-SOD-T03 … | <CPF_T03> | — | US-01/02/03 (cancelado pelo criador) | não existe na Sinqia | nada a fazer |
| T05 | TESTE-SOD-T05 … | <CPF_T05> | <CLI_T05> | US-05 (cadastro DIRETO, flag inativa) | **2 — INATIVO** | já inativado na US-12 |
| L1a | TESTE-SOD-L1a … | <CPF_L1a> | <CLI_L1a> | US-06 (lote) | **2 — INATIVO** | já inativado na US-12 |
| L1b | TESTE-SOD-L1b … | <CPF_L1b> | — | US-06 (item reprovado por exceção) | não existe na Sinqia | nada a fazer |
| L1c | TESTE-SOD-L1c … | <CPF_L1c> | <CLI_L1c> | US-06 (lote) | 1 — ATIVO (exceção na US-12) | inativar |
| C1 | TESTE-SOD-C1 … | <CPF_C1> | <CLI_C1> | US-07 (lote composto) | 1 — ATIVO | inativar |
| C2 | TESTE-SOD-C2 … | <CPF_C2> | — | US-07 (tomador reprovado por exceção) | não existe na Sinqia | nada a fazer |
| C3 | TESTE-SOD-C3 … | <CPF_C3> | <CLI_C3> | US-07 (lote composto) | 1 — ATIVO | inativar |

Também existem 2 CPFs criados apenas para medir o badge (US-11), cujas
requisições foram **canceladas** antes de executar — portanto **não** existem na
Sinqia: `900.810.052-xx` e `900.810.053-xx`.

## Propostas (7)

| nº | Tomador | Valor | Origem | Etapa final | Observação |
|----|---------|-------|--------|-------------|------------|
| <PROP_P01> | T01 | R$ 10.000 líq. / 12x | US-04 (individual) | 20053 Contrato Finalizado | movida na US-08 (20050→20051) e na variante V2 (20052→20053) |
| <PROP_L1> | C1 | R$ 10.000 líq. / 12x | US-07 (composto) | **20056 Cancelado** | usada na variante V1 (destino Cancelado) |
| <PROP_L2> | C3 | R$ 10.000 líq. / 12x | US-07 (composto) | **20056 Cancelado** | movida por fora na V3 (divergência externa) |
| <PROP_F1> | T02 | R$ 8.000 líq. / 6x | preparação US-09 | 20053 Contrato Finalizado | movida na US-09 (individual) e na aprovação pela UI |
| <PROP_F2> | T05 | R$ 8.000 líq. / 6x | preparação US-09 | 20052 Aprovado p/ Desembolso | item executado do lote da US-09 |
| <PROP_F3> | C1 | R$ 8.000 líq. / 6x | preparação US-09 | **20056 Cancelado** | item reprovado por exceção; depois usada na US-10 |
| <PROP_F4> | C3 | R$ 8.000 líq. / 6x | US-10 (liberação) | 20052 Aprovado p/ Desembolso | ciclo falha → descarte → nova requisição |

## Requisições SoD (37 na base local)

| tipo | executada | falha | reprovada | cancelada | descartada |
|------|-----------|-------|-----------|-----------|------------|
| tomador.cadastrar | 3 | — | 1 | 7 | — |
| tomador.cadastrar_lote | 1 | — | — | 2 | — |
| proposta.criar | 5 | 1 | — | — | — |
| proposta.criar_lote | 1 | — | — | — | — |
| proposta.movimentar | 5 | — | — | 2 | 3 |
| proposta.movimentar_massa | 1 | — | — | — | — |
| situacao_tomador | 2 | — | — | 2 | — |
| situacao_tomador_lote | 1 | — | — | — | — |

Itens de lote: 16 (executados 8, reprovados 5, cancelados 3).
Trilha de auditoria: **199 eventos** (85 transições, 37 criações, 34 execuções
iniciadas, 24 mudanças de flag, 19 tentativas rejeitadas).

A única requisição que **permanece em `falha`** é a de `proposta.criar`
`719dfc7a-…` (duplicidade na Sinqia, provocada de propósito na US-04 e usada
como insumo do retry da US-10). Ela mantém o badge de B em 1.

## Estado do ambiente ao final

| Item | Antes | Durante | Depois |
|------|-------|---------|--------|
| Flags `aprovacao.*` (8) | todas inativas (nunca alteradas) | todas ATIVAS | **todas inativas de novo** (estado de go-live) |
| Base local SQLite | 1 requisição terminal, 0 flags, 2 eventos | — | 37 requisições, 8 flags, 199 eventos |
| Backup da base | — | — | cópia pré-validação no scratchpad da sessão |
