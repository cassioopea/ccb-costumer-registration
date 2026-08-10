/**
 * @homolog — US-02, cenário 1.2 refeito: validação ANTES da requisição.
 *
 * A primeira tentativa usou o MESMO CPF de uma requisição pendente e o 409 de
 * duplicidade mascarou o resultado. Aqui cada caso usa CPF próprio e a
 * profundidade da validação local é medida caso a caso.
 */
import { EXEMPLO_PF } from "@cadastro-lote/shared";
import { cpfSintetico, evidencia, get, log, login, post, agora } from "./lib.mjs";

await login("A");
const CONTROL = { finalizar: false, idIntegracaoCadastro: "S" };
const casos = [];

async function caso(id, descricao, mutacao, esperado) {
  const campos = { ...EXEMPLO_PF, ...mutacao };
  const r = await post("A", "/api/cadastrar", { campos, control: CONTROL });
  const virouRequisicao = r.status === 201 && r.json?.aprovacao === true;
  const registro = {
    id,
    descricao,
    esperado,
    httpStatus: r.status,
    valido: r.json?.valido ?? null,
    erros: r.json?.errors ?? r.json?.error ?? null,
    virouRequisicao,
    requisicaoId: r.json?.requisicao?.id ?? null,
  };
  casos.push(registro);
  log(
    `${id} — HTTP ${r.status} valido=${registro.valido} virouRequisicao=${virouRequisicao} ` +
      `erros=${JSON.stringify(registro.erros)}`,
  );
  return registro;
}

// (a) CPF com quantidade inválida de dígitos — a validação local deve barrar.
const a = await caso(
  "1.2a",
  "CPF com 10 dígitos",
  { dsNome: "TESTE-SOD-INV-A GERALDO", nrCpfCnpj: "1503246507" },
  "valido:false, nenhuma requisição criada",
);

// (b) data de nascimento inválida.
const b = await caso(
  "1.2b",
  "dadosPf.dtNasc inválida (99999999)",
  {
    dsNome: "TESTE-SOD-INV-B GERALDO",
    nrCpfCnpj: cpfSintetico(900810091),
    "dadosPf.dtNasc": "99999999",
  },
  "valido:false, nenhuma requisição criada",
);

// (c) nome vazio — mede a PROFUNDIDADE da validação local (dsNome é opcional no
//     schema compartilhado, mas é campo obrigatório na Sinqia).
const c = await caso(
  "1.2c",
  "dsNome vazio (campo obrigatório na Sinqia)",
  { dsNome: "", nrCpfCnpj: cpfSintetico(900810092) },
  "observação: a esteira reusa a validação do fluxo direto (decisão 7)",
);

// Limpeza: qualquer requisição criada nos casos acima é cancelada pelo criador.
for (const r of casos) {
  if (r.requisicaoId) {
    const canc = await post("A", `/api/sod/requisicoes/${r.requisicaoId}/decisao`, {
      decisao: "cancelar",
    });
    r.limpeza = `cancelada: HTTP ${canc.status}`;
    log(`limpeza — requisição ${r.requisicaoId} cancelada (HTTP ${canc.status})`);
  }
}

const passou = a.valido === false && !a.virouRequisicao && b.valido === false && !b.virouRequisicao;
log(`\n1.2 (a+b) ${passou ? "PASSOU" : "FALHOU"} — validação local barra antes da requisição`);
log(`1.2c observação: dsNome vazio ${c.virouRequisicao ? "PASSA pela validação local" : "é barrado"}`);
log(`evidência: ${evidencia("11-us02-validacao", { quando: agora(), casos, passou })}`);
