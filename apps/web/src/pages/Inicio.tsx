import {
  FilePlus2,
  FileSpreadsheet,
  LayoutList,
  ListChecks,
  Upload,
  UserPlus,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { VisaoGeralEsteira } from "@/components/VisaoGeralEsteira";
import { useSession } from "@/lib/session";
import type { TelaClientes, TelaPropostas } from "@/App";

/**
 * Início — a homepage do sistema: saudação, o dashboard da esteira (Visão
 * geral) e os cards de navegação para os módulos. O operador lê a saúde da
 * operação aqui e parte para a tela certa.
 */
export function Inicio({
  ativa,
  onIrClientes,
  onIrPropostas,
  onAbrirFila,
}: {
  ativa: boolean;
  onIrClientes: (tela: TelaClientes) => void;
  onIrPropostas: (tela: TelaPropostas) => void;
  /** Gargalo clicado na Visão geral → abre a fila no Painel, com o convênio junto. */
  onAbrirFila: (nrStatus: number, convenio: number | null) => void;
}) {
  const { session } = useSession();
  const hoje = new Date().toLocaleDateString("pt-BR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  return (
    <div className="space-y-6">
      <div>
        <div className="mb-3 text-caption text-muted-foreground">{hoje}</div>
        <h1 className="text-display text-foreground">
          Olá, {session?.username ?? "operador"}
        </h1>
        <p className="mt-1 text-body text-muted-foreground">
          A saúde da originação em um olhar — e os caminhos para agir.
        </p>
      </div>

      <VisaoGeralEsteira ativa={ativa} onAbrirFila={onAbrirFila} />

      {/* Navegação para os módulos — chega-se às telas a partir daqui */}
      <div className="grid items-stretch gap-6 lg:grid-cols-2">
        <Card className="reveal reveal-delay-2">
          <CardHeader>
            <CardTitle>Propostas</CardTitle>
            <CardDescription>
              Acompanhe a esteira fila a fila, mova propostas conforme o workflow e crie
              novas — em lote a partir do Emissoes.xlsx ou uma a uma.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            <Button onClick={() => onIrPropostas("painel-propostas")}>
              <LayoutList className="h-4 w-4" />
              Painel de propostas
            </Button>
            <Button variant="outline" onClick={() => onIrPropostas("lote-propostas")}>
              <FileSpreadsheet className="h-4 w-4" />
              Lote de propostas
            </Button>
            <Button variant="outline" onClick={() => onIrPropostas("proposta-individual")}>
              <FilePlus2 className="h-4 w-4" />
              Proposta individual
            </Button>
          </CardContent>
        </Card>

        <Card className="reveal reveal-delay-3">
          <CardHeader>
            <CardTitle>Tomadores</CardTitle>
            <CardDescription>
              Consulte a base de tomadores, edite cadastros, altere situações e cadastre
              novos — individualmente ou por arquivo.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            <Button onClick={() => onIrClientes("situacao")}>
              <ListChecks className="h-4 w-4" />
              Base de tomadores
            </Button>
            <Button variant="outline" onClick={() => onIrClientes("individual")}>
              <UserPlus className="h-4 w-4" />
              Cadastro individual
            </Button>
            <Button variant="outline" onClick={() => onIrClientes("cadastro")}>
              <Upload className="h-4 w-4" />
              Cadastro em lote
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
