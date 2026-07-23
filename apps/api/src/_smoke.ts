// Smoke test offline (sem VPN): valida parsing/validação/template.
import { buildTemplateCsv } from "./template.js";
import { parseCsv, parseJson, validateRows, buildRequest } from "./parse-input.js";
import { analyzeEnvelope } from "@cadastro-lote/shared";

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
const req = buildRequest(fromCsv[0], { finalizar: true });
ok(req.step === "FI", "buildRequest finalizar → step=FI");
const req2 = buildRequest(fromCsv[0], { finalizar: false });
ok(req2.step === undefined, "buildRequest sem finalizar → sem step");

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

console.log(fail === 0 ? "\n🎉 Todos os testes passaram." : `\n💥 ${fail} falha(s).`);
process.exit(fail === 0 ? 0 : 1);
