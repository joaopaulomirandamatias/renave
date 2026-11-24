import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { BrowserRenaveReadiness } from "../App.js";
import { HomologationReadinessPanel } from "./HomologationReadinessPanel.js";

afterEach(cleanup);

const base: BrowserRenaveReadiness = {
  certificate: "ready",
  environment: "homologation",
  establishmentContact: "verified",
  integration: "configured",
  link: "confirmed",
  mutations: "blocked",
  operatorIdentity: "verified",
  queries: "ready",
};

describe("HomologationReadinessPanel", () => {
  it.each([
    ["missing", "blocked", "Cadastro ausente"],
    ["pending", "current", "Aguardando verificação"],
    ["verified", "complete", "Verificação concluída"],
    ["suspended", "blocked", "Acesso suspenso"],
    ["unavailable", "attention", "Indisponível"],
  ] as const)(
    "apresenta o perfil %s com texto e estado semânticos",
    (status, state, label) => {
      render(
        <HomologationReadinessPanel
          readiness={{ ...base, operatorIdentity: status }}
        />,
      );

      const item = screen
        .getByRole("heading", { name: "Identidade do operador" })
        .closest("li");
      expect(item).toHaveAttribute("data-state", state);
      expect(item).toHaveTextContent(label);
    },
  );
});
