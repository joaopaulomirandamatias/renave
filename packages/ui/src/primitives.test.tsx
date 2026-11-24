import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { describe, expect, it } from "vitest";

import { Card } from "./Card.js";
import { EmptyState } from "./EmptyState.js";
import { PageHeader } from "./PageHeader.js";
import { StatusBadge } from "./StatusBadge.js";

const currentDir = dirname(fileURLToPath(import.meta.url));
const componentsCss = readFileSync(
  resolve(currentDir, "components.css"),
  "utf8",
);

type ElementProps = Record<string, unknown> & { children?: ReactNode };

function propsOf(element: ReactElement): ElementProps {
  return element.props as ElementProps;
}

function findElement(node: ReactNode, type: string): ReactElement | undefined {
  for (const child of Children.toArray(node)) {
    if (!isValidElement(child)) continue;
    if (child.type === type) return child;
    const nested = findElement(propsOf(child).children, type);
    if (nested) return nested;
  }
  return undefined;
}

describe("primitivas acessiveis do design system", () => {
  it("estrutura PageHeader com titulo hierarquico e icone decorativo", () => {
    const header = PageHeader({
      actions: <button type="button">Nova operação</button>,
      eyebrow: "Operação",
      icon: <svg data-testid="icon" />,
      title: "Estoque",
    });

    expect(header.type).toBe("header");
    expect(findElement(header, "h1")).toBeDefined();
    expect(propsOf(findElement(header, "h1")!).children).toBe("Estoque");
    expect(propsOf(findElement(header, "span")!)["aria-hidden"]).toBe("true");
    expect(findElement(header, "button")).toBeDefined();
  });

  it("usa artigo como Card padrao e permite secao com nivel de titulo explicito", () => {
    const article = Card({ children: "Conteúdo", title: "Resumo" });
    const section = Card({
      "aria-label": "Indicadores",
      as: "section",
      headingLevel: 3,
      title: "Indicadores",
      variant: "subtle",
    });

    expect(article.type).toBe("article");
    expect(findElement(article, "h2")).toBeDefined();
    expect(findElement(article, "div")).toBeDefined();
    expect(section.type).toBe("section");
    expect(propsOf(section)["aria-label"]).toBe("Indicadores");
    expect(propsOf(section).className).toContain("sr-card--subtle");
    expect(findElement(section, "h3")).toBeDefined();
  });

  it("mantem StatusBadge estatico por padrao e permite anuncio explicito", () => {
    const badge = StatusBadge({
      children: "Concluído",
      icon: <svg data-testid="icon" />,
      tone: "success",
    });
    const liveBadge = StatusBadge({
      children: "Processando",
      role: "status",
    });

    expect(badge.type).toBe("span");
    expect(propsOf(badge).role).toBeUndefined();
    expect(propsOf(liveBadge).role).toBe("status");
    expect(propsOf(badge)["data-tone"]).toBe("success");
    expect(
      propsOf(findElement(propsOf(badge).children, "span")!)["aria-hidden"],
    ).toBe("true");
  });

  it("nomeia EmptyState pelo titulo e preserva uma acao sem inventar role de alerta", () => {
    const empty = EmptyState({
      actions: <a href="/novo">Criar registro</a>,
      description: "Ainda não há registros nesta lista.",
      icon: <svg data-testid="icon" />,
      title: "Nenhum registro",
    });

    expect(empty.type).toBe("section");
    expect(propsOf(empty)["aria-label"]).toBe("Nenhum registro");
    expect(propsOf(empty).role).toBeUndefined();
    expect(findElement(empty, "h2")).toBeDefined();
    expect(findElement(empty, "a")).toBeDefined();
  });

  it("estiliza as novas primitivas somente com tokens locais", () => {
    const primitivesCss =
      componentsCss.split("/* PageHeader */")[1]?.split("/* AppShell */")[0] ??
      "";

    expect(primitivesCss).toContain(".sr-page-header");
    expect(primitivesCss).toContain(".sr-card");
    expect(primitivesCss).toContain(".sr-status-badge");
    expect(primitivesCss).toContain(".sr-empty-state");
    expect(primitivesCss).toContain("var(--sr-color-surface)");
    expect(primitivesCss).not.toMatch(/#[0-9a-f]{3,8}/i);
    expect(primitivesCss).not.toMatch(/https?:\/\//i);
  });
});
