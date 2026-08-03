// Smoke test offline (sem VPN): valida parsing/validação/template.
import { buildTemplateCsv } from "./template.js";
import { parseCsv, parseJson, validateRows, buildRequest } from "./parse-input.js";
import {
  alterarSituacaoRequestSchema,
  analyzeEnvelope,
  batchControlSchema,
  cdSituacaoSchema,
  matchCliente,
  normalizeClienteItem,
  normalizeClientesResponse,
  situacaoLabel,
} from "@cadastro-lote/shared";

let fail = 0;
const ok = (c: boolean, msg: string) => {
  console.log(`${c ? "✅" : "❌"} ${msg}`);
  if (!c) fail++;
};

// 1. Template gera e re-parseia (PF + PJ).
const csv = buildTemplateCsv();
const fromCsv = parseCsv(csv);
ok(fromCsv.length === 2, `template.csv gera 2 linhas (${fromCsv.length})`);
ok(fromCsv[0].nrCpfCnpj === "15032465070", "PF: nrCpfCnpj preservado como string");
ok(fromCsv[0].dadosPf?.dtNasc === 19800120, "PF: dtNasc coagido para number (AAAAMMDD)");
ok(fromCsv[0].dadosPf?.idUniao === "2", "PF: idUniao permanece string '2'");
ok(fromCsv[0].bensImoveis?.[0]?.tpImovel === "1", "PF: tpImovel permanece string '1'");
ok(fromCsv[0].bensImoveis?.[0]?.idAcao === "IN", "PF: bensImoveis[0].idAcao = IN");
ok(fromCsv[0].dadosBancarios?.[0]?.nrConta === "144460", "PF: nrConta string");
ok(fromCsv[0].dadosProfissionais?.vlRendaBruta === 17992.4, "PF: vlRendaBruta decimal");
ok(fromCsv[1].nrCpfCnpj === "10766388000190", "PJ: nrCpfCnpj 14 dígitos");
ok(fromCsv[1].dadosPj?.cdCapital === "N", "PJ: cdCapital string 'N'");
ok(fromCsv[1].dadosPf === undefined, "PJ: sem bloco dadosPf");

// 2. Validação zod das linhas do template.
const rows = validateRows(fromCsv);
ok(rows[0].errors.length === 0, `PF válida (erros: ${JSON.stringify(rows[0].errors)})`);
ok(rows[0].tipo === "PF", "PF detectada");
ok(rows[1].errors.length === 0, `PJ válida (erros: ${JSON.stringify(rows[1].errors)})`);
ok(rows[1].tipo === "PJ", "PJ detectada");

// 3. Fixture PF canônico (JSON com wrapper cliente).
const fixture = JSON.stringify({
  cliente: {
    dsNome: "Geraldo Luiz Bruno Aragão",
    nrCpfCnpj: "15032465070",
    dtAbert: 20001205,
    dadosPf: { dtNasc: 19800120, idUniao: "2" },
    bensImoveis: [{ idAcao: "IN", tpImovel: "1" }],
  },
});
const fromJson = parseJson(fixture);
ok(fromJson.length === 1 && fromJson[0].nrCpfCnpj === "15032465070", "JSON wrapper {cliente} normalizado");
const jsonRows = validateRows(fromJson);
ok(jsonRows[0].errors.length === 0, `fixture PF válido (erros: ${JSON.stringify(jsonRows[0].errors)})`);

// 4. Refino PF/PJ: CPF (11) + dadosPj deve falhar.
const bad = validateRows([{ nrCpfCnpj: "15032465070", dadosPj: { cdCapital: "N" } } as any]);
ok(bad[0].errors.some((e) => e.includes("dadosPj")), "CPF + dadosPj é rejeitado");

// 5. Enum estrito: idAcao inválido reprova.
const badEnum = validateRows([{ nrCpfCnpj: "15032465070", bensImoveis: [{ idAcao: "XX" } as any] }]);
ok(badEnum[0].errors.length > 0, "idAcao='XX' reprovado (enum estrito)");

// 5a-seg. Prototype pollution via cabeçalho de CSV é bloqueado.
let polluted = false;
try {
  parseCsv('dsNome,__proto__.hacked\r\n"X","1"');
  polluted = ({} as any).hacked !== undefined;
  ok(false, "CSV com __proto__ deveria ser rejeitado");
} catch {
  ok(!polluted && ({} as any).hacked === undefined, "CSV com __proto__ rejeitado (sem pollution)");
}
try {
  parseCsv("dsNome,bensImoveis[999999999].nmImovel\r\nX,Casa");
  ok(false, "índice de array gigante deveria ser rejeitado");
} catch {
  ok(true, "índice de array gigante rejeitado (anti-DoS)");
}

// 5b. idUniao só aceita "1"/"2" (regra real da Sinqia).
const badUniao = validateRows([{ nrCpfCnpj: "15032465070", dadosPf: { idUniao: "3" } as any }]);
ok(badUniao[0].errors.some((e) => e.includes("idUniao")), "idUniao='3' reprovado");
const okUniao = validateRows([{ nrCpfCnpj: "15032465070", dadosPf: { idUniao: "2" } as any }]);
ok(okUniao[0].errors.length === 0, "idUniao='2' aceito");

// 6. buildRequest injeta step=FI quando finalizar.
const ctl = { finalizar: false, idIntegracaoCadastro: "S" } as const;
const req = buildRequest(fromCsv[0], { ...ctl, finalizar: true });
ok(req.step === "FI", "buildRequest finalizar → step=FI");
const req2 = buildRequest(fromCsv[0], ctl);
ok(req2.step === undefined, "buildRequest sem finalizar → sem step");

// 6a. idIntegracaoCadastro default "S" é sempre enviado.
ok(req2.idIntegracaoCadastro === "S", 'idIntegracaoCadastro default "S" enviado');
ok(
  batchControlSchema.parse({}).idIntegracaoCadastro === "S",
  'batchControlSchema: control vazio → idIntegracaoCadastro "S"',
);
const reqN = buildRequest(fromCsv[0], { ...ctl, idIntegracaoCadastro: "N" });
ok(reqN.idIntegracaoCadastro === "N", 'idIntegracaoCadastro "N" respeitado');
ok(
  batchControlSchema.safeParse({ idIntegracaoCadastro: "X" }).success === false,
  'idIntegracaoCadastro "X" reprovado (enum S/N)',
);

// 6b. Ação do lote (idAcao): ausente = nada injetado (comportamento histórico).
ok(
  req2.cliente.idAcaoCliente === undefined && req2.cliente.idAcaoEndereco === undefined,
  "sem idAcao no controle → cliente sem idAcaoCliente/idAcaoEndereco",
);
ok(
  req2.cliente.bensImoveis?.[0]?.idAcao === "IN",
  "sem idAcao no controle → bensImoveis mantém o valor do arquivo",
);

// 6c. Ação do lote aplicada: raiz + arrays, sobrescrevendo o arquivo.
const reqEx = buildRequest(fromCsv[0], { ...ctl, idAcao: "EX" });
ok(reqEx.cliente.idAcaoCliente === "EX", "idAcao=EX → idAcaoCliente=EX");
ok(reqEx.cliente.idAcaoEndereco === "EX", "idAcao=EX → idAcaoEndereco=EX");
ok(
  reqEx.cliente.bensImoveis?.[0]?.idAcao === "EX",
  "idAcao=EX sobrescreve bensImoveis[0].idAcao (era IN no arquivo)",
);
ok(
  reqEx.cliente.dadosBancarios?.[0]?.idAcao === "EX",
  "idAcao=EX sobrescreve dadosBancarios[0].idAcao",
);
// dadosPf/dadosProfissionais NÃO recebem idAcao (o payload validado não envia).
ok(
  (reqEx.cliente.dadosPf as any)?.idAcao === undefined,
  "idAcao NÃO é injetado em dadosPf",
);
ok(
  reqEx.cliente.dadosProfissionais?.idAcao === undefined,
  "idAcao NÃO é injetado em dadosProfissionais",
);
// PJ: dadosPj recebe idAcao.
const reqAlPj = buildRequest(fromCsv[1], { ...ctl, idAcao: "AL" });
ok(reqAlPj.cliente.dadosPj?.idAcao === "AL", "idAcao=AL → dadosPj.idAcao=AL");
ok(reqAlPj.cliente.idAcaoCliente === "AL", "idAcao=AL → idAcaoCliente=AL (PJ)");
// Não muta a entrada original.
ok(
  fromCsv[0].bensImoveis?.[0]?.idAcao === "IN" && fromCsv[0].idAcaoCliente === undefined,
  "applyIdAcao não muta o cliente original",
);
// Enum estrito também no controle do lote.
ok(
  batchControlSchema.safeParse({ idAcao: "ZZ" }).success === false,
  'controle idAcao="ZZ" reprovado (enum IN/AL/EX/CO)',
);
for (const a of ["IN", "AL", "EX", "CO"] as const) {
  ok(batchControlSchema.safeParse({ idAcao: a }).success, `controle idAcao="${a}" aceito`);
}

// 7. analyzeEnvelope.
ok(analyzeEnvelope(200, { status: "100", messages: [] }).ok === true, "envelope 200 s/ msgs → OK");
ok(analyzeEnvelope(200, { messages: [{ type: "E", message: "erro X" }] }).ok === false, "msg type E → ERRO");
ok(analyzeEnvelope(500, {}).ok === false, "HTTP 500 → ERRO");
const an = analyzeEnvelope(200, { messages: [{ type: "E", source: "CPF", message: "inválido" }] });
ok(an.messagesText.includes("inválido"), "messagesText concatena mensagens");

// 8. Envelope de sucesso real (HML): status "OK".
const real = analyzeEnvelope(200, {
  status: "OK",
  globalMessage: "Cadastro do cliente salvo/atualizado com sucesso.",
  messages: [{ type: "Sucesso", message: "4154" }],
});
ok(real.ok === true && real.envelopeStatus === "OK", 'envelope real status "OK" → OK');

/* ------------------------------------------------------------------ */
/* 9. Situação de cliente                                              */
/* ------------------------------------------------------------------ */

// 9a. cdSituacao aceita só os códigos da tabela.
for (const c of [1, 2, 3, 4, 5, 10, 11, 12, 13, 14, 15, 98, 99]) {
  ok(cdSituacaoSchema.safeParse(c).success, `cdSituacao=${c} aceito`);
}
for (const c of [0, 6, 7, 16, 100, -1]) {
  ok(cdSituacaoSchema.safeParse(c).success === false, `cdSituacao=${c} reprovado`);
}
ok(
  alterarSituacaoRequestSchema.safeParse({ cdSituacao: 1, nrCliente: 4154 }).success,
  "alterarSituacaoRequest válido",
);
ok(
  alterarSituacaoRequestSchema.safeParse({ cdSituacao: 7, nrCliente: 4154 }).success === false,
  "alterarSituacaoRequest com cdSituacao inválido reprovado",
);
ok(situacaoLabel(12) === "12 — APROVADO", "situacaoLabel(12) formata código + rótulo");
ok(situacaoLabel(777) === "777", "situacaoLabel de código desconhecido devolve o número");

// 9b. Normalização da lista: página Spring (formato mais provável).
const springPage = {
  content: [
    { nrCliente: 4154, dsNome: "Geraldo Luiz", nrCpfCnpj: "15032465070", cdSituac: 1 },
    { nrCliente: 4155, dsNome: "ACME LTDA", nrCpfCnpj: "10766388000190", cdSituac: 12 },
  ],
  totalElements: 2,
  totalPages: 1,
  number: 0,
  size: 20,
};
const pg = normalizeClientesResponse(springPage);
ok(pg.items.length === 2, "página Spring: 2 itens");
ok(pg.totalElements === 2 && pg.totalPages === 1, "página Spring: totais lidos");
ok(pg.items[0].nrCliente === 4154, "página Spring: nrCliente extraído");
ok(pg.items[0].tipoPessoa === "PF", "página Spring: PF deduzido do documento (11 dígitos)");
ok(pg.items[1].tipoPessoa === "PJ", "página Spring: PJ deduzido do documento (14 dígitos)");
ok(pg.items[1].dsSituacao === "12 — APROVADO", "página Spring: situação rotulada pelo código");

// 9c. Formatos alternativos (o contrato real ainda não foi confirmado).
ok(
  normalizeClientesResponse([{ nrCliente: 1, dsNome: "X" }]).items.length === 1,
  "array cru normalizado",
);
ok(
  normalizeClientesResponse({ data: { content: [{ nrCliente: 9 }] } }).items[0].nrCliente === 9,
  "lista dentro de data.content normalizada",
);
ok(
  normalizeClientesResponse({ clientes: [{ numeroCliente: 77, nome: "Y" }] }).items[0].nrCliente === 77,
  "chaves alternativas (clientes/numeroCliente/nome) normalizadas",
);

// 9d. Sem chave utilizável → nrCliente null (a UI bloqueia a seleção desses).
const semChave = normalizeClientesResponse({ content: [{ dsNome: "Sem número" }] });
ok(semChave.items[0].nrCliente === null, "item sem nrCliente → null (não selecionável)");
ok(semChave.items[0].raw !== undefined, "item preserva o objeto bruto");

// 9e. Respostas vazias/inesperadas não explodem.
ok(normalizeClientesResponse(null).items.length === 0, "body null → página vazia");
ok(normalizeClientesResponse({}).items.length === 0, "body sem lista → página vazia");
ok(normalizeClientesResponse("texto").items.length === 0, "body string → página vazia");

// 9f. Filtro local (número exato, nome/documento por substring).
const alvo = normalizeClienteItem({
  nrCliente: 4154,
  dsNome: "Geraldo Luiz Bruno Aragão",
  nrCpfCnpj: "15032465070",
  cdSituac: 1,
});
ok(matchCliente(alvo, ""), "filtro vazio casa tudo");
ok(matchCliente(alvo, "geraldo"), "filtro casa nome (case-insensitive)");
ok(matchCliente(alvo, "ARAGÃO"), "filtro casa parte do nome com acento");
ok(matchCliente(alvo, "4154"), "filtro casa nrCliente exato");
ok(!matchCliente(alvo, "415"), "filtro NÃO casa nrCliente parcial (415 ≠ 4154)");
ok(!matchCliente(alvo, "41540"), "filtro NÃO casa nrCliente mais longo");
ok(matchCliente(alvo, "15032465070"), "filtro casa CPF sem máscara");
ok(matchCliente(alvo, "150.324.650-70"), "filtro casa CPF COM máscara");
ok(matchCliente(alvo, "324650"), "filtro casa parte do documento");
ok(!matchCliente(alvo, "99999999999"), "filtro não casa documento alheio");
ok(!matchCliente(alvo, "fulano"), "filtro não casa nome alheio");
// Item sem nrCliente não pode casar por número.
const semNumero = normalizeClienteItem({ dsNome: "Sem Numero", nrCpfCnpj: "15032465070" });
ok(!matchCliente(semNumero, "4154"), "item sem nrCliente não casa por número");
ok(matchCliente(semNumero, "sem numero"), "item sem nrCliente ainda casa por nome");

console.log(fail === 0 ? "\n🎉 Todos os testes passaram." : `\n💥 ${fail} falha(s).`);
process.exit(fail === 0 ? 0 : 1);
