/**
 * Breadcrumb das páginas — nas sub-páginas, o segmento da página principal é
 * clicável e é O caminho de volta (a navegação não tem mais barra de abas).
 */
export function Breadcrumb({
  paginaPrincipal,
  onVoltar,
  atual,
}: {
  paginaPrincipal: string;
  /** Presente = sub-página; o clique volta à página principal do módulo. */
  onVoltar?: () => void;
  atual: string;
}) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-1.5 text-caption text-muted-foreground">
      <span>Backoffice de Originação</span>
      <span aria-hidden>›</span>
      {onVoltar ? (
        <button
          type="button"
          onClick={onVoltar}
          className="focus-ring font-medium text-primary underline-offset-2 hover:underline"
        >
          {paginaPrincipal}
        </button>
      ) : (
        <span>{paginaPrincipal}</span>
      )}
      <span aria-hidden>›</span>
      <span>{atual}</span>
    </div>
  );
}
