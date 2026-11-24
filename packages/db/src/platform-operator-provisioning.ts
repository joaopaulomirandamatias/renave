import { isIP } from "node:net";

import type { Pool } from "pg";

import {
  derivePlatformActorDigest,
  derivePlatformDecisionTicketDigest,
  derivePlatformTraceDigest,
  PlatformDigestInputError,
} from "./platform-digests.js";

const REASON_TICKET = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/u;

export interface PlatformOperatorIdentity {
  issuer: string;
  subject: string;
}

interface PlatformOperatorDecision {
  actorIp: string;
  changedBy: PlatformOperatorIdentity;
  decisionTicket: string;
  target: PlatformOperatorIdentity;
  traceId: string;
}

export interface GrantPlatformOperatorInput extends PlatformOperatorDecision {
  expiresAt: Date;
  validFrom: Date;
}

export type RevokePlatformOperatorInput = PlatformOperatorDecision;

export class PlatformOperatorProvisioningInputError extends Error {
  readonly code = "PLATFORM_OPERATOR_PROVISIONING_INPUT_REJECTED";
  override name = "PlatformOperatorProvisioningInputError";

  constructor() {
    super("A decisao de acesso ao console global e invalida");
  }
}

function validIdentity(value: PlatformOperatorIdentity): boolean {
  return (
    value.issuer.length > 0 &&
    value.issuer.length <= 2048 &&
    value.subject.length > 0 &&
    value.subject.length <= 512
  );
}

function validateDecision(input: PlatformOperatorDecision): void {
  if (
    !validIdentity(input.target) ||
    !validIdentity(input.changedBy) ||
    !REASON_TICKET.test(input.decisionTicket) ||
    input.traceId.length === 0 ||
    input.traceId.length > 256 ||
    isIP(input.actorIp) === 0
  ) {
    throw new PlatformOperatorProvisioningInputError();
  }
}

function decisionDigests(key: Buffer, input: PlatformOperatorDecision) {
  validateDecision(input);
  try {
    return {
      actor: derivePlatformActorDigest(
        key,
        input.target.issuer,
        input.target.subject,
      ),
      changedBy: derivePlatformActorDigest(
        key,
        input.changedBy.issuer,
        input.changedBy.subject,
      ),
      ticket: derivePlatformDecisionTicketDigest(key, input.decisionTicket),
      trace: derivePlatformTraceDigest(key, input.traceId),
    };
  } catch (error) {
    if (error instanceof PlatformDigestInputError) {
      throw new PlatformOperatorProvisioningInputError();
    }
    throw error;
  }
}

export async function grantPlatformOperator(
  pool: Pool,
  key: Buffer,
  input: GrantPlatformOperatorInput,
): Promise<void> {
  if (
    !(input.validFrom instanceof Date) ||
    !Number.isFinite(input.validFrom.getTime()) ||
    !(input.expiresAt instanceof Date) ||
    !Number.isFinite(input.expiresAt.getTime()) ||
    input.expiresAt.getTime() <= input.validFrom.getTime()
  ) {
    throw new PlatformOperatorProvisioningInputError();
  }
  const digests = decisionDigests(key, input);
  try {
    await pool.query(
      `select renave_platform.grant_operator($1,$2,$3,$4,$5,$6,$7)`,
      [
        digests.actor,
        input.validFrom,
        input.expiresAt,
        digests.ticket,
        digests.changedBy,
        input.actorIp,
        digests.trace,
      ],
    );
  } finally {
    for (const digest of Object.values(digests)) digest.fill(0);
  }
}

export async function revokePlatformOperator(
  pool: Pool,
  key: Buffer,
  input: RevokePlatformOperatorInput,
): Promise<boolean> {
  const digests = decisionDigests(key, input);
  try {
    const result = await pool.query<{ changed: boolean }>(
      `select renave_platform.revoke_operator($1,$2,$3,$4,$5) as changed`,
      [
        digests.actor,
        digests.ticket,
        digests.changedBy,
        input.actorIp,
        digests.trace,
      ],
    );
    return result.rows[0]?.changed === true;
  } finally {
    for (const digest of Object.values(digests)) digest.fill(0);
  }
}
