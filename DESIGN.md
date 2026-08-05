# DESIGN.md — Esteira de Originação (Opea)

Direção estética do produto. **Toda sessão futura (humana ou do Claude Code) herda
estas decisões** — mudanças aqui exigem justificativa, não gosto pessoal.

## Contexto

Ferramenta interna de trabalho da Opea SCD para originação de CCB (clientes +
propostas em lote na Sinqia). Usuários: analistas de crédito e operações. O tom é
**fintech B2B de alto padrão**: confiança bancária (Mercury), densidade e precisão
(Linear), clareza em dados financeiros (Ramp). Extraímos princípios, não copiamos.

## Fonte única de tokens

Tudo vive em `apps/web/src/index.css` (`@theme` + `:root`/`.dark`). **Nenhum
componente usa cor, tamanho de fonte ou sombra fora dos tokens.** `text-[13px]`,
`#3D0727` no JSX ou `p-[13px]` são bugs, não estilo.

### Cor

- **Marca**: escala `--wine-50…900`, calibrada no IBK. `--primary` = wine-800
  (`#3D0727`, o bordô oficial). Header/sidebar = wine-900.
- **Hover de ação primária**: `--primary-hover` (wine-700) — hover SEMPRE muda a
  cor, nunca `opacity` (opacity lava a marca).
- **Neutros**: cinzas com temperatura leve (matiz ~60 nas superfícies), nunca o
  `gray` puro do Tailwind.
- **Semânticas** (`--success`, `--warning`, `--destructive`, `--info`): só para
  ESTADO (criada, divergente, erro, pendente). Nunca decoração. `--warning-foreground`
  é escuro de propósito — textos de divergência assentam sobre fundo claro.
- **Painel de processo** (`--panel`): o azul-marinho do Backoffice Opea, reservado
  à superfície que destaca a operação em andamento (ResumoOperacao). Dentro dele
  aplica-se a classe `.panel-dark`, que re-mapeia os tokens locais (texto branco,
  CTA primário invertido em branco, cores de estado clareadas para AA) — os
  componentes filhos não mudam, só o contexto.
- Um único accent por tela. Cores de gráfico só via `--chart-*`.

### Tipografia

- Fonte: Degular (fallback Inter/system-ui). Fora do repo (licença comercial) —
  arquivos em `apps/web/public/fonts/`, ver README.
- Escala semântica fechada — **use estas classes, nunca `text-sm`/`text-xs`/`text-[Npx]`**:
  `text-display` (h1 de página) · `text-title` · `text-heading` (título de card/dialog)
  · `text-subheading` · `text-body` (padrão, inclusive tabelas) · `text-label`
  (cabeçalho de tabela, rótulos) · `text-caption` (metadados) · `text-code` (JSON/payloads).
- Headings têm tracking levemente negativo (embutido nos tokens).
- **`tabular-nums` é OBRIGATÓRIO em qualquer número que muda ou se compara**:
  valores monetários, taxas, CET, prazos, CPF/CNPJ, nº de proposta, contadores de
  progresso. Contador sem tabular-nums "pula" durante o streaming — é bug visual.
- CPF/CNPJ e documentos usam Degular + `tabular-nums` (não `font-mono`; mono é só
  para blocos de código/JSON).

### Profundidade

- 1px de borda em neutro sutil (`border-border`) define os planos.
- Sombra só em ELEMENTO FLUTUANTE (dialog, popover, header sticky): `shadow-elevated`.
- Cards estáticos: `shadow-card` (quase imperceptível) ou nada. `shadow-lg`/`shadow-xl`
  em card estático é proibido.

### Espaçamento e raio

- Grid de 4px. `gap-3`, `p-6`, `py-2` — nunca valor arbitrário.
- Raio base `--radius` (10px); cards `rounded-2xl`, controles `rounded-md`.
- Largura do shell: `max-w-shell` (token `--container-shell`).

### Movimento

- Transições de 150–200ms (`duration-150`/`duration-200`), só em hover/focus/expansão.
- `prefers-reduced-motion` é respeitado globalmente (regra em `@layer base`) — inclusive
  em `scrollIntoView` (checar `matchMedia` antes de `behavior: "smooth"`).
- Animação decorativa é proibida. Loading usa `Skeleton` com a forma do conteúdo;
  spinner (`Loader2`) só em botão de ação em andamento.

## Acessibilidade (piso, não teto)

- Foco visível em TUDO. Componentes `ui/` já têm ring; controle custom (chip,
  link-botão, dropzone) recebe a classe `.focus-ring`.
- Formulário 100% navegável por teclado; labels sempre associados (`htmlFor`).
- Contraste AA. Estado nunca é transmitido só por cor (badge tem texto).
- Controle interativo não mora dentro de `DialogDescription` — descrição é descrição.

## Voz do sistema (microcopy pt-BR)

- Botões dizem exatamente o que fazem: "Calcular selecionadas", "Criar 1 proposta
  (piloto)", "Exportar pendências (12)". Nunca "Enviar", "OK", "Confirmar" soltos.
- Erros dizem o que aconteceu e como resolver; sem desculpas, sem vagueza.
- Números honestos: valor ausente é "—", nunca "R$ 0,00" fake (ver `lib/format.ts`,
  fonte única de formatação — proibido `toLocaleString` inline).
- Vocabulário consistente ponta a ponta: linha, lote, proposta, divergência,
  pendência, adotar (nrClient).

## Proibições explícitas

- Gradientes chamativos; animação decorativa.
- Emojis e caracteres soltos ("✓", "→") na UI — ícone do lucide-react, com significado.
- Ícone decorativo em título de card (o título carrega a hierarquia; ícone só quando
  carrega estado/significado).
- O roxo/azul default do shadcn; qualquer cor fora dos tokens.
- `shadow-lg`+ em superfície estática; mais de um accent por tela.
- Affordance mentirosa (chevron que não abre nada, cursor-pointer sem ação).

## Componentes canônicos (replicar, não reinventar)

- `ui/` — button, input, select (nativo, de propósito), table (com `scroll` para
  grades longas + thead aderente), badge (variantes semânticas incl. `warning`),
  card, dialog, progress, skeleton.
- `RateInput` — taxa com sufixo (% a.m.), alinhada à direita, tabular-nums.
- `PipelineSteps` — indicador passivo de etapas do fluxo (não é wizard).
- `ResumoOperacao` — painel vivo sticky, na superfície azul do Backoffice
  (`bg-panel` + `.panel-dark`), que consolida o que está sendo criado (linhas,
  somas, parâmetros, status) + o CTA da fase atual. Elemento assinatura das
  telas de originação.

## Arquitetura de tela (originação)

Página única com pipeline vertical + indicador de etapas + resumo vivo sticky.
**Não usar wizard** para fluxos de lote: o operador volta o tempo todo (adotar
nrClient, refiltrar, recalcular) e o peso da tela são as grades, não os campos.
Validação de campo em **blur** (touched), nunca a cada tecla; o bloqueio do CTA
continua imediato.
