import { describe, expect, it } from "vitest";

import { InMemorySessionStore } from "../src/memory-store.js";
import { createIdentityService } from "../src/service.js";
import { fakeOidc, manualClock, testConfig } from "./helpers.js";

function setup(config = testConfig()) {
  const oidc = fakeOidc();
  const clock = manualClock();
  const store = new InMemorySessionStore({ environment: "test" });
  const service = createIdentityService({
    oidc,
    store,
    config,
    clock,
  });
  return { clock, oidc, service, store };
}

async function startAndAuthorize(value = "/painel", config = testConfig()) {
  const context = setup(config);
  const started = await context.service.startLogin({ returnTo: value });
  const callback = context.oidc.authorize(started.authorizationUrl);
  return { ...context, callback, started };
}

describe("IdentityService", () => {
  it("conclui PKCE, conserva subject interno e higieniza returnTo", async () => {
    const { callback, oidc, service, started } =
      await startAndAuthorize("https://evil.test/");
    const result = await service.completeLogin({
      ...callback,
      bindingSecret: started.bindingSecret,
    });
    expect(result).toMatchObject({ ok: true, returnTo: "/" });
    expect(oidc.exchanges[0]?.codeVerifier).toHaveLength(86);
    if (!result.ok) throw new Error("login deveria ter sucesso");
    await expect(service.getSession(result.sessionId)).resolves.toMatchObject({
      subject: "subject-1",
      name: "Maria Operadora",
      roles: ["idp-role"],
    });
  });

  it("consome state antes do binding e impede replay", async () => {
    const { callback, service, started } = await startAndAuthorize();
    await expect(
      service.completeLogin({ ...callback, bindingSecret: "wrong" }),
    ).resolves.toEqual({ ok: false, reason: "binding_mismatch" });
    await expect(
      service.completeLogin({
        ...callback,
        bindingSecret: started.bindingSecret,
      }),
    ).resolves.toEqual({ ok: false, reason: "invalid_state" });
  });

  it("recusa nonce divergente e erro do provedor", async () => {
    const mismatch = await startAndAuthorize();
    mismatch.oidc.forceNonce("injected");
    await expect(
      mismatch.service.completeLogin({
        ...mismatch.callback,
        bindingSecret: mismatch.started.bindingSecret,
      }),
    ).resolves.toEqual({ ok: false, reason: "nonce_mismatch" });

    const denied = await startAndAuthorize();
    await expect(
      denied.service.completeLogin({
        ...denied.callback,
        providerError: "access_denied",
        bindingSecret: denied.started.bindingSecret,
      }),
    ).resolves.toEqual({ ok: false, reason: "provider_error" });
  });

  it("rotaciona sessão anterior, expira por idle e faz logout", async () => {
    const first = await startAndAuthorize();
    const login = await first.service.completeLogin({
      ...first.callback,
      bindingSecret: first.started.bindingSecret,
    });
    if (!login.ok) throw new Error("login deveria ter sucesso");
    first.clock.advance(1_000);
    const secondStart = await first.service.startLogin({ returnTo: "/" });
    const secondCallback = first.oidc.authorize(secondStart.authorizationUrl);
    const second = await first.service.completeLogin({
      ...secondCallback,
      bindingSecret: secondStart.bindingSecret,
      previousSessionId: login.sessionId,
    });
    if (!second.ok) throw new Error("rotação deveria ter sucesso");
    await expect(
      first.service.getSession(login.sessionId),
    ).resolves.toBeUndefined();

    first.clock.advance(1_800_001);
    await expect(
      first.service.getSession(second.sessionId),
    ).resolves.toBeUndefined();

    await first.service.logout(second.sessionId);
    await expect(
      first.service.getSession(second.sessionId),
    ).resolves.toBeUndefined();
  });

  it("nunca renova a sessão além do teto absoluto", async () => {
    const context = await startAndAuthorize(
      "/",
      testConfig({
        sessionIdleTtlSeconds: 300,
        sessionAbsoluteTtlSeconds: 300,
      }),
    );
    const login = await context.service.completeLogin({
      ...context.callback,
      bindingSecret: context.started.bindingSecret,
    });
    if (!login.ok) throw new Error("login deveria ter sucesso");
    context.clock.advance(299_000);
    await expect(
      context.service.getSession(login.sessionId),
    ).resolves.toMatchObject({
      expiresAt: 1_700_000_300_000,
    });
    context.clock.advance(1_000);
    await expect(
      context.service.getSession(login.sessionId),
    ).resolves.toBeUndefined();
  });
});
