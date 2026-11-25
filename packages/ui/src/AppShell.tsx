import { useId, type ChangeEvent, type ReactNode } from "react";

import type { AppEnvironment } from "./EnvironmentBadge.js";
import { EnvironmentBadge } from "./EnvironmentBadge.js";
import { BrandLogo } from "./BrandLogo.js";
import { cx } from "./cx.js";

export interface AppShellNavigationItem {
  current?: boolean;
  href: string;
  icon?: ReactNode;
  id: string;
  label: string;
}

export interface AppShellEstablishment {
  id: string;
  label: string;
}

export interface AppShellProps {
  children: ReactNode;
  environment: AppEnvironment;
  establishments: readonly AppShellEstablishment[];
  navigation: readonly AppShellNavigationItem[];
  onEstablishmentChange?: (establishmentId: string) => void;
  selectedEstablishmentId?: string;
  sidebarFooter?: ReactNode;
  userMenu?: ReactNode;
  workspaceLabel?: string;
}

export function AppShell({
  children,
  environment,
  establishments,
  navigation,
  onEstablishmentChange,
  selectedEstablishmentId,
  sidebarFooter,
  userMenu,
  workspaceLabel = "Operação RENAVE",
}: AppShellProps) {
  const generatedId = useId();
  const contentId = `sr-main-${generatedId}`;
  const establishmentSelectId = `sr-establishment-${generatedId}`;
  const selectedExists = establishments.some(
    (establishment) => establishment.id === selectedEstablishmentId,
  );
  const activeEstablishmentId =
    (selectedExists ? selectedEstablishmentId : establishments[0]?.id) ?? "";

  function handleEstablishmentChange(event: ChangeEvent<HTMLSelectElement>) {
    onEstablishmentChange?.(event.currentTarget.value);
  }

  return (
    <div className="sr-app-shell">
      <a className="sr-app-shell__skip" href={`#${contentId}`}>
        Ir para o conteúdo principal
      </a>

      <aside className="sr-app-shell__sidebar" aria-label="Navegação principal">
        <div className="sr-app-shell__brand">
          <BrandLogo compact />
          <span className="sr-app-shell__brand-copy">
            <span className="sr-app-shell__brand-title" aria-hidden="true">
              <span>Renav</span>
              <strong>Estoque</strong>
            </span>
            <span className="sr-app-shell__brand-subtitle">
              {workspaceLabel}
            </span>
          </span>
        </div>

        <nav aria-label="Seções da aplicação">
          <ul className="sr-app-shell__navigation">
            {navigation.map((item) => (
              <li key={item.id}>
                <a
                  className={cx(
                    "sr-app-shell__navigation-link",
                    item.current && "sr-app-shell__navigation-link--current",
                  )}
                  href={item.href}
                  aria-current={item.current ? "page" : undefined}
                >
                  {item.icon ? (
                    <span
                      className="sr-app-shell__navigation-icon"
                      aria-hidden="true"
                    >
                      {item.icon}
                    </span>
                  ) : null}
                  <span>{item.label}</span>
                </a>
              </li>
            ))}
          </ul>
        </nav>

        {sidebarFooter ? (
          <div className="sr-app-shell__sidebar-footer">{sidebarFooter}</div>
        ) : null}
      </aside>

      <header className="sr-app-shell__topbar">
        <div className="sr-app-shell__establishment">
          <label className="sr-only" htmlFor={establishmentSelectId}>
            Estabelecimento ativo
          </label>
          <div className="sr-app-shell__establishment-control">
            <svg
              className="sr-app-shell__establishment-icon"
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M3 21h18M5 21V7l7-4 7 4v14M9 21v-6h6v6" />
            </svg>
            <select
              id={establishmentSelectId}
              value={activeEstablishmentId}
              onChange={handleEstablishmentChange}
              disabled={establishments.length === 0 || !onEstablishmentChange}
            >
              {establishments.length === 0 ? (
                <option value="">Nenhum estabelecimento disponível</option>
              ) : null}
              {establishments.map((establishment) => (
                <option key={establishment.id} value={establishment.id}>
                  {establishment.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="sr-app-shell__context">
          <EnvironmentBadge environment={environment} />
          {userMenu}
        </div>
      </header>

      <main id={contentId} className="sr-app-shell__content" tabIndex={-1}>
        {children}
      </main>
    </div>
  );
}
