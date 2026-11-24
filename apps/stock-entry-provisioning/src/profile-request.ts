import { StockEntryProvisioningError } from "./errors.js";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SUBJECT = /^[^\u0000-\u001f\u007f]{1,255}$/u;
const REASON = /^[a-z][a-z0-9_]{2,63}$/u;

export const PROFILE_SUSPENSION_CONFIRMATION = "SUSPEND_RENAVE_PROFILE";

interface CommonRequest {
  schemaVersion: 1;
  tenantId: string;
}

interface MutatingRequest extends CommonRequest {
  actorSubject: string;
  idempotencyKey: string;
}

export interface StageOperatorRequest extends MutatingRequest {
  command: "stage-operator";
  cpf: string;
  profileId: string;
  subject: string;
}

export interface StageEstablishmentRequest extends MutatingRequest {
  command: "stage-establishment";
  email: string;
  establishmentId: string;
  profileId: string;
}

export interface OperatorStatusRequest extends CommonRequest {
  command: "profile-status";
  profileKind: "operator";
  subject: string;
}

export interface EstablishmentStatusRequest extends CommonRequest {
  command: "profile-status";
  establishmentId: string;
  profileKind: "establishment";
}

export interface SuspendOperatorRequest extends MutatingRequest {
  command: "suspend-operator";
  confirmation: typeof PROFILE_SUSPENSION_CONFIRMATION;
  expectedVersion: number;
  reasonCode: string;
  subject: string;
}

export interface SuspendEstablishmentRequest extends MutatingRequest {
  command: "suspend-establishment";
  confirmation: typeof PROFILE_SUSPENSION_CONFIRMATION;
  establishmentId: string;
  expectedVersion: number;
  reasonCode: string;
}

export type ProfileProvisioningRequest =
  | StageOperatorRequest
  | StageEstablishmentRequest
  | OperatorStatusRequest
  | EstablishmentStatusRequest
  | SuspendOperatorRequest
  | SuspendEstablishmentRequest;

function record(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function exact(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function uuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

function subject(value: unknown): value is string {
  return (
    typeof value === "string" && value.trim() === value && SUBJECT.test(value)
  );
}

function mutating(value: Record<string, unknown>): boolean {
  return (
    uuid(value.tenantId) &&
    uuid(value.idempotencyKey) &&
    subject(value.actorSubject)
  );
}

function validVersion(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function validReason(value: unknown): value is string {
  return typeof value === "string" && REASON.test(value);
}

export function parseProfileProvisioningRequest(
  text: string,
): ProfileProvisioningRequest {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new StockEntryProvisioningError("PROFILE_INPUT_INVALID");
  }
  if (!record(value) || value.schemaVersion !== 1 || !uuid(value.tenantId)) {
    throw new StockEntryProvisioningError("PROFILE_INPUT_INVALID");
  }
  const command = value.command;
  const valid =
    (command === "stage-operator" &&
      exact(value, [
        "schemaVersion",
        "command",
        "tenantId",
        "profileId",
        "subject",
        "cpf",
        "actorSubject",
        "idempotencyKey",
      ]) &&
      mutating(value) &&
      uuid(value.profileId) &&
      subject(value.subject) &&
      typeof value.cpf === "string") ||
    (command === "stage-establishment" &&
      exact(value, [
        "schemaVersion",
        "command",
        "tenantId",
        "profileId",
        "establishmentId",
        "email",
        "actorSubject",
        "idempotencyKey",
      ]) &&
      mutating(value) &&
      uuid(value.profileId) &&
      uuid(value.establishmentId) &&
      typeof value.email === "string") ||
    (command === "profile-status" &&
      value.profileKind === "operator" &&
      exact(value, [
        "schemaVersion",
        "command",
        "tenantId",
        "profileKind",
        "subject",
      ]) &&
      subject(value.subject)) ||
    (command === "profile-status" &&
      value.profileKind === "establishment" &&
      exact(value, [
        "schemaVersion",
        "command",
        "tenantId",
        "profileKind",
        "establishmentId",
      ]) &&
      uuid(value.establishmentId)) ||
    (command === "suspend-operator" &&
      exact(value, [
        "schemaVersion",
        "command",
        "tenantId",
        "subject",
        "expectedVersion",
        "reasonCode",
        "confirmation",
        "actorSubject",
        "idempotencyKey",
      ]) &&
      mutating(value) &&
      subject(value.subject) &&
      validVersion(value.expectedVersion) &&
      validReason(value.reasonCode) &&
      value.confirmation === PROFILE_SUSPENSION_CONFIRMATION) ||
    (command === "suspend-establishment" &&
      exact(value, [
        "schemaVersion",
        "command",
        "tenantId",
        "establishmentId",
        "expectedVersion",
        "reasonCode",
        "confirmation",
        "actorSubject",
        "idempotencyKey",
      ]) &&
      mutating(value) &&
      uuid(value.establishmentId) &&
      validVersion(value.expectedVersion) &&
      validReason(value.reasonCode) &&
      value.confirmation === PROFILE_SUSPENSION_CONFIRMATION);
  if (!valid)
    throw new StockEntryProvisioningError(
      command === "suspend-operator" || command === "suspend-establishment"
        ? "PROFILE_CONFIRMATION_INVALID"
        : "PROFILE_INPUT_INVALID",
    );
  return Object.freeze(value) as unknown as ProfileProvisioningRequest;
}
