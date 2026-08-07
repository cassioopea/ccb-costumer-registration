import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Search } from "lucide-react";
import { cn } from "@/lib/utils";

export interface OpcaoCombobox {
  value: string;
  label: string;
}

/**
 * Select do design system — substitui o <select> nativo, cujo painel de
 * opções é do sistema operacional e não aceita a identidade Opea (fonte,
 * cores, espaçamento). Com muitas opções, ganha pesquisa embutida
 * (automática acima de 8 itens, ou forçada via `pesquisavel`).
 *
 * Acessível: listbox com teclado (setas/Enter/Escape), fecha ao clicar fora.
 */
export function Combobox({
  value,
  onChange,
  options,
  placeholder = "Selecione…",
  pesquisavel,
  disabled = false,
  className,
  triggerClassName,
  id,
  "aria-label": ariaLabel,
}: {
  value: string;
  onChange: (novo: string) => void;
  options: OpcaoCombobox[];
  placeholder?: string;
  /** Força a caixa de pesquisa (default: automática acima de 8 opções). */
  pesquisavel?: boolean;
  disabled?: boolean;
  className?: string;
  /** Classes extras do BOTÃO (ex.: borda de aviso/erro). */
  triggerClassName?: string;
  id?: string;
  "aria-label"?: string;
}) {
  const [aberto, setAberto] = useState(false);
  const [busca, setBusca] = useState("");
  const [destacado, setDestacado] = useState(0);
  const raiz = useRef<HTMLDivElement>(null);
  const listaRef = useRef<HTMLUListElement>(null);

  const comPesquisa = pesquisavel ?? options.length > 8;

  const filtradas = useMemo(() => {
    const q = busca.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.label.toLowerCase().includes(q));
  }, [options, busca]);

  // Abriu: destaca a opção atual e zera a busca.
  useEffect(() => {
    if (!aberto) return;
    setBusca("");
    const atual = options.findIndex((o) => o.value === value);
    setDestacado(atual >= 0 ? atual : 0);
  }, [aberto]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fecha ao clicar fora.
  useEffect(() => {
    if (!aberto) return;
    const fora = (e: MouseEvent) => {
      if (raiz.current && !raiz.current.contains(e.target as Node)) setAberto(false);
    };
    document.addEventListener("mousedown", fora);
    return () => document.removeEventListener("mousedown", fora);
  }, [aberto]);

  // Mantém a opção destacada à vista ao navegar pelo teclado.
  useEffect(() => {
    listaRef.current
      ?.querySelector(`[data-indice="${destacado}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [destacado]);

  const selecionada = options.find((o) => o.value === value);

  const escolher = (v: string) => {
    onChange(v);
    setAberto(false);
  };

  const aoTeclar = (e: React.KeyboardEvent) => {
    if (!aberto) {
      if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        setAberto(true);
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      setAberto(false);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setDestacado((d) => Math.min(d + 1, filtradas.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setDestacado((d) => Math.max(d - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const alvo = filtradas[destacado];
      if (alvo) escolher(alvo.value);
    }
  };

  return (
    <div ref={raiz} className={cn("relative", className)} onKeyDown={aoTeclar}>
      <button
        type="button"
        id={id}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={aberto}
        aria-label={ariaLabel}
        onClick={() => setAberto((v) => !v)}
        className={cn(
          "focus-ring flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-background px-3 text-body transition-colors duration-150 hover:border-primary/40 disabled:cursor-not-allowed disabled:opacity-50",
          triggerClassName,
        )}
      >
        <span
          className={cn(
            "truncate text-left tabular-nums",
            !selecionada && "text-muted-foreground",
          )}
        >
          {selecionada?.label ?? placeholder}
        </span>
        <ChevronDown
          className={cn(
            "h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-150",
            aberto && "rotate-180",
          )}
        />
      </button>

      {aberto && (
        <div className="absolute z-50 mt-1 w-full min-w-52 overflow-hidden rounded-lg border border-border bg-popover shadow-elevated">
          {comPesquisa && (
            <div className="relative border-b border-border p-2">
              <Search className="pointer-events-none absolute left-4 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                // eslint-disable-next-line jsx-a11y/no-autofocus -- o painel acabou de abrir a pedido
                autoFocus
                value={busca}
                onChange={(e) => {
                  setBusca(e.target.value);
                  setDestacado(0);
                }}
                placeholder="Pesquisar…"
                aria-label="Pesquisar opções"
                className="h-8 w-full rounded-md bg-muted/60 pl-8 pr-2 text-body outline-none placeholder:text-muted-foreground"
              />
            </div>
          )}
          <ul ref={listaRef} role="listbox" className="max-h-64 overflow-y-auto p-1">
            {filtradas.length === 0 && (
              <li className="px-3 py-2 text-caption text-muted-foreground">
                Nada encontrado para “{busca}”.
              </li>
            )}
            {filtradas.map((o, i) => (
              <li key={o.value || "(vazio)"} role="option" aria-selected={o.value === value}>
                <button
                  type="button"
                  data-indice={i}
                  onClick={() => escolher(o.value)}
                  onMouseEnter={() => setDestacado(i)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-body tabular-nums transition-colors duration-150",
                    i === destacado && "bg-accent text-accent-foreground",
                    o.value === value && "font-medium",
                  )}
                >
                  <span className="flex-1 truncate">{o.label}</span>
                  {o.value === value && <Check className="h-4 w-4 shrink-0 text-primary" />}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
