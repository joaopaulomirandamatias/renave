import {
  assertProfileProvisionerSession,
  getAdminEstablishmentRenaveProfileStatus,
  getAdminOperatorRenaveProfileStatus,
  stageEstablishmentRenaveProfile,
  stageOperatorRenaveProfile,
  suspendEstablishmentRenaveProfile,
  suspendOperatorRenaveProfile,
} from "@seu-renave/db";
import {
  destroyStockEntryKeyBundle,
  RenavePrincipalCrypto,
  type ProtectedRenavePrincipal,
  type StockEntryKeyBundle,
} from "@seu-renave/protected-evidence";
import { Pool, type PoolClient, type PoolConfig } from "pg";

import { provisioningError, StockEntryProvisioningError } from "./errors.js";
import {
  deriveProfileAdminKeys,
  destroyProfileAdminDerivedKeys,
  destroyProfileAdminMasterKey,
  profileAdminDigest,
  type ProfileAdminMasterKey,
} from "./profile-admin-key.js";
import type { ProfileProvisioningRequest } from "./profile-request.js";

export interface ProfileCommandResult {
  profileId?: string;
  replayed?: boolean;
  status: "not_found" | "pending" | "suspended" | "verified";
  version?: number;
}

function copyKeyring(input: {
  activeKeyId: string;
  keys: ReadonlyMap<string, Buffer>;
}) {
  return {
    activeKeyId: input.activeKeyId,
    keys: new Map(
      Array.from(input.keys, ([keyId, key]) => [keyId, Buffer.from(key)]),
    ),
  };
}

function zeroKeyring(input: { keys: ReadonlyMap<string, Buffer> }): void {
  for (const key of input.keys.values()) key.fill(0);
}

function createPrincipalCrypto(
  bundle: StockEntryKeyBundle,
): RenavePrincipalCrypto {
  const operatorEncryption = copyKeyring(bundle.operatorCpf.encryption);
  const operatorHmac = copyKeyring(bundle.operatorCpf.hmac);
  const establishmentEncryption = copyKeyring(
    bundle.establishmentEmail.encryption,
  );
  const establishmentHmac = copyKeyring(bundle.establishmentEmail.hmac);
  try {
    return new RenavePrincipalCrypto({
      environment: "homologation",
      purposes: {
        "operator-cpf": { encryption: operatorEncryption, hmac: operatorHmac },
        "establishment-email": {
          encryption: establishmentEncryption,
          hmac: establishmentHmac,
        },
      },
    });
  } finally {
    zeroKeyring(operatorEncryption);
    zeroKeyring(operatorHmac);
    zeroKeyring(establishmentEncryption);
    zeroKeyring(establishmentHmac);
  }
}

function envelope(value: ProtectedRenavePrincipal) {
  return {
    schemaVersion: value.envelopeSchemaVersion,
    keyId: value.keyId,
    nonce: value.nonce,
    authTag: value.authTag,
    ciphertext: value.ciphertext,
    aadSha256: value.aadSha256,
  };
}

function destroyProtected(value: ProtectedRenavePrincipal | undefined): void {
  if (!value) return;
  value.aadSha256.fill(0);
  value.authTag.fill(0);
  value.ciphertext.fill(0);
  value.hmac.digest.fill(0);
  value.nonce.fill(0);
}

export function profileProvisioningDatabaseConfig(
  connectionString: string,
  databaseCa: string | undefined,
): PoolConfig {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new StockEntryProvisioningError("DATABASE_CONFIG_INVALID");
  }
  if (
    (url.protocol !== "postgres:" && url.protocol !== "postgresql:") ||
    url.search !== "" ||
    !url.username ||
    !url.password ||
    !url.pathname ||
    url.pathname === "/" ||
    !databaseCa
  ) {
    throw new StockEntryProvisioningError("DATABASE_CONFIG_INVALID");
  }
  return {
    application_name: "seu-renave-profile-provisioning",
    connectionString,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 5_000,
    max: 1,
    query_timeout: 7_000,
    statement_timeout: 5_000,
    ssl: { ca: databaseCa, rejectUnauthorized: true },
  };
}

export async function executeProfileCommand(
  client: PoolClient,
  input: {
    adminKey?: ProfileAdminMasterKey;
    bundle?: StockEntryKeyBundle;
    request: ProfileProvisioningRequest;
  },
): Promise<ProfileCommandResult> {
  const request = input.request;
  if (request.command === "profile-status") {
    const status =
      request.profileKind === "operator"
        ? await getAdminOperatorRenaveProfileStatus(
            client,
            request.tenantId,
            request.subject,
          )
        : await getAdminEstablishmentRenaveProfileStatus(
            client,
            request.tenantId,
            request.establishmentId,
          );
    return status
      ? Object.freeze({
          profileId: status.profileId,
          status: status.status,
          version: status.version,
        })
      : Object.freeze({ status: "not_found" });
  }

  if (!input.adminKey || !input.bundle) {
    throw new StockEntryProvisioningError("PROFILE_PROVISIONING_FAILED");
  }

  const keys = deriveProfileAdminKeys(input.adminKey);
  let changedBy: Buffer | undefined;
  let assertion: Buffer | undefined;
  let reason: Buffer | undefined;
  let protectedValue: ProtectedRenavePrincipal | undefined;
  let principalCrypto: RenavePrincipalCrypto | undefined;
  try {
    const target =
      request.command === "stage-operator" ||
      request.command === "suspend-operator"
        ? request.subject
        : request.establishmentId;
    changedBy = profileAdminDigest(keys.actor, "changed-by/v1", [
      request.tenantId,
      request.actorSubject,
    ]);
    const requestFields =
      request.command === "suspend-operator" ||
      request.command === "suspend-establishment"
        ? [
            request.command,
            request.tenantId,
            target,
            request.idempotencyKey,
            String(request.expectedVersion),
            request.reasonCode,
          ]
        : [
            request.command,
            request.tenantId,
            target,
            request.idempotencyKey,
            request.profileId,
          ];
    assertion = profileAdminDigest(
      keys.idempotency,
      "request/v1",
      requestFields,
    );

    if (
      request.command === "stage-operator" ||
      request.command === "stage-establishment"
    ) {
      principalCrypto = createPrincipalCrypto(input.bundle);
      protectedValue =
        request.command === "stage-operator"
          ? principalCrypto.protect(request.cpf, {
              tenantId: request.tenantId,
              profileId: request.profileId,
              purpose: "operator-cpf",
              subject: request.subject,
            })
          : principalCrypto.protect(request.email, {
              tenantId: request.tenantId,
              profileId: request.profileId,
              purpose: "establishment-email",
              establishmentId: request.establishmentId,
            });
      const common = {
        tenantId: request.tenantId,
        profileId: request.profileId,
        hmacKeyId: protectedValue.hmac.hmacKeyId,
        envelope: envelope(protectedValue),
        assertion: { digest: assertion, keyId: keys.keyIds.idempotency },
        changedBy: { digest: changedBy, keyId: keys.keyIds.actor },
      };
      return request.command === "stage-operator"
        ? await stageOperatorRenaveProfile(client, {
            ...common,
            subject: request.subject,
            identityHmac: protectedValue.hmac.digest,
          })
        : await stageEstablishmentRenaveProfile(client, {
            ...common,
            establishmentId: request.establishmentId,
            emailHmac: protectedValue.hmac.digest,
          });
    }

    reason = profileAdminDigest(keys.evidence, "suspension-reason/v1", [
      request.tenantId,
      target,
      request.reasonCode,
    ]);
    const common = {
      tenantId: request.tenantId,
      expectedVersion: request.expectedVersion,
      reason: { digest: reason, keyId: keys.keyIds.evidence },
      request: { digest: assertion, keyId: keys.keyIds.idempotency },
      changedBy: { digest: changedBy, keyId: keys.keyIds.actor },
    };
    return request.command === "suspend-operator"
      ? await suspendOperatorRenaveProfile(client, {
          ...common,
          subject: request.subject,
        })
      : await suspendEstablishmentRenaveProfile(client, {
          ...common,
          establishmentId: request.establishmentId,
        });
  } finally {
    principalCrypto?.destroy();
    destroyProtected(protectedValue);
    changedBy?.fill(0);
    assertion?.fill(0);
    reason?.fill(0);
    destroyProfileAdminDerivedKeys(keys);
  }
}

export async function withProfileProvisioningDatabase(input: {
  adminKey?: ProfileAdminMasterKey;
  bundle?: StockEntryKeyBundle;
  databaseCa: string | undefined;
  databaseUrl: string;
  request: ProfileProvisioningRequest;
}): Promise<ProfileCommandResult> {
  let pool: Pool | undefined;
  let client: PoolClient | undefined;
  try {
    pool = new Pool(
      profileProvisioningDatabaseConfig(input.databaseUrl, input.databaseCa),
    );
    client = await pool.connect();
    await assertProfileProvisionerSession(client);
    return await executeProfileCommand(client, input);
  } catch (error) {
    throw provisioningError(error, "PROFILE_PROVISIONING_FAILED");
  } finally {
    client?.release(true);
    await pool?.end().catch(() => undefined);
    destroyProfileAdminMasterKey(input.adminKey);
    destroyStockEntryKeyBundle(input.bundle);
  }
}
