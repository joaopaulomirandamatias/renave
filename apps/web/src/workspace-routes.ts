export type WorkspaceRoute =
  "dashboard" | "stock" | "stock-entry" | "compliance" | "establishments";

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
  return routes.get(pathname);
}
