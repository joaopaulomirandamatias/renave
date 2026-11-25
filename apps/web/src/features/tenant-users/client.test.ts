import { describe, expect, it, vi } from "vitest";

import {
  createTenantUsersClient,
  parseTenantUsersResponse,
  TenantUsersClientError,
} from "./client.js";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const MEMBER_ID = "33333333-3333-5333-8333-333333333333";
const ESTABLISHMENT_ID = "22222222-2222-4222-8222-222222222222";

function validUser(overrides: Record<string, unknown> = {}) {
  return {
    active: true,
    createdAt: "2026-11-24T15:00:00.000Z",
    establishmentIds: [ESTABLISHMENT_ID],
    memberId: MEMBER_ID,
    role: "renave_operator",
    status: "active",
    ...overrides,
  };
}

describe("tenant users client", () => {
  it("carrega usuários administrativos com parser allowlist estrito", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ items: [validUser()] }), { status: 200 }),
    );

    const client = createTenantUsersClient(fetchMock);
    const result = await client.loadUsers({
      tenantId: TENANT_ID.toUpperCase(),
    });

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/tenants/${TENANT_ID}/users`,
      expect.objectContaining({
        cache: "no-store",
        credentials: "same-origin",
        method: "GET",
        redirect: "error",
      }),
    );
    expect(result).toEqual({
      items: [validUser()],
      status: "ready",
    });
  });

  it("distingue MFA pendente de acesso negado em 403/404", async () => {
    const mfaFetch = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ code: "MFA_REQUIRED" }), { status: 403 }),
    );
    await expect(
      createTenantUsersClient(mfaFetch).loadUsers({ tenantId: TENANT_ID }),
    ).resolves.toEqual({ reason: "mfa_required", status: "denied" });

    const forbiddenFetch = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ code: "TENANT_RESOURCE_NOT_FOUND" }), {
          status: 404,
        }),
    );
    await expect(
      createTenantUsersClient(forbiddenFetch).loadUsers({
        tenantId: TENANT_ID,
      }),
    ).resolves.toEqual({ reason: "forbidden", status: "denied" });
  });

  it("rejeita campos sensíveis ou inesperados em modo fail-closed", () => {
    expect(() =>
      parseTenantUsersResponse({
        items: [validUser({ subject: "oidc|12345" })],
      }),
    ).toThrow();

    expect(() =>
      parseTenantUsersResponse({
        items: [validUser({ subject_hash: "abcdef" })],
      }),
    ).toThrow();

    expect(() =>
      parseTenantUsersResponse({
        items: [validUser({ active: false, status: "active" })],
      }),
    ).toThrow();

    expect(() =>
      parseTenantUsersResponse({
        extra: true,
        items: [],
      }),
    ).toThrow();
  });

  it("lança TenantUsersClientError em erro 503 ou payload inválido", async () => {
    const unavailableFetch = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ code: "TENANT_DIRECTORY_UNAVAILABLE" }), {
          status: 503,
        }),
    );
    await expect(
      createTenantUsersClient(unavailableFetch).loadUsers({
        tenantId: TENANT_ID,
      }),
    ).rejects.toMatchObject({
      code: "TENANT_DIRECTORY_UNAVAILABLE",
      status: 503,
    });

    const malformedFetch = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({ items: [validUser({ email: "vazou@corp.com" })] }),
          { status: 200 },
        ),
    );
    await expect(
      createTenantUsersClient(malformedFetch).loadUsers({
        tenantId: TENANT_ID,
      }),
    ).rejects.toBeInstanceOf(TenantUsersClientError);
  });
});
