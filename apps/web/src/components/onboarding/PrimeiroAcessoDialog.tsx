import { Compass } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

/**
 * Convite de primeiro acesso: oferece o tour guiado. "Pular" registra que o
 * usuário viu (não pergunta de novo), mas o tour pode ser refeito pelo menu.
 */
export function PrimeiroAcessoDialog({
  aberto,
  onFazerTour,
  onPular,
}: {
  aberto: boolean;
  onFazerTour: () => void;
  onPular: () => void;
}) {
  return (
    <Dialog open={aberto} onOpenChange={(o) => !o && onPular()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Compass className="h-5 w-5 text-primary" />
            É o seu primeiro acesso?
          </DialogTitle>
          <DialogDescription>
            Posso te dar um tour guiado de ~2 minutos pelas telas, explicando como o
            Backoffice agiliza a emissão de uma CCB de ponta a ponta. Dá para pular e refazer
            depois pelo menu do seu perfil.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onPular}>
            Pular por enquanto
          </Button>
          <Button onClick={onFazerTour}>
            <Compass className="h-4 w-4" />
            Fazer o tour
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
