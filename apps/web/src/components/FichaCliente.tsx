import { situacaoLabel } from "@cadastro-lote/shared";
import { formatDataAAAAMMDD } from "@/lib/format";

/**
 * Ficha do cliente em linguagem de gente — substitui o JSON cru da linha
 * expandida: rótulo completo do campo + valor formatado, no mesmo estilo do
 * histórico das propostas. O JSON bruto continua disponível num toggle.
 */

const ROTULOS: Record<string, string> = {
  nrCliente: "Número do cliente",
  nmCliente: "Nome",
  dsNome: "Nome",
  nrCpfCnpj: "CPF/CNPJ",
  tpPessoa: "Tipo de pessoa",
  cdSituacao: "Situação",
  dsSituacao: "Situação",
  nrCep: "CEP",
  dsEnd: "Endereço",
  nmEnd: "Endereço",
  nrEnd: "Número",
  dsCompl: "Complemento",
  nmBairro: "Bairro",
  dsBairro: "Bairro",
  nmCidade: "Cidade",
  dsCidade: "Cidade",
  sgEstado: "UF",
  cdPais: "País (código)",
  nrDDD: "DDD",
  nrTel: "Telefone",
  nrDDDCel: "DDD do celular",
  nrCel: "Celular",
  dsEmail: "E-mail",
  dtAbert: "Abertura do cadastro",
  dtValcad: "Validade do cadastro",
  dtNasc: "Data de nascimento",
  cdPess: "Código de pessoa",
  cdAtvCl: "Atividade (código)",
  cdAutscr: "Autorização SCR",
  cdGrupo: "Grupo (código)",
};

/**
 * Campos que a TABELA já mostra (nº, nome, documento, tipo, situação) — a
 * ficha expandida só traz o que é NOVO; repetir a linha é ruído.
 */
const JA_NA_TABELA = new Set([
  "nrCliente",
  "nmCliente",
  "dsNome",
  "nrCpfCnpj",
  "tpPessoa",
  "cdSituacao",
  "dsSituacao",
]);

/** camelCase → "Camel case" para campos fora do mapa. */
function rotuloDe(chave: string): string {
  if (ROTULOS[chave]) return ROTULOS[chave];
  const espacado = chave.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return espacado.charAt(0).toUpperCase() + espacado.slice(1);
}

function formatarValor(chave: string, valor: unknown): string {
  const s = String(valor).trim();
  if (chave === "tpPessoa") return s === "F" ? "Física (F)" : s === "J" ? "Jurídica (J)" : s;
  if (chave === "cdSituacao") {
    const n = Number(s);
    return Number.isFinite(n) ? situacaoLabel(n) : s;
  }
  if (chave === "nrCpfCnpj") {
    const d = s.replace(/\D/g, "");
    if (d.length === 11)
      return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
    if (d.length === 14)
      return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
    return s;
  }
  if (chave === "nrCep") {
    const d = s.replace(/\D/g, "");
    return d.length === 8 ? `${d.slice(0, 5)}-${d.slice(5)}` : s;
  }
  // Datas AAAAMMDD (dtAbert, dtValcad, dtNasc, ...) viram dd/mm/aaaa.
  if (/^dt/.test(chave) && /^\d{8}$/.test(s)) return formatDataAAAAMMDD(Number(s));
  return s;
}

export function FichaCliente({ raw }: { raw: unknown }) {
  const obj =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : null;

  if (!obj) {
    return (
      <pre className="max-h-64 overflow-auto rounded-md border border-border bg-card p-3 font-mono text-code">
        {JSON.stringify(raw, null, 2)}
      </pre>
    );
  }

  // Só campos simples, preenchidos e que a tabela NÃO mostra; conhecidos primeiro.
  const simples = Object.entries(obj).filter(
    ([k, v]) =>
      !JA_NA_TABELA.has(k) &&
      (typeof v === "string" || typeof v === "number" || typeof v === "boolean") &&
      String(v).trim() !== "",
  );
  const ordem = Object.keys(ROTULOS);
  simples.sort(([a], [b]) => {
    const ia = ordem.indexOf(a);
    const ib = ordem.indexOf(b);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return a.localeCompare(b);
  });

  return (
    <div className="space-y-3 py-1">
      {simples.length === 0 && (
        <p className="text-caption text-muted-foreground">
          Nenhum dado além dos exibidos na tabela.
        </p>
      )}
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 md:grid-cols-3 lg:grid-cols-4">
        {simples.map(([chave, valor]) => (
          <div key={chave} className="min-w-0">
            <dt className="text-caption text-muted-foreground" title={chave}>
              {rotuloDe(chave)}
            </dt>
            <dd className="truncate text-body tabular-nums" title={formatarValor(chave, valor)}>
              {formatarValor(chave, valor)}
            </dd>
          </div>
        ))}
      </dl>

      <details>
        <summary className="focus-ring cursor-pointer text-caption font-medium text-primary">
          Ver dados brutos (JSON)
        </summary>
        <pre className="mt-2 max-h-64 overflow-auto rounded-md border border-border bg-card p-3 font-mono text-code">
          {JSON.stringify(obj, null, 2)}
        </pre>
      </details>
    </div>
  );
}
