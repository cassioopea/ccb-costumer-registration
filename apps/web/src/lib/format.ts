/** Formatação canônica de valores — fonte única (não usar toLocaleString inline). */

const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

/** null → "—" (placeholder honesto, nunca R$ 0,00 fake). */
export function formatBRL(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  return brl.format(v);
}

/** Int AAAAMMDD → "dd/mm/aaaa"; null → "—". */
export function formatDataAAAAMMDD(v: number | null | undefined): string {
  if (!v) return "—";
  const s = String(v);
  if (s.length !== 8) return s;
  return `${s.slice(6, 8)}/${s.slice(4, 6)}/${s.slice(0, 4)}`;
}

/** "12345678901" → "123.456.789-01" (só para exibição). */
export function formatCpf(cpf: string): string {
  if (cpf.length !== 11) return cpf || "—";
  return `${cpf.slice(0, 3)}.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-${cpf.slice(9)}`;
}
