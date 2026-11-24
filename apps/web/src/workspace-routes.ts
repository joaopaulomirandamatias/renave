export type WorkspaceRoute =
  | "dashboard"
  | "stock"
  | "stock-detail"
  | "stock-entry"
  | "compliance"
  | "establishments";

export interface WorkspaceNavigationDefinition {
  href: string;
  id: WorkspaceRoute;
  label: string;
}

export const workspaceNavigation = [
  { href: "/painel", id: "dashboard", label: "Painel" },
  { href: "/estoque", id: "stock", label: "Estoque" },
  { href: "/estoque/entrada", id: "stock-entry", label: "Entradas" },
  { href: "/compliance", id: "compliance", label: "Compliance" },
  {
    href: "/configuracoes/estabelecimentos",
    id: "establishments",
    label: "Estabelecimentos & Certificados",
  },
] as const satisfies readonly WorkspaceNavigationDefinition[];

const routes = new Map<string, WorkspaceRoute>([
  ["/", "dashboard"],
  ...workspaceNavigation.map(({ href, id }) => [href, id] as const),
]);

/** Resolve somente caminhos publicados; não aceita prefixos nem fallback. */
export function resolveWorkspaceRoute(
  pathname: string,
): WorkspaceRoute | undefined {
  if (resolveStockDetailId(pathname) !== undefined) return "stock-detail";
  return routes.get(pathname);
}

const stockDetailPath = /^\/estoque\/([1-9]\d{0,15})$/u;

/** Extrai somente um ID inteiro positivo e seguro de uma rota canônica. */
export function resolveStockDetailId(pathname: string): number | undefined {
  const match = stockDetailPath.exec(pathname);
  if (!match?.[1]) return undefined;
  const stockId = Number(match[1]);
  return Number.isSafeInteger(stockId) ? stockId : undefined;
}
