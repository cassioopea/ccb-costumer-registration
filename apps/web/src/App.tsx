import { useState } from "react";
import { ListChecks, Upload } from "lucide-react";
import { Topbar } from "@/components/Topbar";
import { CadastroLote } from "@/pages/CadastroLote";
import { SituacaoClientes } from "@/pages/SituacaoClientes";
import { cn } from "@/lib/utils";

type Tela = "cadastro" | "situacao";

const TELAS = [
  { id: "cadastro" as const, label: "Cadastro em Lote", icon: Upload },
  { id: "situacao" as const, label: "Situação de Clientes", icon: ListChecks },
];

export default function App() {
  const [tela, setTela] = useState<Tela>("cadastro");

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <Topbar />

      {/* Navegação entre as telas. Duas telas só — abas bastam, sem router. */}
      <nav className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-[1440px] gap-1 px-8">
          {TELAS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setTela(id)}
              aria-current={tela === id ? "page" : undefined}
              className={cn(
                "-mb-px flex items-center gap-2 border-b-2 px-4 py-3 text-sm font-medium transition-colors",
                tela === id
                  ? "border-[var(--primary)] text-[var(--primary)]"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon className="h-4 w-4" />
              {label}
            </button>
          ))}
        </div>
      </nav>

      <main className="mx-auto w-full max-w-[1440px] flex-1 px-8 py-10">
        {/* Mantém as duas montadas: trocar de aba não perde credenciais,
            arquivo selecionado nem resultado de lote em andamento. */}
        <div className={tela === "cadastro" ? undefined : "hidden"}>
          <CadastroLote />
        </div>
        <div className={tela === "situacao" ? undefined : "hidden"}>
          <SituacaoClientes />
        </div>
      </main>

      <footer className="border-t border-border bg-card px-8 py-4 text-caption text-muted-foreground">
        <div className="mx-auto flex max-w-[1440px] items-center justify-between">
          <span>© Opea Solutions — Ferramenta interna</span>
          <span className="text-muted-foreground/80">Opea SCD · Cadastro em Lote · Sinqia</span>
        </div>
      </footer>
    </div>
  );
}
