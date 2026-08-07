import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Combobox } from "@/components/ui/combobox";
import { cn } from "@/lib/utils";
import type { BatchControlInput, BatchControlPayload, IdAcao } from "@/lib/api";

/**
 * Controles de request compartilhados pelo cadastro em lote e pelo individual.
 *
 * Ficavam embutidos em CadastroLote; extraídos para que as duas telas usem
 * exatamente os mesmos defaults e as mesmas regras (em especial
 * `idIntegracaoCadastro = "S"` e a semântica de `idAcao`).
 */

export const CONTROL_INICIAL: BatchControlInput = {
  finalizar: false,
  // Default "S": integra automaticamente com o módulo de cadastro.
  idIntegracaoCadastro: "S",
  // "" = usa a ação que vier do arquivo/nada é injetado.
  idAcao: "",
  idRetConsistencias: "",
};

export function useControlesLote() {
  const [control, setControl] = useState<BatchControlInput>({ ...CONTROL_INICIAL });
  return { control, setControl };
}

/** Remove os "" antes de enviar: campo não escolhido é campo omitido. */
export function sanitizeControl(c: BatchControlInput): BatchControlPayload {
  return {
    finalizar: c.finalizar,
    idIntegracaoCadastro: c.idIntegracaoCadastro,
    ...(c.idAcao ? { idAcao: c.idAcao } : {}),
    ...(c.idRetConsistencias ? { idRetConsistencias: c.idRetConsistencias } : {}),
  };
}

interface Props {
  control: BatchControlInput;
  setControl: React.Dispatch<React.SetStateAction<BatchControlInput>>;
  /** Chamado a cada alteração — as telas usam para invalidar validação prévia. */
  onChange?: () => void;
  /** Rótulo do escopo nos textos ("todas as linhas" vs "este cadastro"). */
  escopo?: string;
}

export function ControlesLote({ control, setControl, onChange, escopo = "todas as linhas" }: Props) {
  const alterar = (patch: Partial<BatchControlInput>) => {
    setControl((c) => ({ ...c, ...patch }));
    onChange?.();
  };

  return (
    <div className="space-y-3">
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          className="h-4 w-4 accent-[var(--primary)]"
          checked={control.finalizar}
          onChange={(e) => alterar({ finalizar: e.target.checked })}
        />
        <span className="font-medium">
          Finalizar e enviar ao Motor de Crédito (<code>step="FI"</code>)
        </span>
      </label>

      <div className="space-y-1">
        <Label htmlFor="ctl-idAcao" className="text-xs">
          Ação (<code>idAcao</code>)
        </Label>
        <Combobox
          id="ctl-idAcao"
          value={control.idAcao}
          onChange={(v) => alterar({ idAcao: v as IdAcao | "" })}
          triggerClassName={cn(
            control.idAcao === "EX" &&
              "border-[var(--destructive)] font-medium text-[var(--destructive)]",
          )}
          options={[
            { value: "", label: "Não enviar (padrão — inclusão)" },
            { value: "IN", label: "IN — Incluir (cadastro novo)" },
            { value: "AL", label: "AL — Alterar (atualizar cadastro existente)" },
            { value: "EX", label: "EX — Excluir (remover cadastro)" },
            { value: "CO", label: "CO — Consultar (somente leitura)" },
          ]}
        />
        <p className="text-xs text-[var(--muted-foreground)]">
          {control.idAcao === "" ? (
            <>Nada é injetado — a Sinqia assume inclusão.</>
          ) : (
            <>
              Aplica <code>{control.idAcao}</code> a <strong>{escopo}</strong>.
            </>
          )}
        </p>
      </div>

      {control.idAcao === "EX" && (
        <div className="flex items-start gap-2 rounded-md border border-[var(--destructive)] bg-[var(--destructive)]/10 px-3 py-2 text-xs text-[var(--destructive)]">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            <strong>Exclusão.</strong> Vai remover cadastro. Não há desfazer pela ferramenta —
            teste em HML antes.
          </span>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label htmlFor="ctl-idInt" className="text-xs">
            idIntegracaoCadastro
          </Label>
          <Combobox
            id="ctl-idInt"
            value={control.idIntegracaoCadastro}
            onChange={(v) => alterar({ idIntegracaoCadastro: v as "S" | "N" })}
            options={[
              { value: "S", label: "S — integrar com o módulo de cadastro (padrão)" },
              { value: "N", label: "N — não integrar" },
            ]}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="ctl-idRet" className="text-xs">
            idRetConsistencias
          </Label>
          <Input
            id="ctl-idRet"
            placeholder="opcional"
            value={control.idRetConsistencias ?? ""}
            onChange={(e) => alterar({ idRetConsistencias: e.target.value })}
          />
        </div>
      </div>
    </div>
  );
}
