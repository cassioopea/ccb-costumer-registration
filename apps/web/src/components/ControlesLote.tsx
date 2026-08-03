import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
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
        <Select
          id="ctl-idAcao"
          value={control.idAcao}
          onChange={(e) => alterar({ idAcao: e.target.value as IdAcao | "" })}
          className={cn(
            control.idAcao === "EX" &&
              "border-[var(--destructive)] font-medium text-[var(--destructive)]",
          )}
        >
          <option value="">Não enviar (padrão — inclusão)</option>
          <option value="IN">IN — Incluir (cadastro novo)</option>
          <option value="AL">AL — Alterar (atualizar cadastro existente)</option>
          <option value="EX">EX — Excluir (remover cadastro)</option>
          <option value="CO">CO — Consultar (somente leitura)</option>
        </Select>
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
          <Select
            id="ctl-idInt"
            value={control.idIntegracaoCadastro}
            onChange={(e) => alterar({ idIntegracaoCadastro: e.target.value as "S" | "N" })}
          >
            <option value="S">S — integrar com o módulo de cadastro (padrão)</option>
            <option value="N">N — não integrar</option>
          </Select>
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
