import type { ClienteResumo } from "@cadastro-lote/shared";

/**
 * Edição de cadastro: transforma o registro BRUTO da listagem (/v1/cliente)
 * no mapa achatado que o formulário do Cadastro Individual usa.
 *
 * A listagem e o cadastrarCliente usam nomes diferentes para os mesmos campos
 * (nmCliente→dsNome, nmBairro→dsBairro...); o mapa abaixo cobre os observados.
 * Campos sem equivalente no formulário são ignorados — o objetivo é dar o
 * ponto de partida para COMPLETAR o cadastro, não reproduzir o registro.
 */
const RAW_PARA_FORM: Record<string, string> = {
  nrCpfCnpj: "nrCpfCnpj",
  nmCliente: "dsNome",
  dsNome: "dsNome",
  dtAbert: "dtAbert",
  dtValcad: "dtValcad",
  nrCep: "nrCep",
  dsEnd: "dsEnd",
  nmEnd: "dsEnd",
  nrEnd: "nrEnd",
  dsCompl: "dsCompl",
  nmBairro: "dsBairro",
  dsBairro: "dsBairro",
  nmCidade: "dsCidade",
  dsCidade: "dsCidade",
  sgEstado: "sgEstado",
  nrDDD: "nrDDD",
  nrTel: "nrTel",
  nrDDDCel: "nrDDDCel",
  nrCel: "nrCel",
  dsEmail: "dsEmail",
};

export function rawParaCampos(cliente: ClienteResumo): Record<string, string> {
  const raw =
    cliente.raw && typeof cliente.raw === "object" && !Array.isArray(cliente.raw)
      ? (cliente.raw as Record<string, unknown>)
      : {};

  const campos: Record<string, string> = {};
  for (const [chaveRaw, path] of Object.entries(RAW_PARA_FORM)) {
    const v = raw[chaveRaw];
    if (v === null || v === undefined) continue;
    if (typeof v !== "string" && typeof v !== "number") continue;
    const s = String(v).trim();
    if (s !== "" && !campos[path]) campos[path] = s;
  }
  // Garantias mínimas a partir do resumo normalizado.
  if (!campos.nrCpfCnpj && cliente.documento) campos.nrCpfCnpj = cliente.documento;
  if (!campos.dsNome && cliente.nome) campos.dsNome = cliente.nome;
  return campos;
}
