import { describe, expect, it } from "vitest";

import {
  resolvePendingOperationId,
  resolveWorkspaceRoute,
} from "./workspace-routes.js";

const operationId = "abcdefab-cdef-4abc-8def-abcdefabcdef";

describe("workspace routes", () => {
  it("publica fila e detalhe somente em caminhos exatos", () => {
    expect(resolveWorkspaceRoute("/pendencias")).toBe("pending");
    expect(resolveWorkspaceRoute(`/pendencias/${operationId}`)).toBe(
      "pending-detail",
    );
    expect(resolvePendingOperationId(`/pendencias/${operationId}`)).toBe(
      operationId,
    );
  });

  it.each([
    `/pendencias/${operationId.toUpperCase()}`,
    `/pendencias/${operationId}/eventos`,
    "/pendencias/nao-e-uuid",
    "/pendencias/",
  ])("mantém caminho não canônico fora do workspace: %s", (pathname) => {
    expect(resolveWorkspaceRoute(pathname)).toBeUndefined();
    expect(resolvePendingOperationId(pathname)).toBeUndefined();
  });
});
