import { useMemo, useState } from "react";
import { CheckCircle2, FileJson, History, XCircle } from "lucide-react";
import { CAMPOS } from "@cadastro-lote/shared";
import { Button } from "@/components/ui/button";
import type { EventoAuditoriaSod, RequisicaoSod } from "@/lib/api";

/**
 * Esteira de Aprovação (SoD) — corpo do DETALHE de uma requisição, usado nos
 * drawers de "Minhas requisições" (US-02) e do Painel de pendências (US-03):
 * resumo, payload em campos nomeados (JSON cru em seção expansível), resultado
 * da execução e histórico de transições da auditoria.
 */

/** Rótulo legível de cada caminho do formulário de cadastro. */
const ROTULO_POR_PATH = new Map(CAMPOS.map((c) => [c.path, c.label]));

export function formatarTs(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Nome do tomador dentro do payload canônico `{ campos: { dsNome } }`. */
export function nomeDoPayload(payload: Record<string, unknown>): string {
  const campos = payload.campos;
  if (campos && typeof campos === "object" && !Array.isArray(campos)) {
    const nome = (campos as Record<string, unknown>).dsNome;
    if (typeof nome === "string" && nome.trim()) return nome;
  }
  return "—";
}

const ROTULO_DECISAO: Record<string, string> = {
  aprovar: "aprovação",
  reprovar: "reprovação",
  cancelar: "cancelamento",
  retry: "retry",
  descartar: "descarte",
  concluir_execucao: "conclusão da execução",
};

/** Linha legível do histórico de auditoria. */
function descreverEvento(ev: EventoAuditoriaSod): string {
  const d = ev.detalhe as { decisao?: string; de?: string; para?: string; mensagem?: string };
  if (ev.acao === "requisicao_criada") return "Requisição criada";
  if (ev.acao === "execucao_iniciada") return "Execução na Sinqia iniciada (sessão do aprovador)";
  if (ev.acao === "transicao_estado") {
    const decisao = d.decisao ? ROTULO_DECISAO[d.decisao] ?? d.decisao : "transição";
    return `${d.de ?? "?"} → ${d.para ?? "?"} (${decisao})`;
  }
  if (ev.acao === "tentativa_rejeitada") {
    return `Tentativa rejeitada — ${d.mensagem ?? ev.resultado}`;
  }
  return ev.acao;
}

export function LinhaDetalhe({ rotulo, valor }: { rotulo: string; valor: string }) {
  return (
    <div className="flex gap-2">
      <span className="min-w-44 shrink-0 text-muted-foreground">{rotulo}</span>
      <span className="break-all">{valor}</span>
    </div>
  );
}

/** Resumo legível do resultado anexado pela execução (RN05 da US-03). */
function resumoResultado(resultado: Record<string, unknown>): string {
  const mensagens = resultado.mensagens ?? resultado.mensagem;
  if (typeof mensagens === "string" && mensagens.trim()) return mensagens;
  const detalhe = resultado.detalhe;
  if (typeof detalhe === "string" && detalhe.trim()) return detalhe;
  return "";
}

export function RequisicaoDetalhe({
  requisicao: req,
  historico,
}: {
  requisicao: RequisicaoSod;
  historico: EventoAuditoriaSod[];
}) {
  const [verJson, setVerJson] = useState(false);
  const [verJsonResultado, setVerJsonResultado] = useState(false);

  const camposDoPayload = useMemo(() => {
    const campos = req.payload.campos;
    if (!campos || typeof campos !== "object" || Array.isArray(campos)) return [];
    return Object.entries(campos as Record<string, unknown>).map(([path, valor]) => ({
      path,
      rotulo: ROTULO_POR_PATH.get(path) ?? path,
      valor: String(valor ?? ""),
    }));
  }, [req]);

  const controlDoPayload = useMemo(() => {
    const control = req.payload.control;
    if (!control || typeof control !== "object" || Array.isArray(control)) return [];
    return Object.entries(control as Record<string, unknown>).map(([chave, valor]) => ({
      chave,
      valor: String(valor ?? ""),
    }));
  }, [req]);

  return (
    <div className="space-y-5 text-sm">
      {/* Resumo */}
      <div className="grid gap-1">
        <LinhaDetalhe rotulo="Criada em" valor={formatarTs(req.criadoEm)} />
        <LinhaDetalhe rotulo="Criada por" valor={req.requisitante} />
        <LinhaDetalhe rotulo="Última atualização" valor={formatarTs(req.atualizadoEm)} />
        {req.decididoPor && <LinhaDetalhe rotulo="Decidida por" valor={req.decididoPor} />}
        {req.documento && <LinhaDetalhe rotulo="Documento" valor={req.documento} />}
      </div>

      {/* Motivo de reprovação/descarte */}
      {req.motivo && (
        <div className="rounded-lg border border-[var(--destructive)] bg-[var(--destructive)]/10 px-3 py-2 text-[var(--destructive)]">
          <p className="font-medium">
            Motivo {req.estado === "descartada" ? "do descarte" : "da reprovação"}:
          </p>
          <p className="mt-0.5">{req.motivo}</p>
        </div>
      )}

      {/* Resultado da execução na Sinqia (US-03): sucesso ou falha, legível */}
      {req.resultado && (req.estado === "executada" || req.estado === "falha") && (
        <div
          className={
            req.estado === "executada"
              ? "rounded-lg border border-[var(--success)] bg-[var(--success)]/10 px-3 py-2"
              : "rounded-lg border border-[var(--destructive)] bg-[var(--destructive)]/10 px-3 py-2 text-[var(--destructive)]"
          }
        >
          <p className="flex items-center gap-1.5 font-medium">
            {req.estado === "executada" ? (
              <>
                <CheckCircle2 className="h-4 w-4 shrink-0" />
                Executada na Sinqia
              </>
            ) : (
              <>
                <XCircle className="h-4 w-4 shrink-0" />
                Falha na execução
              </>
            )}
          </p>
          {resumoResultado(req.resultado) && (
            <p className="mt-0.5 break-all">{resumoResultado(req.resultado)}</p>
          )}
          <Button
            variant="outline"
            size="sm"
            className="mt-2"
            onClick={() => setVerJsonResultado((v) => !v)}
          >
            <FileJson className="h-4 w-4" />
            {verJsonResultado ? "Ocultar" : "Ver"} resposta integral
          </Button>
          {verJsonResultado && (
            <pre className="mt-2 max-h-60 overflow-auto rounded-lg bg-[var(--muted)]/40 p-3 text-xs text-foreground">
              {JSON.stringify(req.resultado, null, 2)}
            </pre>
          )}
        </div>
      )}

      {/* Dados do tomador em campos nomeados */}
      <section>
        <h3 className="mb-2 text-subheading text-foreground">Dados do tomador</h3>
        {camposDoPayload.length === 0 ? (
          <p className="text-muted-foreground">
            O payload desta requisição não está no formato do formulário de cadastro — consulte
            o JSON integral abaixo.
          </p>
        ) : (
          <div className="grid gap-1 rounded-lg border border-border p-3">
            {camposDoPayload.map((c) => (
              <div key={c.path} className="flex gap-2">
                <span className="min-w-44 shrink-0 text-muted-foreground" title={c.path}>
                  {c.rotulo}
                </span>
                <span className="break-all">{c.valor}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Controles do cadastro */}
      {controlDoPayload.length > 0 && (
        <section>
          <h3 className="mb-2 text-subheading text-foreground">Controles do cadastro</h3>
          <div className="grid gap-1 rounded-lg border border-border p-3">
            {controlDoPayload.map((c) => (
              <div key={c.chave} className="flex gap-2">
                <span className="min-w-44 shrink-0 font-mono text-caption text-muted-foreground">
                  {c.chave}
                </span>
                <span className="break-all">{c.valor}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* JSON integral — seção secundária, expansível */}
      <section>
        <Button variant="outline" size="sm" onClick={() => setVerJson((v) => !v)}>
          <FileJson className="h-4 w-4" />
          {verJson ? "Ocultar" : "Ver"} JSON integral
        </Button>
        {verJson && (
          <pre className="mt-3 max-h-80 overflow-auto rounded-lg bg-[var(--muted)]/40 p-3 text-xs">
            {JSON.stringify(req.payload, null, 2)}
          </pre>
        )}
      </section>

      {/* Histórico de transições (trilha de auditoria) */}
      <section>
        <h3 className="mb-2 flex items-center gap-1.5 text-subheading text-foreground">
          <History className="h-4 w-4" />
          Histórico
        </h3>
        <ol className="space-y-2">
          {historico.map((ev) => (
            <li key={ev.id} className="rounded-lg border border-border px-3 py-2">
              <p>{descreverEvento(ev)}</p>
              <p className="mt-0.5 text-caption text-muted-foreground">
                {formatarTs(ev.ts)} · {ev.ator}
                {typeof ev.detalhe.motivo === "string" && <> · motivo: {ev.detalhe.motivo}</>}
              </p>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
