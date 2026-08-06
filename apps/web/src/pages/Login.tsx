import { useState } from "react";
import { AlertTriangle, Eye, EyeOff, Loader2, Lock, User, XCircle } from "lucide-react";
import { OpeaLogo } from "@/components/OpeaLogo";
import { IS_PROD } from "@/components/Topbar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { useSession } from "@/lib/session";

/**
 * Tela de login.
 *
 * Layout de duas colunas espelhando o Internet Banking da Opea, com o azul
 * deste sistema. Diferenças deliberadas em relação ao IB:
 *  - sem indicador "ETAPA 1 DE 3": aqui o login é etapa única, e um contador
 *    falso enganaria o operador;
 *  - campo é USUÁRIO, não CPF/CNPJ — o login da Sinqia é Basic auth;
 *  - sem "Esqueci minha senha"/"Solicite credenciais": seriam links mortos,
 *    a credencial vem da Sinqia/BRQ;
 *  - painel esquerdo é gradiente da marca (não há asset de imagem no repo).
 */
export function Login() {
  const { entrar } = useSession();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [verSenha, setVerSenha] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const podeEntrar = !!username.trim() && !!password && !enviando;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!podeEntrar) return;
    setErro(null);
    setEnviando(true);
    try {
      await entrar(username.trim(), password);
      // Sucesso: o App troca de tela. Limpa a senha do estado por higiene.
      setPassword("");
    } catch (e) {
      setErro((e as Error).message);
    } finally {
      setEnviando(false);
    }
  }

  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      {/* Painel da marca */}
      <div
        className="relative hidden flex-col justify-between p-10 lg:flex"
        style={{
          background:
            "linear-gradient(145deg, var(--wine-900) 0%, var(--wine-700) 55%, var(--wine-600) 100%)",
        }}
      >
        <OpeaLogo className="h-7 w-auto text-[var(--sidebar-foreground)]" />

        <div className="max-w-lg space-y-5 text-[var(--sidebar-foreground)]">
          <span
            className={cn(
              "inline-flex items-center gap-2 rounded-full border px-3 py-1 text-caption font-medium uppercase tracking-wider",
              IS_PROD
                ? "border-[var(--destructive)] bg-[var(--destructive)]/25"
                : "border-white/20 bg-white/10",
            )}
          >
            <span
              className={cn(
                "size-1.5 rounded-full",
                IS_PROD ? "bg-[var(--destructive)]" : "bg-[var(--success)]",
              )}
            />
            {IS_PROD ? "Produção" : "Homologação"}
          </span>

          <h1 className="text-display font-bold tracking-tight">
            Esteira de Originação
          </h1>
          <p className="text-body text-[var(--sidebar-foreground)]/75">
            Importe ou inclua novos tomadores, gerencie a situação dos cadastros e gere novas propostas.
          </p>
        </div>

        <p className="text-caption text-[var(--sidebar-foreground)]/55">
          © 2026 Opea SCD · Sociedade de Crédito Direto
        </p>
      </div>

      {/* Formulário */}
      <div className="flex items-center justify-center bg-background px-6 py-12">
        <div className="w-full max-w-sm space-y-8">
          <OpeaLogo className="h-7 w-auto text-[var(--primary)] lg:hidden" />

          <div className="space-y-2">
            <h2 className="text-title text-foreground">Entrar na Sinqia</h2>
            <p className="text-label text-muted-foreground">
              Use seu usuário e senha da Sinqia (BJ21M05). Requer a VPN da Opea ativa.
            </p>
          </div>

          {/* Em telas pequenas o painel da marca não aparece — o aviso de
              ambiente precisa existir aqui também, antes de digitar a senha. */}
          {IS_PROD && (
            <div className="flex items-center gap-2 rounded-lg border border-[var(--destructive)] bg-[var(--destructive)]/10 px-3 py-2 text-label font-medium text-[var(--destructive)] lg:hidden">
              <AlertTriangle className="h-4 w-4" />
              Ambiente de PRODUÇÃO
            </div>
          )}

          <form onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="login-user">Usuário</Label>
              <div className="relative">
                <User className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="login-user"
                  autoComplete="username"
                  autoFocus
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="usuário da Sinqia"
                  className="pl-9"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="login-pass">Senha</Label>
              <div className="relative">
                <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="login-pass"
                  type={verSenha ? "text" : "password"}
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="pl-9 pr-10"
                />
                <button
                  type="button"
                  onClick={() => setVerSenha((v) => !v)}
                  aria-label={verSenha ? "Ocultar senha" : "Mostrar senha"}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  {verSenha ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            {erro && (
              <div className="flex items-start gap-2 rounded-lg border border-[var(--destructive)] bg-[var(--destructive)]/10 px-3 py-2 text-label text-[var(--destructive)]">
                <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{erro}</span>
              </div>
            )}

            <Button type="submit" disabled={!podeEntrar} className="w-full">
              {enviando && <Loader2 className="h-4 w-4 animate-spin" />}
              Entrar
            </Button>
          </form>

          <p className="text-caption text-muted-foreground">
            A senha é usada apenas para obter o token da Sinqia e é descartada em seguida — não
            fica gravada em disco, log ou código.
          </p>
        </div>
      </div>
    </div>
  );
}
