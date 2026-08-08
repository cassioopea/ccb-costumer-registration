import { useEffect, useRef, useState } from "react";
import {
  FilePlus2,
  FileSpreadsheet,
  LayoutList,
  ListChecks,
  Loader2,
  RefreshCw,
  Upload,
  UserPlus,
  XCircle,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Combobox } from "@/components/ui/combobox";
import { VisaoGeralEsteira } from "@/components/VisaoGeralEsteira";
import { ValorOriginado } from "@/components/ValorOriginado";
import { VelocidadeEsteira } from "@/components/VelocidadeEsteira";
import { FunilConversao } from "@/components/FunilConversao";
import { Hint } from "@/components/onboarding/Hint";
import { useSession } from "@/lib/session";
import {
  getLookups,
  getVisaoGeralEsteira,
  type LookupOption,
  type VisaoGeralResponse,
} from "@/lib/api";
import { SessaoExpiradaError } from "@/lib/session";
import type { TelaClientes, TelaPropostas } from "@/App";

/**
 * Início — a homepage do sistema: saudação, o dashboard da esteira em quatro
 * camadas (fluxo, valor, velocidade e conversão) sob um filtro GLOBAL de
 * convênio, e os cards de navegação para os módulos.
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

  const [dados, setDados] = useState<VisaoGeralResponse | null>(null);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  /** Filtro GLOBAL do dashboard ("" = todos os convênios). */
  const [convenio, setConvenio] = useState("");
  const [convenios, setConvenios] = useState<LookupOption[]>([]);

  const jaAtivou = useRef(false);
  useEffect(() => {
    if (!ativa || jaAtivou.current) return;
    jaAtivou.current = true;
    void carregar("", false);
    void getLookups(31)
      .then((r) => setConvenios(r.convenios))
      .catch(() => setConvenios([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- só na 1ª ativação
  }, [ativa]);

  async function carregar(convenioAtual?: string, forcar = false) {
    if (carregando) return;
    setCarregando(true);
    setErro(null);
    try {
      const alvo = (convenioAtual ?? convenio).trim();
      const res = await getVisaoGeralEsteira(
        alvo === "" ? undefined : Number(alvo),
        forcar,
      );
      setDados(res);
    } catch (e) {
      if (!(e instanceof SessaoExpiradaError)) setErro((e as Error).message);
    } finally {
      setCarregando(false);
    }
  }

  const trocarConvenio = (novo: string) => {
    setConvenio(novo);
    void carregar(novo, false);
  };

  const convenioNumero = convenio.trim() === "" ? null : Number(convenio);
  const nomeConvenio = convenios.find((c) => String(c.codigo) === convenio)?.descricao;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="mb-3 text-caption text-muted-foreground">{hoje}</div>
          <h1 className="text-display text-foreground">
            Olá, {session?.username ?? "operador"}
          </h1>
          <p className="mt-1 text-body text-muted-foreground">
            A saúde da originação em quatro camadas — fluxo, valor, velocidade e
            conversão.
          </p>
        </div>
        {/* Filtro GLOBAL: governa todos os blocos do dashboard */}
        <div className="flex shrink-0 items-center gap-2">
          <Hint id="filtro_convenio" />
          {convenios.length > 0 && (
            <Combobox
              aria-label="Filtrar o dashboard por convênio"
              value={convenio}
              onChange={trocarConvenio}
              disabled={carregando}
              pesquisavel
              className="w-64"
              options={[
                { value: "", label: "Todos os convênios" },
                ...convenios.map((c) => ({
                  value: String(c.codigo),
                  label: `${c.codigo} — ${c.descricao}`,
                })),
              ]}
            />
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void carregar(undefined, true)}
            disabled={carregando}
            title="Recarrega o dashboard (ignora o cache)"
          >
            {carregando ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
          </Button>
        </div>
      </div>

      {/* Convênio filtrado ganha destaque — todos os números abaixo são só dele */}
      {convenio && (
        <div className="inline-flex max-w-full items-center gap-2 rounded-lg border border-primary/30 bg-accent px-3 py-1.5">
          <span className="text-caption font-medium uppercase tracking-label text-muted-foreground">
            Convênio
          </span>
          <span className="truncate text-subheading text-accent-foreground">
            <span className="tabular-nums">{convenio}</span>
            {nomeConvenio ? ` — ${nomeConvenio}` : ""}
          </span>
          <button
            type="button"
            onClick={() => trocarConvenio("")}
            title="Limpar o filtro de convênio"
            className="focus-ring text-muted-foreground hover:text-foreground"
          >
            <XCircle className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Camada 1 — fluxo (operacional) */}
      <VisaoGeralEsteira
        dados={dados}
        erro={erro}
        onAbrirFila={(nrStatus) => onAbrirFila(nrStatus, convenioNumero)}
      />

      {/* Camada 2 — valor */}
      {dados && <ValorOriginado valor={dados.valor} />}

      {/* Camadas 3 e 4 — velocidade e conversão, lado a lado */}
      {dados && (
        <div className="grid items-start gap-6 lg:grid-cols-2">
          <VelocidadeEsteira velocidade={dados.velocidade} />
          <FunilConversao funil={dados.funil} convenioFiltrado={convenioNumero !== null} />
        </div>
      )}

      {/* Navegação para os módulos — chega-se às telas a partir daqui */}
      <div className="grid items-stretch gap-6 lg:grid-cols-2">
        <Card className="reveal reveal-delay-3">
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

        <Card className="reveal reveal-delay-4">
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
