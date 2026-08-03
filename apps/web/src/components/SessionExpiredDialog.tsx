import { useState } from "react";
import { Eye, EyeOff, Loader2, Lock, XCircle } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useSession } from "@/lib/session";

/**
 * Reautenticação com um campo só.
 *
 * O usuário já é conhecido; pedimos apenas a senha. É o que mantém o ganho de
 * "não redigitar credencial" sem guardar senha em lugar nenhum: ao expirar, o
 * operador confirma a senha e continua de onde estava — o arquivo selecionado,
 * a base de clientes carregada e a seleção acumulada permanecem intactos.
 */
export function SessionExpiredDialog() {
  const { session, expiradaMotivo, reautenticar, dispensarExpiracao } = useSession();

  const [password, setPassword] = useState("");
  const [verSenha, setVerSenha] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const aberto = !!expiradaMotivo && !!session;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!password || enviando) return;
    setErro(null);
    setEnviando(true);
    try {
      await reautenticar(password);
      setPassword("");
    } catch (e) {
      setErro((e as Error).message);
    } finally {
      setEnviando(false);
    }
  }

  return (
    <Dialog
      open={aberto}
      onOpenChange={(open) => {
        if (!open) {
          setPassword("");
          setErro(null);
          dispensarExpiracao();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Sessão expirada</DialogTitle>
          <DialogDescription>
            {expiradaMotivo} Confirme a senha de <strong>{session?.username}</strong> para
            continuar de onde parou — nada do que está na tela é perdido.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="reauth-pass">Senha</Label>
            <div className="relative">
              <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="reauth-pass"
                type={verSenha ? "text" : "password"}
                autoComplete="current-password"
                autoFocus
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

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setPassword("");
                setErro(null);
                dispensarExpiracao();
              }}
            >
              Sair
            </Button>
            <Button type="submit" disabled={!password || enviando}>
              {enviando && <Loader2 className="h-4 w-4 animate-spin" />}
              Reconectar
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
