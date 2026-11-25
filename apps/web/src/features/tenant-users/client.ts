const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DATE_TIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/u;

export const TENANT_USER_ROLES = [
  "tenant_admin",
  "renave_operator",
  "compliance_auditor",
] as const;

export type TenantUserRole = (typeof TENANT_USER_ROLES)[number];

export const TENANT_USER_STATUSES = ["active", "suspended"] as const;

export type TenantUserStatus = (typeof TENANT_USER_STATUSES)[number];

const ROLE_SET = new Set<string>(TENANT_USER_ROLES);
const STATUS_SET = new Set<string>(TENANT_USER_STATUSES);

export interface TenantUserItem {
  active: boolean;
  createdAt: string;
  establishmentIds: readonly string[];
  memberId: string;
  role: TenantUserRole;
  status: TenantUserStatus;
}

export type TenantUsersResult =
  | { reason: "forbidden" | "mfa_required"; status: "denied" }
  | { items: readonly TenantUserItem[]; status: "ready" };

export interface LoadTenantUsersInput {
  signal?: AbortSignal;
  tenantId: string;
}

export interface TenantUsersClient {
  loadUsers(input: LoadTenantUsersInput): Promise<TenantUsersResult>;
}

export class TenantUsersClientError extends Error {
  constructor(
    readonly status: number,
    readonly code?: string,
  ) {
    super("Consulta de usuários da organização não concluída");
    this.name = "TenantUsersClientError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === required.length &&
    required.every((key) => Object.hasOwn(value, key))
  );
}

function validDateTime(value: unknown): value is string {
  return (
    typeof value === "string" &&
    DATE_TIME_PATTERN.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

export function parseTenantUsersResponse(
  value: unknown,
): readonly TenantUserItem[] {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["items"]) ||
    !Array.isArray(value.items)
  ) {
    throw new Error("Resposta de usuários da organização inválida");
  }

  return value.items.map((raw) => {
    if (
      !isRecord(raw) ||
      !exactKeys(raw, [
        "active",
        "createdAt",
        "establishmentIds",
        "memberId",
        "role",
        "status",
      ]) ||
      typeof raw.active !== "boolean" ||
      !validDateTime(raw.createdAt) ||
      !Array.isArray(raw.establishmentIds) ||
      typeof raw.memberId !== "string" ||
      !UUID_PATTERN.test(raw.memberId) ||
      typeof raw.role !== "string" ||
      !ROLE_SET.has(raw.role) ||
      typeof raw.status !== "string" ||
      !STATUS_SET.has(raw.status) ||
      raw.active !== (raw.status === "active")
    ) {
      throw new Error("Item de usuário da organização inválido");
    }

    const establishmentIds = raw.establishmentIds.map((id) => {
      if (typeof id !== "string" || !UUID_PATTERN.test(id)) {
        throw new Error("Identificador de estabelecimento inválido");
      }
      return id.toLowerCase();
    });

    return {
      active: raw.active,
      createdAt: raw.createdAt,
      establishmentIds,
      memberId: raw.memberId.toLowerCase(),
      role: raw.role as TenantUserRole,
      status: raw.status as TenantUserStatus,
    };
  });
}

export function createTenantUsersClient(
  fetchImpl: typeof fetch = fetch,
): TenantUsersClient {
  return {
    async loadUsers(input) {
      if (!UUID_PATTERN.test(input.tenantId)) {
        return { reason: "forbidden", status: "denied" };
      }

      let response: Response;
      try {
        response = await fetchImpl(
          `/api/tenants/${encodeURIComponent(input.tenantId.toLowerCase())}/users`,
          {
            cache: "no-store",
            credentials: "same-origin",
            headers: { accept: "application/json" },
            method: "GET",
            redirect: "error",
            ...(input.signal ? { signal: input.signal } : {}),
          },
        );
      } catch {
        throw new TenantUsersClientError(0, "NETWORK_ERROR");
      }

      const payload: unknown = await response.json().catch(() => undefined);
      const code =
        isRecord(payload) && typeof payload.code === "string"
          ? payload.code
          : undefined;

      if (response.status === 403 || response.status === 404) {
        return {
          reason:
            code === "MFA_REQUIRED" || code === "MFA_RECENT_REQUIRED"
              ? "mfa_required"
              : "forbidden",
          status: "denied",
        };
      }

      if (!response.ok) {
        throw new TenantUsersClientError(response.status, code);
      }

      try {
        return {
          items: parseTenantUsersResponse(payload),
          status: "ready",
        };
      } catch {
        throw new TenantUsersClientError(0, "INVALID_RESPONSE");
      }
    },
  };
}

export const browserTenantUsersClient = createTenantUsersClient();
