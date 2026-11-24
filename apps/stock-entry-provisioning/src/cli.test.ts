import {
  destroyStockEntryKeyBundle,
  generateStockEntryKeyBundle,
} from "@seu-renave/protected-evidence/stock-entry-key-bundle";
import { describe, expect, it, vi } from "vitest";

import { runCli } from "./cli.js";
import {
  destroyProfileAdminMasterKey,
  generateProfileAdminMasterKey,
} from "./profile-admin-key.js";

function capture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stderr,
    stdout,
    io: {
      error: (value: string) => stderr.push(value),
      log: (value: string) => stdout.push(value),
    },
  };
}

function bundle() {
  let seed = 0;
  return generateStockEntryKeyBundle("hml-cli", (size) =>
    Buffer.alloc(size, ++seed),
  );
}

describe("CLI de provisionamento HELD_LOCAL", () => {
  it("exibe ajuda e recusa comando desconhecido", async () => {
    const help = capture();
    expect(await runCli({ args: ["--help"], io: help.io })).toBe(0);
    expect(help.stdout.join("\n")).toContain("generate-bundle");
    expect(help.stdout.join("\n")).not.toContain("verify");
    expect(help.stdout.join("\n")).not.toContain("promote");

    const unknown = capture();
    expect(await runCli({ args: ["unknown"], io: unknown.io })).toBe(1);
    expect(unknown.stderr.join("\n")).toContain("BUNDLE_INPUT_INVALID");

    const sensitiveUnknown = capture();
    const sensitive = "postgres://user:password@host/db";
    expect(await runCli({ args: [sensitive], io: sensitiveUnknown.io })).toBe(
      1,
    );
    const combined = [
      ...sensitiveUnknown.stdout,
      ...sensitiveUnknown.stderr,
    ].join("\n");
    expect(combined).not.toContain(sensitive);
    expect(combined).not.toContain("password");
    expect(combined).toContain('"command":"unknown"');
  });

  it("gera saída sanitizada sem caminho ou conteúdo do bundle", async () => {
    const output = capture();
    const generate = vi.fn(async () => ({
      fingerprintHex: "a".repeat(64),
      generationId: "hml-cli",
    }));
    expect(
      await runCli({
        args: [
          "generate-bundle",
          "--",
          "--generation-id",
          "hml-cli",
          "--output-dir",
          "/secret/private/path",
        ],
        dependencies: { generate },
        io: output.io,
      }),
    ).toBe(0);
    const text = output.stdout.join("\n");
    expect(text).not.toContain("/secret/private/path");
    expect(text).not.toContain("keys.json");
    expect(text).not.toContain("a".repeat(64));
    expect(text).toContain("hml-cli");
  });

  it("falha antes do banco e zera o bundle sem confirmação write-once", async () => {
    const value = bundle();
    const output = capture();
    expect(
      await runCli({
        args: [
          "provision-pin",
          "--confirm-generation",
          "hml-cli",
          "--confirm-fingerprint",
          value.digests.fingerprint.toString("hex"),
        ],
        dependencies: {
          readSecrets: async () => ({ bundle: value, databaseCa: undefined }),
        },
        env: { DATABASE_MIGRATOR_URL: "postgres://user:password@host/db" },
        io: output.io,
      }),
    ).toBe(1);
    expect(output.stderr.join("\n")).toContain("PIN_CONFIRMATION_INVALID");
    expect(output.stderr.join("\n")).not.toContain("password");
    expect(value.digests.actor.every((byte) => byte === 0)).toBe(true);
    destroyStockEntryKeyBundle(value);
  });

  it("executa staging sem expor CPF, ator, subject, URL ou chave", async () => {
    const value = bundle();
    const adminKey = generateProfileAdminMasterKey("profile-admin-v1", (size) =>
      Buffer.alloc(size, 5),
    );
    const output = capture();
    const cpf = "52998224725";
    const actorSubject = "admin-sensitive-subject";
    const operatorSubject = "operator-sensitive-subject";
    const databaseUrl = "postgres://profile:secret@database/profiles";
    const withProfileDatabase = vi.fn(async () => ({
      profileId: "33333333-3333-4333-8333-333333333333",
      status: "pending" as const,
      version: 1,
      replayed: false,
    }));
    try {
      expect(
        await runCli({
          args: ["stage-operator"],
          dependencies: {
            readProfileSecrets: async () => ({
              adminKey,
              bundle: value,
              databaseCa: "CA",
              request: {
                schemaVersion: 1,
                command: "stage-operator",
                tenantId: "11111111-1111-4111-8111-111111111111",
                profileId: "33333333-3333-4333-8333-333333333333",
                subject: operatorSubject,
                cpf,
                actorSubject,
                idempotencyKey: "22222222-2222-4222-8222-222222222222",
              },
            }),
            withProfileDatabase,
          },
          env: { DATABASE_PROFILE_PROVISIONER_URL: databaseUrl },
          io: output.io,
        }),
      ).toBe(0);
      const text = [...output.stdout, ...output.stderr].join("\n");
      expect(text).toContain('"status":"pending"');
      expect(
        Object.keys(JSON.parse(output.stdout[0]!) as object).sort(),
      ).toEqual([
        "profileId",
        "replayed",
        "schemaVersion",
        "status",
        "version",
      ]);
      expect(text).not.toContain(cpf);
      expect(text).not.toContain(actorSubject);
      expect(text).not.toContain(operatorSubject);
      expect(text).not.toContain(databaseUrl);
      expect(text).not.toContain("secret");
    } finally {
      destroyProfileAdminMasterKey(adminKey);
      destroyStockEntryKeyBundle(value);
    }
  });

  it("consulta status sem carregar bundle ou chave administrativa", async () => {
    const output = capture();
    const readProfileSecrets = vi.fn(async () => {
      throw new Error("não deve ler chaves");
    });
    const withProfileDatabase = vi.fn(async () => ({
      status: "pending" as const,
    }));
    const withProfileStatusDatabase = vi.fn(async () => ({
      status: "not_found" as const,
    }));
    expect(
      await runCli({
        args: ["profile-status"],
        dependencies: {
          readProfileSecrets,
          readProfileStatusSecrets: async () => ({
            databaseCa: "CA",
            request: {
              schemaVersion: 1,
              command: "profile-status",
              tenantId: "11111111-1111-4111-8111-111111111111",
              profileKind: "operator",
              subject: "operator-sensitive-subject",
            },
          }),
          withProfileDatabase,
          withProfileStatusDatabase,
        },
        env: {
          DATABASE_PROFILE_PROVISIONER_URL:
            "postgres://provisioner:secret@database/profiles",
          DATABASE_PROFILE_READER_URL:
            "postgres://reader:reader-secret@database/profiles",
        },
        io: output.io,
      }),
    ).toBe(0);
    expect(readProfileSecrets).not.toHaveBeenCalled();
    expect(withProfileDatabase).not.toHaveBeenCalled();
    expect(withProfileStatusDatabase).toHaveBeenCalledWith(
      expect.objectContaining({
        databaseUrl: "postgres://reader:reader-secret@database/profiles",
      }),
    );
    expect(withProfileStatusDatabase).toHaveBeenCalledWith(
      expect.not.objectContaining({ adminKey: expect.anything() }),
    );
    expect(withProfileStatusDatabase).toHaveBeenCalledWith(
      expect.not.objectContaining({ bundle: expect.anything() }),
    );
    expect(output.stdout).toEqual(['{"schemaVersion":1,"status":"not_found"}']);
  });

  it("falha fechado sem URL do reader e nunca reutiliza o provisioner", async () => {
    const output = capture();
    const withProfileStatusDatabase = vi.fn();
    expect(
      await runCli({
        args: ["profile-status"],
        dependencies: {
          readProfileStatusSecrets: async () => ({
            databaseCa: "CA",
            request: {
              schemaVersion: 1,
              command: "profile-status",
              tenantId: "11111111-1111-4111-8111-111111111111",
              profileKind: "operator",
              subject: "operator-sensitive-subject",
            },
          }),
          withProfileStatusDatabase,
        },
        env: {
          DATABASE_PROFILE_PROVISIONER_URL:
            "postgres://provisioner:secret@database/profiles",
        },
        io: output.io,
      }),
    ).toBe(1);
    expect(withProfileStatusDatabase).not.toHaveBeenCalled();
    expect(output.stderr).toEqual([
      '{"schemaVersion":1,"errorCode":"DATABASE_CONFIG_INVALID"}',
    ]);
    expect(output.stderr.join("\n")).not.toContain("secret");
  });

  it("não reutiliza a URL do reader para comandos mutantes", async () => {
    const output = capture();
    const value = bundle();
    const adminKey = generateProfileAdminMasterKey("profile-admin-v1", (size) =>
      Buffer.alloc(size, 7),
    );
    const withProfileDatabase = vi.fn();
    expect(
      await runCli({
        args: ["stage-operator"],
        dependencies: {
          readProfileSecrets: async () => ({
            adminKey,
            bundle: value,
            databaseCa: "CA",
            request: {
              schemaVersion: 1,
              command: "stage-operator",
              tenantId: "11111111-1111-4111-8111-111111111111",
              profileId: "33333333-3333-4333-8333-333333333333",
              subject: "operator-sensitive-subject",
              cpf: "52998224725",
              actorSubject: "admin-sensitive-subject",
              idempotencyKey: "22222222-2222-4222-8222-222222222222",
            },
          }),
          withProfileDatabase,
        },
        env: {
          DATABASE_PROFILE_READER_URL:
            "postgres://reader:reader-secret@database/profiles",
        },
        io: output.io,
      }),
    ).toBe(1);
    expect(withProfileDatabase).not.toHaveBeenCalled();
    expect(output.stderr).toEqual([
      '{"schemaVersion":1,"errorCode":"DATABASE_CONFIG_INVALID"}',
    ]);
    expect(adminKey.key.every((byte) => byte === 0)).toBe(true);
    expect(value.digests.actor.every((byte) => byte === 0)).toBe(true);
  });
});
