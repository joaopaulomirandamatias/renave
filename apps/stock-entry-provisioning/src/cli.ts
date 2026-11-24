import { pathToFileURL } from "node:url";

import { destroyStockEntryKeyBundle } from "@seu-renave/protected-evidence/stock-entry-key-bundle";

import { generateBundleFile } from "./bundle-writer.js";
import { StockEntryProvisioningError } from "./errors.js";
import { destroyProfileAdminMasterKey } from "./profile-admin-key.js";
import { generateProfileAdminKeyFile } from "./profile-admin-key-writer.js";
import { withProfileProvisioningDatabase } from "./profile-provisioner.js";
import {
  assertPinConfirmation,
  inspectPinWithClient,
  provisionPinWithClient,
  withProvisioningDatabase,
} from "./pin-provisioner.js";
import {
  readProfileProvisioningSecrets,
  readProfileStatusSecrets,
  readStockEntryProvisioningSecrets,
} from "./secret-reader.js";

const USAGE = `Uso: pnpm --filter @seu-renave/stock-entry-provisioning cli <comando>

  generate-bundle --generation-id <id> --output-dir <diretorio-absoluto>
  generate-profile-admin-key --key-id <id> --output-dir <diretorio-absoluto>
  pin-status
  provision-pin --confirm-generation <id> --confirm-fingerprint <sha256-hex>
  stage-operator
  stage-establishment
  profile-status
  suspend-operator
  suspend-establishment

Segredos nunca são aceitos por argumento. Consulte o runbook de homologação.`;

const KNOWN_COMMANDS = new Set([
  "generate-bundle",
  "generate-profile-admin-key",
  "pin-status",
  "profile-status",
  "provision-pin",
  "stage-establishment",
  "stage-operator",
  "suspend-establishment",
  "suspend-operator",
]);

const PROFILE_COMMANDS = new Set([
  "profile-status",
  "stage-establishment",
  "stage-operator",
  "suspend-establishment",
  "suspend-operator",
]);

const PROFILE_OUTPUT_COMMANDS = new Set([
  ...PROFILE_COMMANDS,
  "generate-profile-admin-key",
]);

interface CliIo {
  error(value: string): void;
  log(value: string): void;
}

interface CliDependencies {
  generate: typeof generateBundleFile;
  generateProfileAdminKey: typeof generateProfileAdminKeyFile;
  readProfileSecrets: typeof readProfileProvisioningSecrets;
  readProfileStatusSecrets: typeof readProfileStatusSecrets;
  readSecrets: typeof readStockEntryProvisioningSecrets;
  withProfileDatabase: typeof withProfileProvisioningDatabase;
}

const defaults: CliDependencies = {
  generate: generateBundleFile,
  generateProfileAdminKey: generateProfileAdminKeyFile,
  readProfileSecrets: readProfileProvisioningSecrets,
  readProfileStatusSecrets,
  readSecrets: readStockEntryProvisioningSecrets,
  withProfileDatabase: withProfileProvisioningDatabase,
};

function options(
  args: readonly string[],
  allowed: readonly string[],
): Readonly<Record<string, string>> {
  if (args.length % 2 !== 0) {
    throw new StockEntryProvisioningError("BUNDLE_INPUT_INVALID");
  }
  const parsed: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]!;
    const value = args[index + 1]!;
    if (
      !allowed.includes(name) ||
      Object.hasOwn(parsed, name) ||
      !value ||
      value.startsWith("--")
    ) {
      throw new StockEntryProvisioningError("BUNDLE_INPUT_INVALID");
    }
    parsed[name] = value;
  }
  return Object.freeze(parsed);
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new StockEntryProvisioningError("DATABASE_CONFIG_INVALID");
  }
  return value;
}

function result(io: CliIo, payload: Record<string, unknown>): void {
  io.log(JSON.stringify({ schemaVersion: 1, ...payload }));
}

export async function runCli(input: {
  args: readonly string[];
  dependencies?: Partial<CliDependencies>;
  env?: NodeJS.ProcessEnv;
  io?: CliIo;
}): Promise<number> {
  const env = input.env ?? process.env;
  const io = input.io ?? console;
  const dependencies = { ...defaults, ...input.dependencies };
  const [command, ...rawRest] = input.args;
  const rest = rawRest[0] === "--" ? rawRest.slice(1) : rawRest;
  try {
    if (!command || command === "--help" || command === "help") {
      io.log(USAGE);
      return 0;
    }
    if (command === "generate-bundle") {
      const parsed = options(rest, ["--generation-id", "--output-dir"]);
      if (!parsed["--generation-id"] || !parsed["--output-dir"]) {
        throw new StockEntryProvisioningError("BUNDLE_INPUT_INVALID");
      }
      const receipt = await dependencies.generate({
        generationId: parsed["--generation-id"],
        outputDirectory: parsed["--output-dir"],
      });
      result(io, {
        command,
        generationId: receipt.generationId,
        outcome: "generated",
      });
      return 0;
    }
    if (command === "generate-profile-admin-key") {
      const parsed = options(rest, ["--key-id", "--output-dir"]);
      if (!parsed["--key-id"] || !parsed["--output-dir"]) {
        throw new StockEntryProvisioningError("PROFILE_ADMIN_KEY_INVALID");
      }
      const receipt = await dependencies.generateProfileAdminKey({
        keyId: parsed["--key-id"],
        outputDirectory: parsed["--output-dir"],
      });
      result(io, { keyId: receipt.keyId, status: "generated" });
      return 0;
    }
    if (command === "pin-status" || command === "provision-pin") {
      const parsed = options(
        rest,
        command === "provision-pin"
          ? ["--confirm-generation", "--confirm-fingerprint"]
          : [],
      );
      const secrets = await dependencies.readSecrets();
      const bundleReceipt = Object.freeze({
        fingerprint: secrets.bundle.digests.fingerprint.toString("hex"),
        generationId: secrets.bundle.digests.generationId,
      });
      let databaseOwnsBundle = false;
      try {
        if (command === "provision-pin") {
          assertPinConfirmation({
            acknowledgement: env.STOCK_ENTRY_PIN_WRITE_ONCE_ACK,
            bundle: secrets.bundle,
            confirmFingerprint: parsed["--confirm-fingerprint"],
            confirmGeneration: parsed["--confirm-generation"],
          });
        }
        const databaseUrl = requiredEnv(env, "DATABASE_MIGRATOR_URL");
        databaseOwnsBundle = true;
        const status = await withProvisioningDatabase({
          bundle: secrets.bundle,
          databaseCa: secrets.databaseCa,
          databaseUrl,
          operation:
            command === "provision-pin"
              ? async (client, bundle) => {
                  await provisionPinWithClient(client, bundle);
                  return "matching" as const;
                }
              : inspectPinWithClient,
        });
        result(io, {
          command,
          ...(command === "pin-status" ? bundleReceipt : {}),
          outcome: command === "provision-pin" ? "provisioned" : status,
        });
        return 0;
      } finally {
        if (!databaseOwnsBundle) destroyStockEntryKeyBundle(secrets.bundle);
      }
    }
    if (command === "profile-status") {
      options(rest, []);
      const secrets = await dependencies.readProfileStatusSecrets();
      const databaseUrl = requiredEnv(env, "DATABASE_PROFILE_PROVISIONER_URL");
      const profile = await dependencies.withProfileDatabase({
        databaseCa: secrets.databaseCa,
        databaseUrl,
        request: secrets.request,
      });
      result(io, {
        ...(profile.profileId ? { profileId: profile.profileId } : {}),
        status: profile.status,
        ...(profile.version === undefined ? {} : { version: profile.version }),
      });
      return 0;
    }
    if (PROFILE_COMMANDS.has(command)) {
      options(rest, []);
      const secrets = await dependencies.readProfileSecrets();
      let databaseOwnsSecrets = false;
      try {
        if (secrets.request.command !== command) {
          throw new StockEntryProvisioningError("PROFILE_INPUT_INVALID");
        }
        const databaseUrl = requiredEnv(
          env,
          "DATABASE_PROFILE_PROVISIONER_URL",
        );
        databaseOwnsSecrets = true;
        const profile = await dependencies.withProfileDatabase({
          adminKey: secrets.adminKey,
          bundle: secrets.bundle,
          databaseCa: secrets.databaseCa,
          databaseUrl,
          request: secrets.request,
        });
        result(io, {
          ...(profile.profileId ? { profileId: profile.profileId } : {}),
          status: profile.status,
          ...(profile.version === undefined
            ? {}
            : { version: profile.version }),
          ...(profile.replayed === undefined
            ? {}
            : { replayed: profile.replayed }),
        });
        return 0;
      } finally {
        if (!databaseOwnsSecrets) {
          destroyProfileAdminMasterKey(secrets.adminKey);
          destroyStockEntryKeyBundle(secrets.bundle);
        }
      }
    }
    throw new StockEntryProvisioningError("BUNDLE_INPUT_INVALID");
  } catch (error) {
    const code =
      error instanceof StockEntryProvisioningError
        ? error.code
        : PROFILE_OUTPUT_COMMANDS.has(command ?? "")
          ? "PROFILE_PROVISIONING_FAILED"
          : "PIN_PROVISIONING_FAILED";
    io.error(
      JSON.stringify(
        PROFILE_OUTPUT_COMMANDS.has(command ?? "")
          ? { schemaVersion: 1, errorCode: code }
          : {
              schemaVersion: 1,
              command:
                typeof command === "string" && KNOWN_COMMANDS.has(command)
                  ? command
                  : "unknown",
              outcome: "failed",
              errorCode: code,
            },
      ),
    );
    return 1;
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : undefined;
if (invokedPath === import.meta.url) {
  runCli({ args: process.argv.slice(2) })
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      // Defesa final: nenhuma mensagem crua deve escapar do CLI.
      process.exitCode = 1;
    });
}
