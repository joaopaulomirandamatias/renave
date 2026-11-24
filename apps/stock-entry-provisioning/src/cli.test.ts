import {
  destroyStockEntryKeyBundle,
  generateStockEntryKeyBundle,
} from "@seu-renave/protected-evidence/stock-entry-key-bundle";
import { describe, expect, it, vi } from "vitest";

import { runCli } from "./cli.js";

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
});
