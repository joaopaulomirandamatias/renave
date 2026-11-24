export const DOMAIN_ACTIONS = [
  "tenant.establishment.manage",
  "tenant.user.manage",
  "renave.identity.verify",
  "renave.stock.read",
  "renave.vehicle.read",
  "renave.vehicle.eligibility.read",
  "renave.stock-entry.request",
  "renave.stock-exit.request",
  "audit.read",
  "audit.export",
] as const;

export type DomainAction = (typeof DOMAIN_ACTIONS)[number];

export type TenantRole =
  "tenant_admin" | "renave_operator" | "compliance_auditor";

export interface RoleGrant {
  establishmentIds: "*" | readonly string[];
  role: TenantRole;
}

export interface AuthorizationContext {
  grants: readonly RoleGrant[];
  subject: string;
  tenantId: string;
}

export interface AuthorizationRequest {
  action: DomainAction;
  establishmentId?: string;
  justification?: string;
  tenantId: string;
}

export type AuthorizationDenialReason =
  | "INVALID_CONTEXT"
  | "TENANT_MISMATCH"
  | "ESTABLISHMENT_REQUIRED"
  | "ESTABLISHMENT_SCOPE_DENIED"
  | "ROLE_DENIED"
  | "JUSTIFICATION_REQUIRED";

export type AuthorizationDecision =
  | {
      allowed: true;
      establishmentId?: string;
      matchedRole: TenantRole;
      subject: string;
      tenantId: string;
    }
  | { allowed: false; reason: AuthorizationDenialReason };

interface ActionPolicy {
  establishmentScoped: boolean;
  justificationRequired: boolean;
  roles: readonly TenantRole[];
}

const ALL_TENANT_ROLES: readonly TenantRole[] = ["tenant_admin"];

const POLICIES: Readonly<Record<DomainAction, ActionPolicy>> = Object.freeze({
  "tenant.establishment.manage": {
    establishmentScoped: false,
    justificationRequired: false,
    roles: ALL_TENANT_ROLES,
  },
  "tenant.user.manage": {
    establishmentScoped: false,
    justificationRequired: false,
    roles: ALL_TENANT_ROLES,
  },
  "renave.identity.verify": {
    establishmentScoped: true,
    justificationRequired: false,
    roles: ["tenant_admin", "renave_operator"],
  },
  "renave.stock.read": {
    establishmentScoped: true,
    justificationRequired: false,
    roles: ["tenant_admin", "renave_operator"],
  },
  "renave.vehicle.read": {
    establishmentScoped: true,
    justificationRequired: false,
    roles: ["tenant_admin", "renave_operator"],
  },
  "renave.vehicle.eligibility.read": {
    establishmentScoped: true,
    justificationRequired: false,
    roles: ["tenant_admin", "renave_operator"],
  },
  "renave.stock-entry.request": {
    establishmentScoped: true,
    justificationRequired: false,
    roles: ["tenant_admin", "renave_operator"],
  },
  "renave.stock-exit.request": {
    establishmentScoped: true,
    justificationRequired: false,
    roles: ["renave_operator"],
  },
  "audit.read": {
    establishmentScoped: false,
    justificationRequired: false,
    roles: ["tenant_admin", "compliance_auditor"],
  },
  "audit.export": {
    establishmentScoped: false,
    justificationRequired: true,
    roles: ["tenant_admin", "compliance_auditor"],
  },
});

export class AuthorizationDeniedError extends Error {
  readonly code = "AUTHORIZATION_DENIED";

  constructor(readonly reason: AuthorizationDenialReason) {
    super("A sessão não possui autorização para a ação e o escopo solicitados");
    this.name = "AuthorizationDeniedError";
  }
}

function validIdentifier(value: string): boolean {
  return value.trim().length > 0;
}

export function authorize(
  context: AuthorizationContext,
  request: AuthorizationRequest,
): AuthorizationDecision {
  if (
    !validIdentifier(context.subject) ||
    !validIdentifier(context.tenantId) ||
    context.grants.length === 0
  ) {
    return { allowed: false, reason: "INVALID_CONTEXT" };
  }
  if (context.tenantId !== request.tenantId) {
    return { allowed: false, reason: "TENANT_MISMATCH" };
  }

  const policy = POLICIES[request.action];
  if (
    policy.justificationRequired &&
    !validIdentifier(request.justification ?? "")
  ) {
    return { allowed: false, reason: "JUSTIFICATION_REQUIRED" };
  }

  const eligibleGrants = context.grants.filter((grant) =>
    policy.roles.includes(grant.role),
  );
  if (eligibleGrants.length === 0) {
    return { allowed: false, reason: "ROLE_DENIED" };
  }

  if (!policy.establishmentScoped) {
    return {
      allowed: true,
      matchedRole: eligibleGrants[0]!.role,
      subject: context.subject,
      tenantId: context.tenantId,
    };
  }
  if (!validIdentifier(request.establishmentId ?? "")) {
    return { allowed: false, reason: "ESTABLISHMENT_REQUIRED" };
  }

  const establishmentId = request.establishmentId!;
  const matched = eligibleGrants.find(
    (grant) =>
      grant.role === "tenant_admin" ||
      grant.establishmentIds === "*" ||
      grant.establishmentIds.includes(establishmentId),
  );
  if (!matched) {
    return { allowed: false, reason: "ESTABLISHMENT_SCOPE_DENIED" };
  }

  return {
    allowed: true,
    establishmentId,
    matchedRole: matched.role,
    subject: context.subject,
    tenantId: context.tenantId,
  };
}

export function assertAuthorized(
  context: AuthorizationContext,
  request: AuthorizationRequest,
): asserts context is AuthorizationContext {
  const decision = authorize(context, request);
  if (!decision.allowed) throw new AuthorizationDeniedError(decision.reason);
}
