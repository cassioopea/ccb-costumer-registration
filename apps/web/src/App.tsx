import { Topbar } from "@/components/Topbar";
import { CadastroLote } from "@/pages/CadastroLote";

export default function App() {
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <Topbar />
      <main className="mx-auto w-full max-w-[1440px] flex-1 px-8 py-10">
        <CadastroLote />
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
