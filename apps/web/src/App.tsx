import { useState } from "react";
import { FilePlus2, FileSpreadsheet, ListChecks, Loader2, Upload, UserPlus } from "lucide-react";
import { Topbar, type Modulo } from "@/components/Topbar";
import { SessionExpiredDialog } from "@/components/SessionExpiredDialog";
import { CadastroIndividual } from "@/pages/CadastroIndividual";
import { CadastroLote } from "@/pages/CadastroLote";
import { SituacaoClientes } from "@/pages/SituacaoClientes";
import { PropostasLote } from "@/pages/PropostasLote";
import { PropostaIndividual } from "@/pages/PropostaIndividual";
import { Login } from "@/pages/Login";
import { SessionProvider, useSession } from "@/lib/session";
import { cn } from "@/lib/utils";

/**
 * Esteira de Originação — dois módulos:
 *  - Clientes: cadastro individual, em lote e situação (já existiam);
 *  - Propostas: lote de propostas a partir do Emissoes.xlsx (Fase 1).
 * Módulo na topbar; telas do módulo nas abas abaixo dela.
 */

type TelaClientes = "individual" | "cadastro" | "situacao";
type TelaPropostas = "lote-propostas" | "proposta-individual";

const TELAS_CLIENTES = [
  { id: "situacao" as const, label: "Base de clientes", icon: ListChecks },
  { id: "individual" as const, label: "Cadastro individual", icon: UserPlus },
  { id: "cadastro" as const, label: "Cadastro em lote", icon: Upload },
];

const TELAS_PROPOSTAS = [
  { id: "lote-propostas" as const, label: "Lote de propostas", icon: FileSpreadsheet },
  { id: "proposta-individual" as const, label: "Proposta individual", icon: FilePlus2 },
];

export default function App() {
  return (
    <SessionProvider>
      <Shell />
    </SessionProvider>
  );
}

function Shell() {
  const { session, carregando } = useSession();
  const [modulo, setModulo] = useState<Modulo>("clientes");
  // Base de clientes é a primeira aba e a tela inicial do módulo.
  const [telaClientes, setTelaClientes] = useState<TelaClientes>("situacao");
  const [telaPropostas, setTelaPropostas] = useState<TelaPropostas>("lote-propostas");

  // Enquanto rehidrata a sessão do cookie, não pisca a tela de login.
  if (carregando) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  if (!session) return <Login />;

  const telas = modulo === "clientes" ? TELAS_CLIENTES : TELAS_PROPOSTAS;
  const telaAtiva = modulo === "clientes" ? telaClientes : telaPropostas;

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <Topbar modulo={modulo} onModuloChange={setModulo} />

      {/* Telas do módulo ativo. Trocar de módulo/aba não perde estado. */}
      <nav className="border-b border-border bg-card" aria-label="Telas do módulo">
        <div className="mx-auto flex max-w-shell gap-1 px-8">
          {telas.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() =>
                modulo === "clientes"
                  ? setTelaClientes(id as TelaClientes)
                  : setTelaPropostas(id as TelaPropostas)
              }
              aria-current={telaAtiva === id ? "page" : undefined}
              className={cn(
                "focus-ring -mb-px flex items-center gap-2 border-b-2 px-4 py-3 text-body font-medium transition-colors duration-150",
                telaAtiva === id
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon className="h-4 w-4" />
              {label}
            </button>
          ))}
        </div>
      </nav>

      <main className="mx-auto w-full max-w-shell flex-1 px-8 py-10">
        {/* Mantém todas montadas: trocar de módulo/aba não perde arquivo
            selecionado, base carregada, seleção nem lote em andamento. */}
        <div className={modulo === "clientes" && telaClientes === "individual" ? undefined : "hidden"}>
          <CadastroIndividual />
        </div>
        <div className={modulo === "clientes" && telaClientes === "cadastro" ? undefined : "hidden"}>
          <CadastroLote />
        </div>
        <div className={modulo === "clientes" && telaClientes === "situacao" ? undefined : "hidden"}>
          <SituacaoClientes ativa={modulo === "clientes" && telaClientes === "situacao"} />
        </div>
        <div
          className={
            modulo === "propostas" && telaPropostas === "lote-propostas" ? undefined : "hidden"
          }
        >
          <PropostasLote />
        </div>
        <div
          className={
            modulo === "propostas" && telaPropostas === "proposta-individual"
              ? undefined
              : "hidden"
          }
        >
          <PropostaIndividual />
        </div>
      </main>

      <footer className="border-t border-border bg-card px-8 py-4 text-caption text-muted-foreground">
        <div className="mx-auto flex max-w-shell items-center justify-between">
          <span>© Opea Solutions — Ferramenta interna</span>
          <span className="text-muted-foreground/80">
            Opea SCD · Esteira de Originação · Sinqia
          </span>
        </div>
      </footer>

      {/* Reautenticação: aparece sobre a tela sem destruir o estado dela. */}
      <SessionExpiredDialog />
    </div>
  );
}
