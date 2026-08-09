import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Topbar, type Modulo } from "@/components/Topbar";
import { SessionExpiredDialog } from "@/components/SessionExpiredDialog";
import { Inicio } from "@/pages/Inicio";
import { CadastroIndividual } from "@/pages/CadastroIndividual";
import { CadastroLote } from "@/pages/CadastroLote";
import { SituacaoClientes } from "@/pages/SituacaoClientes";
import { PropostasLote } from "@/pages/PropostasLote";
import { PropostaIndividual } from "@/pages/PropostaIndividual";
import { PainelPropostas } from "@/pages/PainelPropostas";
import { Requisicoes, type TelaRequisicoes } from "@/pages/Requisicoes";
import { Login } from "@/pages/Login";
import { PrimeiroAcessoDialog } from "@/components/onboarding/PrimeiroAcessoDialog";
import { ProductTour } from "@/components/onboarding/ProductTour";
import { ChecklistOnboarding } from "@/components/onboarding/ChecklistOnboarding";
import { OnboardingProvider, useOnboarding } from "@/lib/onboarding";
import { SessionProvider, useSession } from "@/lib/session";
import type { PaginaTour } from "@/lib/onboarding-roteiro";
import type { ClienteResumo } from "@cadastro-lote/shared";

/**
 * Esteira de Originação — dois módulos, cada um com uma PÁGINA PRINCIPAL
 * (a listagem) e sub-páginas alcançadas por CTAs nela:
 *  - Clientes: Base de clientes → Cadastro individual / Cadastro em lote;
 *  - Propostas: Painel de propostas → Lote de propostas / Proposta individual.
 * A volta é pelo breadcrumb clicável das sub-páginas. Sem barra de abas.
 */

export type TelaClientes = "situacao" | "individual" | "cadastro";
export type TelaPropostas = "painel-propostas" | "lote-propostas" | "proposta-individual";

export default function App() {
  return (
    <SessionProvider>
      <OnboardingProvider>
        <Shell />
      </OnboardingProvider>
    </SessionProvider>
  );
}

function Shell() {
  const { session, carregando } = useSession();
  const { primeiroAcesso, concluirTour } = useOnboarding();
  // Início é a homepage: o operador lê a saúde da esteira e parte para os módulos.
  const [modulo, setModulo] = useState<Modulo>("inicio");
  const [telaClientes, setTelaClientes] = useState<TelaClientes>("situacao");
  const [telaPropostas, setTelaPropostas] = useState<TelaPropostas>("painel-propostas");
  /** Requisições: pendências (aprovador) ou minhas (requisitante). */
  const [telaRequisicoes, setTelaRequisicoes] = useState<TelaRequisicoes>("pendencias");
  /** Pedido do Início (gargalo clicado): fila + convênio — o painel consome e limpa. */
  const [filaExterna, setFilaExterna] = useState<{
    nrStatus: number;
    convenio: number | null;
  } | null>(null);
  /** Tomador da Base enviado para EDIÇÃO no Cadastro Individual. */
  const [clienteEdicao, setClienteEdicao] = useState<ClienteResumo | null>(null);
  /** Tour: null = fechado; o dialog de 1º acesso e o menu de perfil o abrem. */
  const [tourAberto, setTourAberto] = useState(false);
  const [conviteRecusado, setConviteRecusado] = useState(false);

  /** Leva a UI à página de um passo do tour (o tour conduz a navegação). */
  const irParaPaginaTour = (pagina: PaginaTour) => {
    if (pagina === "inicio") setModulo("inicio");
    else if (pagina === "tomadores") {
      setTelaClientes("situacao");
      setModulo("clientes");
    } else {
      setTelaPropostas(pagina);
      setModulo("propostas");
    }
  };

  // Enquanto rehidrata a sessão do cookie, não pisca a tela de login.
  if (carregando) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  if (!session) return <Login />;

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <Topbar
        modulo={modulo}
        onModuloChange={setModulo}
        onRefazerTour={() => setTourAberto(true)}
      />

      <main className="mx-auto w-full max-w-shell flex-1 px-8 py-10">
        {/* Mantém todas montadas: navegar não perde arquivo selecionado,
            base carregada, seleção nem lote em andamento. */}
        <div className={modulo === "inicio" ? undefined : "hidden"}>
          <Inicio
            ativa={modulo === "inicio"}
            onIrClientes={(tela) => {
              setTelaClientes(tela);
              setModulo("clientes");
            }}
            onIrPropostas={(tela) => {
              setTelaPropostas(tela);
              setModulo("propostas");
            }}
            onAbrirFila={(nrStatus, convenio) => {
              setFilaExterna({ nrStatus, convenio });
              setTelaPropostas("painel-propostas");
              setModulo("propostas");
            }}
          />
        </div>
        <div className={modulo === "clientes" && telaClientes === "situacao" ? undefined : "hidden"}>
          <SituacaoClientes
            ativa={modulo === "clientes" && telaClientes === "situacao"}
            onNavegar={setTelaClientes}
            onEditar={(c) => {
              setClienteEdicao(c);
              setTelaClientes("individual");
            }}
          />
        </div>
        <div className={modulo === "clientes" && telaClientes === "individual" ? undefined : "hidden"}>
          <CadastroIndividual
            onVoltar={() => setTelaClientes("situacao")}
            edicao={clienteEdicao}
            onEdicaoConsumida={() => setClienteEdicao(null)}
            onVerRequisicoes={() => {
              // Quem acabou de criar uma requisição quer acompanhá-la.
              setTelaRequisicoes("minhas");
              setModulo("requisicoes");
            }}
          />
        </div>
        <div className={modulo === "requisicoes" ? undefined : "hidden"}>
          <Requisicoes
            ativa={modulo === "requisicoes"}
            tela={telaRequisicoes}
            onTelaChange={setTelaRequisicoes}
          />
        </div>
        <div className={modulo === "clientes" && telaClientes === "cadastro" ? undefined : "hidden"}>
          <CadastroLote onVoltar={() => setTelaClientes("situacao")} />
        </div>
        <div
          className={
            modulo === "propostas" && telaPropostas === "painel-propostas" ? undefined : "hidden"
          }
        >
          <PainelPropostas
            ativa={modulo === "propostas" && telaPropostas === "painel-propostas"}
            onNavegar={setTelaPropostas}
            filaExterna={filaExterna}
            onFilaExternaConsumida={() => setFilaExterna(null)}
          />
        </div>
        <div
          className={
            modulo === "propostas" && telaPropostas === "lote-propostas" ? undefined : "hidden"
          }
        >
          <PropostasLote onVoltar={() => setTelaPropostas("painel-propostas")} />
        </div>
        <div
          className={
            modulo === "propostas" && telaPropostas === "proposta-individual"
              ? undefined
              : "hidden"
          }
        >
          <PropostaIndividual onVoltar={() => setTelaPropostas("painel-propostas")} />
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

      {/* Onboarding: convite de 1º acesso + tour guiado sobre as telas reais. */}
      <PrimeiroAcessoDialog
        aberto={primeiroAcesso && !tourAberto && !conviteRecusado}
        onFazerTour={() => setTourAberto(true)}
        onPular={() => {
          setConviteRecusado(true);
          concluirTour(); // registra que viu — não pergunta de novo
        }}
      />
      <ProductTour
        aberto={tourAberto}
        navegar={irParaPaginaTour}
        onFim={() => {
          setTourAberto(false);
          concluirTour();
        }}
      />

      {/* Checklist de primeiros passos — canto inferior, leva às telas. */}
      {!tourAberto && <ChecklistOnboarding onIr={irParaPaginaTour} />}
    </div>
  );
}
