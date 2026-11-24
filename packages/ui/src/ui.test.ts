import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  APP_ENVIRONMENT_LABELS,
  resolveAppEnvironment,
} from "./EnvironmentBadge.js";
import { RENAVE_STOCK_STATE_LABELS } from "./StockStateBadge.js";

const currentDir = dirname(fileURLToPath(import.meta.url));
const tokensCss = readFileSync(resolve(currentDir, "tokens.css"), "utf8");
const componentsCss = readFileSync(
  resolve(currentDir, "components.css"),
  "utf8",
);

describe("@seu-renave/ui tokens e contratos", () => {
  it("mantem os tokens oficiais de marca, foco visivel e alvo minimo de 44px sem fontes por CDN", () => {
    expect(tokensCss).toContain("--sr-color-brand: #067a45;");
    expect(tokensCss).toContain("--sr-color-navy: #0b2550;");
    expect(tokensCss).toContain("--sr-color-amber: #f2a90c;");
    expect(tokensCss).toContain("--sr-touch-target-min: 2.75rem;");
    expect(tokensCss).toContain(":focus-visible");
    expect(tokensCss).toContain("prefers-reduced-motion: reduce");

    expect(tokensCss).not.toMatch(/https?:\/\//i);
    expect(componentsCss).not.toMatch(/https?:\/\//i);
    expect(tokensCss).not.toContain("@font-face");
    expect(componentsCss).not.toContain("@font-face");
  });

  it("usa ambar apenas de forma decorativa e garante alvos >= 44px e foco visivel em botoes", () => {
    const amberUsages = componentsCss.match(/--sr-color-amber/g) ?? [];
    expect(amberUsages.length).toBeLessThanOrEqual(1);
    expect(componentsCss).not.toMatch(/color:\s*var\(--sr-color-amber\)/);
    expect(componentsCss).toContain("min-height: var(--sr-touch-target-min);");
    expect(componentsCss).toContain("min-width: var(--sr-touch-target-min);");
    expect(componentsCss).toContain(".sr-button:focus-visible");
  });

  it("normaliza o ambiente com fallback seguro para desenvolvimento", () => {
    expect(APP_ENVIRONMENT_LABELS).toEqual({
      development: "Desenvolvimento",
      homologation: "Homologação",
      production: "Produção",
    });
    expect(resolveAppEnvironment("production")).toBe("production");
    expect(resolveAppEnvironment("  HOMOLOGATION ")).toBe("homologation");
    expect(resolveAppEnvironment("development")).toBe("development");
    expect(resolveAppEnvironment("staging")).toBe("development");
    expect(resolveAppEnvironment(undefined)).toBe("development");
  });

  it("mantem o shell responsivo com salto de conteudo e alvos de toque", () => {
    expect(componentsCss).toContain(".sr-app-shell__skip");
    expect(componentsCss).toContain(".sr-app-shell__skip:focus");
    expect(componentsCss).toContain(
      ".sr-app-shell__navigation-link:focus-visible",
    );
    expect(componentsCss).toMatch(
      /\.sr-app-shell__navigation-link\s*\{[^}]*min-height:\s*var\(--sr-touch-target-min\)/s,
    );
    expect(componentsCss).toContain("@media (max-width: 52rem)");
    expect(componentsCss).toContain("@media (max-width: 36rem)");
  });

  it("traduz TRANSFERIDO como etapa intermediaria aguardando novo CRV", () => {
    expect(RENAVE_STOCK_STATE_LABELS).toEqual({
      SOLICITADO: "Entrada solicitada · aguardando transferência",
      TRANSFERIDO: "Propriedade transferida · aguardando novo CRV",
      CONFIRMADO: "Em estoque",
      FINALIZADO: "Baixado",
    });
    expect(componentsCss).toContain(".sr-stock-state--warning");
    expect(componentsCss).not.toMatch(/color:\s*var\(--sr-color-amber\)/);
  });
});
