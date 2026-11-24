import { describe, expect, it } from "vitest";

import { InMemorySessionStore } from "../src/memory-store.js";
import { createIdentityService } from "../src/service.js";
import { fakeOidc, manualClock, testConfig } from "./helpers.js";
import type { VerifiedIdentity } from "../src/ports.js";

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

async function startAndAuthorize(
  value = "/painel",
  config = testConfig(),
  identity: Partial<VerifiedIdentity> = {},
) {
  const context = setup(config);
  const started = await context.service.startLogin({ returnTo: value });
  const callback = context.oidc.authorize(started.authorizationUrl, identity);
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
      mfaVerified: false,
      subject: "subject-1",
      name: "Maria Operadora",
      roles: ["idp-role"],
    });
  });

  it("reavalia o acr assinado pela política atual sem expor o contexto", async () => {
    const config = testConfig({
      mfaAcceptedAcrValues: ["urn:example:loa:2"],
    });
    const context = await startAndAuthorize("/", config, {
      authenticationContext: "urn:example:loa:2",
    });
    const login = await context.service.completeLogin({
      ...context.callback,
      bindingSecret: context.started.bindingSecret,
    });
    if (!login.ok) throw new Error("login deveria ter sucesso");

    await expect(context.service.getSession(login.sessionId)).resolves.toEqual(
      expect.objectContaining({ mfaVerified: true }),
    );

    const downgraded = createIdentityService({
      oidc: context.oidc,
      store: context.store,
      config: testConfig({ mfaAcceptedAcrValues: [] }),
      clock: context.clock,
    });
    const session = await downgraded.getSession(login.sessionId);
    expect(session).toEqual(expect.objectContaining({ mfaVerified: false }));
    expect(session).not.toHaveProperty("authenticationContext");
  });

  it("não eleva retroativamente sessão criada antes da allowlist", async () => {
    const acceptedAcrValues: string[] = [];
    const config = testConfig({
      mfaAcceptedAcrValues: acceptedAcrValues,
    });
    const context = await startAndAuthorize("/", config, {
      authenticationContext: "urn:example:loa:2",
    });
    const login = await context.service.completeLogin({
      ...context.callback,
      bindingSecret: context.started.bindingSecret,
    });
    if (!login.ok) throw new Error("login deveria ter sucesso");
    await expect(context.service.getSession(login.sessionId)).resolves.toEqual(
      expect.objectContaining({ mfaVerified: false }),
    );

    acceptedAcrValues.push("urn:example:loa:2");
    await expect(context.service.getSession(login.sessionId)).resolves.toEqual(
      expect.objectContaining({ mfaVerified: false }),
    );
  });

  it("não herda MFA ao rotacionar para login sem acr", async () => {
    const context = setup(
      testConfig({ mfaAcceptedAcrValues: ["urn:example:loa:2"] }),
    );
    const firstStart = await context.service.startLogin({ returnTo: "/" });
    const firstCallback = context.oidc.authorize(firstStart.authorizationUrl, {
      authenticationContext: "urn:example:loa:2",
    });
    const first = await context.service.completeLogin({
      ...firstCallback,
      bindingSecret: firstStart.bindingSecret,
    });
    if (!first.ok) throw new Error("login deveria ter sucesso");
    await expect(context.service.getSession(first.sessionId)).resolves.toEqual(
      expect.objectContaining({ mfaVerified: true }),
    );

    const secondStart = await context.service.startLogin({ returnTo: "/" });
    const secondCallback = context.oidc.authorize(secondStart.authorizationUrl);
    const second = await context.service.completeLogin({
      ...secondCallback,
      bindingSecret: secondStart.bindingSecret,
      previousSessionId: first.sessionId,
    });
    if (!second.ok) throw new Error("rotação deveria ter sucesso");
    await expect(
      context.service.getSession(first.sessionId),
    ).resolves.toBeUndefined();
    await expect(context.service.getSession(second.sessionId)).resolves.toEqual(
      expect.objectContaining({ mfaVerified: false }),
    );
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
