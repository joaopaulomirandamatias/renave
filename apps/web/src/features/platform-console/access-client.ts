export type PlatformAccessMfaCode = "MFA_REQUIRED" | "MFA_RECENT_REQUIRED";

export type PlatformAccessResult =
  | { status: "authorized" }
  | { status: "auth_required" }
  | { code: PlatformAccessMfaCode; status: "mfa_required" }
  | { status: "not_found" }
  | { status: "unavailable" };

export interface PlatformAccessClient {
  load(): Promise<PlatformAccessResult>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === required.length &&
    required.every((key) => Object.hasOwn(value, key))
  );
}

function singleCode(value: unknown, expected: string): boolean {
  return (
    isRecord(value) && hasExactKeys(value, ["code"]) && value.code === expected
  );
}

function unavailablePayload(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["code", "traceId"]) &&
    value.code === "PLATFORM_ACCESS_UNAVAILABLE" &&
    typeof value.traceId === "string" &&
    value.traceId.length > 0 &&
    value.traceId.length <= 256 &&
    !/[\u0000-\u001f\u007f]/u.test(value.traceId)
  );
}

async function responsePayload(
  response: Response,
): Promise<{ empty: boolean; value?: unknown }> {
  let body: string;
  try {
    body = await response.text();
  } catch {
    return { empty: false };
  }
  if (body.length === 0) return { empty: true };
  try {
    return { empty: false, value: JSON.parse(body) as unknown };
  } catch {
    return { empty: false };
  }
}

export const browserPlatformAccessClient: PlatformAccessClient = {
  async load() {
    let response: Response;
    try {
      response = await fetch("/api/platform/access", {
        cache: "no-store",
        credentials: "same-origin",
        headers: { accept: "application/json" },
        redirect: "error",
      });
    } catch {
      return { status: "unavailable" };
    }

    const payload = await responsePayload(response);
    const value = payload.value;
    if (response.status === 204) {
      return payload.empty
        ? { status: "authorized" }
        : { status: "unavailable" };
    }
    if (
      response.status === 401 &&
      singleCode(value, "AUTHENTICATION_REQUIRED")
    ) {
      return { status: "auth_required" };
    }
    if (
      response.status === 403 &&
      isRecord(value) &&
      hasExactKeys(value, ["code"]) &&
      (value.code === "MFA_REQUIRED" || value.code === "MFA_RECENT_REQUIRED")
    ) {
      return { code: value.code, status: "mfa_required" };
    }
    if (
      response.status === 404 &&
      singleCode(value, "PLATFORM_RESOURCE_NOT_FOUND")
    ) {
      return { status: "not_found" };
    }
    if (response.status === 503 && unavailablePayload(value)) {
      return { status: "unavailable" };
    }
    return { status: "unavailable" };
  },
};
