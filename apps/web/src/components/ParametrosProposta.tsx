import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import { CARACTERISTICAS_PROPOSTA } from "@cadastro-lote/shared";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { RateInput } from "@/components/ui/rate-input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * Parâmetros de uma proposta (fora do Excel) — compartilhados pelo lote e
 * pela proposta individual: taxa, característica, produto, convênio, loja e
 * data do contrato, com os selects populados pelos lookups da Sinqia.
 */

export interface ParamsLote {
  txJuros: string;
  cdProd: string;
  idCarCtr: string;
  cdConven: string;
  cdLoja: string;
  /** ISO yyyy-mm-dd (input date); convertida para AAAAMMDD no envio. */
  dtContra: string;
}

const hojeIso = new Date().toISOString().slice(0, 10);

export const PARAMS_DEFAULT: ParamsLote = {
  txJuros: "12",
  cdProd: "1015",
  idCarCtr: "31",
  cdConven: "111",
  cdLoja: "111",
  dtContra: hojeIso,
};

/** Validação inline: numéricos obrigatórios; data obrigatória; Loja pode ficar vazia. */
export function paramInvalido(campo: keyof ParamsLote, valor: string): string | null {
  if (!valor.trim()) {
    // Loja (filial) é opcional — a proposta pode ir sem cdLoja.
    return campo === "cdLoja" ? null : "Obrigatório.";
  }
  if (campo === "dtContra") {
    return /^\d{4}-\d{2}-\d{2}$/.test(valor) ? null : "Data inválida.";
  }
  if (campo !== "cdConven" && !/^\d+([.,]\d+)?$/.test(valor.trim())) return "Somente números.";
  return null;
}

/** Erros de todos os parâmetros — usado para bloquear o CTA. */
export function paramsErros(params: ParamsLote) {
  return (Object.keys(params) as Array<keyof ParamsLote>)
    .map((k) => ({ campo: k, erro: paramInvalido(k, params[k]) }))
    .filter((p) => p.erro !== null);
}

interface Opcao {
  codigo: number;
  descricao: string;
}

export interface LookupsParametros {
  produtos: Opcao[];
  convenios: Opcao[];
  filiais: Opcao[];
}

/**
 * Campo de parâmetro como texto livre. Valida em BLUR (touched) — não grita
 * erro enquanto o operador ainda digita; o bloqueio do CTA continua imediato.
 */
export function ParamInput({
  campo,
  label,
  params,
  setParams,
  onBlur,
  aviso,
  sufixo,
  type,
}: {
  campo: keyof ParamsLote;
  label: string;
  params: ParamsLote;
  setParams: React.Dispatch<React.SetStateAction<ParamsLote>>;
  onBlur?: () => void;
  /** Aviso não-bloqueante (ex.: característica sem produtos na Sinqia). */
  aviso?: string;
  /** Sufixo de unidade dentro do campo (ex.: "% a.m.") — vira RateInput. */
  sufixo?: string;
  /** Tipo do input nativo (ex.: "date"). */
  type?: string;
}) {
  const [tocado, setTocado] = useState(false);
  const erro = paramInvalido(campo, params[campo]);
  const mostraErro = tocado ? erro : null;

  const comuns = {
    id: `param-${campo}`,
    value: params[campo],
    type,
    "aria-invalid": mostraErro ? true : undefined,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
      setParams((p) => ({ ...p, [campo]: e.target.value })),
    onBlur: () => {
      setTocado(true);
      onBlur?.();
    },
    className: cn(
      "tabular-nums",
      mostraErro && "border-destructive",
      !mostraErro && aviso && "border-warning",
    ),
  };

  return (
    <div className="space-y-1">
      <Label htmlFor={`param-${campo}`} className="text-caption">
        {label}
      </Label>
      {sufixo ? (
        <RateInput sufixo={sufixo} {...comuns} />
      ) : (
        <Input inputMode={type ? undefined : "decimal"} {...comuns} />
      )}
      {mostraErro && <p className="text-caption text-destructive">{mostraErro}</p>}
      {!mostraErro && aviso && (
        <p className="flex items-start gap-1 text-caption text-warning-foreground">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-warning" />
          {aviso}
        </p>
      )}
    </div>
  );
}

/**
 * Campo de parâmetro como SELECT populado pela Sinqia.
 * Sem opções carregadas (lookup indisponível), degrada para texto livre —
 * a ferramenta nunca fica travada por causa de uma lista.
 */
export function ParamSelect({
  campo,
  label,
  params,
  setParams,
  options,
  onChangeValue,
  aviso,
  permitirManual = false,
  permitirVazio = false,
  rotuloVazio = "Nenhuma",
  carregando = false,
}: {
  campo: keyof ParamsLote;
  label: string;
  params: ParamsLote;
  setParams: React.Dispatch<React.SetStateAction<ParamsLote>>;
  options: Opcao[];
  onChangeValue?: (novo: string) => void;
  /** Aviso não-bloqueante exibido sob o campo (ex.: característica sem produtos). */
  aviso?: string;
  /** Permite alternar para digitação manual (lookup pode não trazer o código). */
  permitirManual?: boolean;
  /** Inclui a opção vazia — o parâmetro é opcional. */
  permitirVazio?: boolean;
  /** Nome da opção vazia no vocabulário do operador (ex.: "Sem loja"). */
  rotuloVazio?: string;
  /** true enquanto as listas da Sinqia carregam — mostra skeleton, não input. */
  carregando?: boolean;
}) {
  /** Modo manual: o operador digita o código que a lista não trouxe. */
  const [manual, setManual] = useState(false);

  if (carregando && options.length === 0 && !manual) {
    return (
      <div className="space-y-1">
        <Label htmlFor={`param-${campo}`} className="text-caption">
          {label}
        </Label>
        <Skeleton className="h-9 w-full" />
      </div>
    );
  }

  if (options.length === 0 || manual) {
    return (
      <div className="space-y-1">
        <ParamInput campo={campo} label={label} params={params} setParams={setParams} aviso={aviso} />
        {manual && options.length > 0 && (
          <button
            type="button"
            onClick={() => setManual(false)}
            className="focus-ring text-caption text-primary underline-offset-2 hover:underline"
          >
            ← escolher da lista
          </button>
        )}
      </div>
    );
  }

  const atual = params[campo];
  const atualNaLista =
    options.some((o) => String(o.codigo) === atual) || (permitirVazio && atual === "");

  return (
    <div className="space-y-1">
      <Label htmlFor={`param-${campo}`} className="text-caption">
        {label}
      </Label>
      <Select
        id={`param-${campo}`}
        value={atual}
        onChange={(e) => {
          const novo = e.target.value;
          setParams((p) => ({ ...p, [campo]: novo }));
          onChangeValue?.(novo);
        }}
        className={cn("tabular-nums", aviso && "border-warning")}
      >
        {permitirVazio && <option value="">{rotuloVazio}</option>}
        {!atualNaLista && (
          <option value={atual}>{atual} — (valor atual, fora da lista)</option>
        )}
        {options.map((o) => (
          <option key={o.codigo} value={String(o.codigo)}>
            {o.codigo} — {o.descricao}
          </option>
        ))}
      </Select>
      {permitirManual && (
        <button
          type="button"
          onClick={() => setManual(true)}
          title="Use quando a lista da Sinqia não trouxer o código que você precisa"
          className="focus-ring text-caption text-primary underline-offset-2 hover:underline"
        >
          digitar código manualmente
        </button>
      )}
      {aviso && (
        <p className="flex items-start gap-1 text-caption text-warning-foreground">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-warning" />
          {aviso}
        </p>
      )}
    </div>
  );
}

/**
 * Grade completa dos 6 parâmetros da proposta — o MESMO formulário nas telas
 * de lote e individual (trocar a característica/convênio recarrega as listas).
 */
export function CamposParametros({
  params,
  setParams,
  lookups,
  carregando,
  onTrocaCaracteristica,
  onTrocaConvenio,
}: {
  params: ParamsLote;
  setParams: React.Dispatch<React.SetStateAction<ParamsLote>>;
  lookups: LookupsParametros | null;
  carregando: boolean;
  onTrocaCaracteristica: (novo: string) => void;
  onTrocaConvenio: (novo: string) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {/* Taxa de juros — campo financeiro com sufixo de unidade. */}
      <ParamInput
        campo="txJuros"
        label="Taxa de juros"
        sufixo="% a.m."
        params={params}
        setParams={setParams}
      />
      {/* Característica — domínio FIXO documentado no swagger (Principal.idCarctr).
          Trocar recarrega os produtos dela; sem produtos = aviso. */}
      <ParamSelect
        campo="idCarCtr"
        label="Característica"
        params={params}
        setParams={setParams}
        options={CARACTERISTICAS_PROPOSTA.map((c) => ({
          codigo: c.codigo,
          descricao: c.label,
        }))}
        onChangeValue={onTrocaCaracteristica}
        aviso={
          lookups && lookups.produtos.length === 0
            ? "Nenhum produto para esta característica/convênio neste ambiente."
            : undefined
        }
      />
      <ParamSelect
        campo="cdProd"
        label="Produto (cdProd)"
        params={params}
        setParams={setParams}
        options={lookups?.produtos ?? []}
        permitirManual
        carregando={carregando}
      />
      <ParamSelect
        campo="cdConven"
        label="Convênio (cdConven)"
        params={params}
        setParams={setParams}
        options={lookups?.convenios ?? []}
        onChangeValue={onTrocaConvenio}
        permitirManual
        carregando={carregando}
      />
      <ParamSelect
        campo="cdLoja"
        label="Loja (filial do convênio)"
        params={params}
        setParams={setParams}
        options={lookups?.filiais ?? []}
        permitirManual
        permitirVazio
        rotuloVazio="Sem loja"
        carregando={carregando}
      />
      <ParamInput
        campo="dtContra"
        label="Data do contrato"
        type="date"
        params={params}
        setParams={setParams}
      />
    </div>
  );
}
