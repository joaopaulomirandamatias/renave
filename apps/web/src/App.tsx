import { Button, resolveAppEnvironment } from "@seu-renave/ui";
import { AlertCircle, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { DashboardPage } from "./pages/DashboardPage.js";
import { LoginPage } from "./pages/LoginPage.js";

interface AnonymousSession {
  authenticated: false;
  authMode: "disabled" | "oidc";
  environment: string;
}

interface AuthenticatedSession {
  authenticated: true;
  authMode: "oidc";
  environment: string;
  expiresAt: string;
  user: {
    email?: string;
    name?: string;
  };
}

export type BrowserSession = AnonymousSession | AuthenticatedSession;

export interface BrowserTenant {
  displayName: string;
  tenantId: string;
}

export interface BrowserEstablishment {
  id: string;
  tradeName: string;
}

export type EstablishmentManagementCapability =
  "available" | "mfa_required" | "denied";

export interface BrowserEstablishmentCollection {
  capabilities: {
    establishmentManagement: EstablishmentManagementCapability;
  };
  establishments: readonly BrowserEstablishment[];
}

export interface CreateEstablishmentInput {
  cnpj: string;
  idempotencyKey: string;
  tradeName: string;
}

export interface CreateEstablishmentResult {
  establishment: BrowserEstablishment;
  renaveLink: { status: "not_started" };
}

export interface CreateStockEntryInput {
  dataCompra: string;
  emailVendedor: string;
  idempotencyKey: string;
  valorCompra: number;
  veiculo: {
    codigoSegurancaCrv: string;
    dataHoraMedicaoHodometro: string;
    documentoProprietarioAtual: string;
    numeroCrv?: string;
    placa: string;
    quilometragemHodometro: number;
    renavam?: string;
    tipoCrv: BrowserCrvType;
    tipoDocumentoProprietarioAtual: "CPF" | "CNPJ";
  };
}

export interface CreateStockEntryResult {
  createdAt: string;
  operationId: string;
  replayed: boolean;
  status: "HELD_LOCAL";
}

export type BrowserRenaveLinkStatus =
  | "not_started"
  | "pending"
  | "confirmed"
  | "enabled"
  | "deactivated"
  | "rejected";

export interface BrowserRenaveLink {
  preflightAvailable: boolean;
  status: BrowserRenaveLinkStatus;
}

export interface BrowserRenaveReadiness {
  certificate: "ready" | "warning" | "blocked" | "unavailable";
  environment: "homologation";
  establishmentContact: "ready" | "blocked" | "unavailable";
  integration: "configured" | "disabled";
  link: BrowserRenaveLinkStatus;
  mutations: "blocked";
  operatorIdentity: "ready" | "blocked" | "unavailable";
  queries: "ready" | "blocked";
}

export type BrowserStockState =
  "SOLICITADO" | "TRANSFERIDO" | "CONFIRMADO" | "FINALIZADO";

export interface BrowserStockSummary {
  estado: BrowserStockState;
  id: number;
  placa: string;
}

export type BrowserCrvType = "AZUL" | "VERDE" | "BRANCO" | "DIGITAL";

export type BrowserEligibilityStatus =
  "eligible" | "ineligible" | "undetermined";

export type BrowserEligibilityImpediment =
  | "UNSPECIFIED_INELIGIBILITY"
  | "VEHICLE_WRITTEN_OFF"
  | "VEHICLE_ALARM"
  | "PROVISIONAL_REGISTRATION"
  | "CRV_ISSUANCE_PENDING"
  | "RECALL_PENDING"
  | "EXTRAJUDICIAL_RESTRICTION"
  | "DETRAN_BLOCKING_RESTRICTION"
  | "JUDICIAL_RESTRICTION"
  | "FEDERAL_REVENUE_RESTRICTION"
  | "PGFN_RESTRICTION"
  | "THEFT_OR_ROBBERY"
  | "ATPV_MISSING"
  | "TRANSFER_AUTHORIZATION_FOR_DIFFERENT_ESTABLISHMENT"
  | "SALE_NOTICE_FOR_DIFFERENT_BUYER"
  | "SALE_INTENT_FOR_DIFFERENT_BUYER";

export interface BrowserEligibilitySummary {
  detranUnavailable: boolean;
  impediments: readonly BrowserEligibilityImpediment[];
  status: BrowserEligibilityStatus;
}

export interface SessionClient {
  checkVehicleEligibility(
    tenantId: string,
    establishmentId: string,
    plate: string,
    crvType: BrowserCrvType,
  ): Promise<BrowserEligibilitySummary>;
  createEstablishment(
    tenantId: string,
    input: CreateEstablishmentInput,
  ): Promise<CreateEstablishmentResult>;
  createStockEntry(
    tenantId: string,
    establishmentId: string,
    input: CreateStockEntryInput,
  ): Promise<CreateStockEntryResult>;
  load(): Promise<BrowserSession>;
  loadEstablishments(tenantId: string): Promise<BrowserEstablishmentCollection>;
  loadTenants(): Promise<readonly BrowserTenant[]>;
  loadRenaveLinkStatus(
    tenantId: string,
    establishmentId: string,
  ): Promise<BrowserRenaveLink>;
  loadRenaveReadiness(
    tenantId: string,
    establishmentId: string,
  ): Promise<BrowserRenaveReadiness>;
  logout(): Promise<{ endSessionUrl?: string }>;
  runRenaveLinkPreflight(
    tenantId: string,
    establishmentId: string,
  ): Promise<void>;
  searchStocks(
    tenantId: string,
    establishmentId: string,
    plate: string,
  ): Promise<readonly BrowserStockSummary[]>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSession(value: unknown): BrowserSession {
  if (!isRecord(value) || typeof value.authenticated !== "boolean") {
    throw new Error("Resposta de sessão inválida");
  }
  const environment =
    typeof value.environment === "string" ? value.environment : "development";
  const authMode = value.authMode === "oidc" ? "oidc" : "disabled";
  if (!value.authenticated) {
    return { authenticated: false, authMode, environment };
  }
  if (authMode !== "oidc" || !isRecord(value.user)) {
    throw new Error("Resposta autenticada inválida");
  }
  if (typeof value.expiresAt !== "string") {
    throw new Error("Expiração da sessão ausente");
  }
  return {
    authenticated: true,
    authMode,
    environment,
    expiresAt: value.expiresAt,
    user: {
      ...(typeof value.user.name === "string" ? { name: value.user.name } : {}),
      ...(typeof value.user.email === "string"
        ? { email: value.user.email }
        : {}),
    },
  };
}

function parseTenants(value: unknown): readonly BrowserTenant[] {
  if (!isRecord(value) || !Array.isArray(value.tenants)) {
    throw new Error("Resposta do diretório de organizações inválida");
  }
  return value.tenants.map((tenant) => {
    if (
      !isRecord(tenant) ||
      typeof tenant.tenantId !== "string" ||
      typeof tenant.displayName !== "string" ||
      tenant.tenantId.length === 0 ||
      tenant.displayName.trim().length === 0
    ) {
      throw new Error("Organização inválida no diretório");
    }
    return {
      displayName: tenant.displayName,
      tenantId: tenant.tenantId,
    };
  });
}

function parseEstablishments(value: unknown): readonly BrowserEstablishment[] {
  if (!isRecord(value) || !Array.isArray(value.establishments)) {
    throw new Error("Resposta de estabelecimentos inválida");
  }
  return value.establishments.map((establishment) => {
    if (
      !isRecord(establishment) ||
      Object.keys(establishment).length !== 2 ||
      Object.keys(establishment).some(
        (key) => key !== "id" && key !== "tradeName",
      ) ||
      typeof establishment.id !== "string" ||
      typeof establishment.tradeName !== "string" ||
      establishment.id.length === 0 ||
      establishment.tradeName.trim().length === 0
    ) {
      throw new Error("Estabelecimento inválido no diretório");
    }
    return { id: establishment.id, tradeName: establishment.tradeName };
  });
}

const establishmentManagementCapabilities =
  new Set<EstablishmentManagementCapability>([
    "available",
    "mfa_required",
    "denied",
  ]);

function parseEstablishmentCollection(
  value: unknown,
): BrowserEstablishmentCollection {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 2 ||
    Object.keys(value).some(
      (key) => key !== "establishments" && key !== "capabilities",
    ) ||
    !isRecord(value.capabilities) ||
    Object.keys(value.capabilities).length !== 1 ||
    typeof value.capabilities.establishmentManagement !== "string" ||
    !establishmentManagementCapabilities.has(
      value.capabilities
        .establishmentManagement as EstablishmentManagementCapability,
    )
  ) {
    throw new Error("Resposta de estabelecimentos inválida");
  }
  return {
    capabilities: {
      establishmentManagement: value.capabilities
        .establishmentManagement as EstablishmentManagementCapability,
    },
    establishments: parseEstablishments(value),
  };
}

function parseCreatedEstablishment(value: unknown): CreateEstablishmentResult {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 2 ||
    Object.keys(value).some(
      (key) => key !== "establishment" && key !== "renaveLink",
    ) ||
    !isRecord(value.establishment) ||
    Object.keys(value.establishment).length !== 2 ||
    typeof value.establishment.id !== "string" ||
    value.establishment.id.length === 0 ||
    typeof value.establishment.tradeName !== "string" ||
    value.establishment.tradeName.trim().length === 0 ||
    !isRecord(value.renaveLink) ||
    Object.keys(value.renaveLink).length !== 1 ||
    value.renaveLink.status !== "not_started"
  ) {
    throw new Error("Resposta de cadastro de estabelecimento inválida");
  }
  return {
    establishment: {
      id: value.establishment.id,
      tradeName: value.establishment.tradeName,
    },
    renaveLink: { status: "not_started" },
  };
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function parseCreatedStockEntry(value: unknown): CreateStockEntryResult {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 4 ||
    Object.keys(value).some(
      (key) =>
        key !== "operationId" &&
        key !== "status" &&
        key !== "replayed" &&
        key !== "createdAt",
    ) ||
    typeof value.operationId !== "string" ||
    !UUID_PATTERN.test(value.operationId) ||
    value.status !== "HELD_LOCAL" ||
    typeof value.replayed !== "boolean" ||
    typeof value.createdAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/u.test(
      value.createdAt,
    ) ||
    !Number.isFinite(Date.parse(value.createdAt))
  ) {
    throw new Error("Resposta de criação da operação inválida");
  }
  return {
    createdAt: value.createdAt,
    operationId: value.operationId.toLowerCase(),
    replayed: value.replayed,
    status: "HELD_LOCAL",
  };
}

const renaveLinkStatuses = new Set<BrowserRenaveLinkStatus>([
  "not_started",
  "pending",
  "confirmed",
  "enabled",
  "deactivated",
  "rejected",
]);

function parseRenaveLink(value: unknown): BrowserRenaveLink {
  if (
    !isRecord(value) ||
    typeof value.status !== "string" ||
    !renaveLinkStatuses.has(value.status as BrowserRenaveLinkStatus) ||
    typeof value.preflightAvailable !== "boolean"
  ) {
    throw new Error("Resposta do vínculo RENAVE inválida");
  }
  return {
    preflightAvailable: value.preflightAvailable,
    status: value.status as BrowserRenaveLinkStatus,
  };
}

const renaveCertificateReadiness = new Set<
  BrowserRenaveReadiness["certificate"]
>(["ready", "warning", "blocked", "unavailable"]);
const renaveIntegrationReadiness = new Set<
  BrowserRenaveReadiness["integration"]
>(["configured", "disabled"]);
const renaveQueryReadiness = new Set<BrowserRenaveReadiness["queries"]>([
  "ready",
  "blocked",
]);
const renavePrincipalReadiness = new Set<
  BrowserRenaveReadiness["operatorIdentity"]
>(["ready", "blocked", "unavailable"]);

function parseRenaveReadiness(value: unknown): BrowserRenaveReadiness {
  const expectedKeys = new Set([
    "certificate",
    "environment",
    "establishmentContact",
    "integration",
    "link",
    "mutations",
    "operatorIdentity",
    "queries",
  ]);
  if (
    !isRecord(value) ||
    Object.keys(value).length !== expectedKeys.size ||
    Object.keys(value).some((key) => !expectedKeys.has(key)) ||
    value.environment !== "homologation" ||
    typeof value.integration !== "string" ||
    !renaveIntegrationReadiness.has(
      value.integration as BrowserRenaveReadiness["integration"],
    ) ||
    typeof value.certificate !== "string" ||
    !renaveCertificateReadiness.has(
      value.certificate as BrowserRenaveReadiness["certificate"],
    ) ||
    typeof value.link !== "string" ||
    !renaveLinkStatuses.has(value.link as BrowserRenaveLinkStatus) ||
    typeof value.queries !== "string" ||
    !renaveQueryReadiness.has(
      value.queries as BrowserRenaveReadiness["queries"],
    ) ||
    typeof value.operatorIdentity !== "string" ||
    !renavePrincipalReadiness.has(
      value.operatorIdentity as BrowserRenaveReadiness["operatorIdentity"],
    ) ||
    typeof value.establishmentContact !== "string" ||
    !renavePrincipalReadiness.has(
      value.establishmentContact as BrowserRenaveReadiness["establishmentContact"],
    ) ||
    value.mutations !== "blocked"
  ) {
    throw new Error("Resposta de prontidão RENAVE inválida");
  }
  return {
    certificate: value.certificate as BrowserRenaveReadiness["certificate"],
    environment: "homologation",
    establishmentContact:
      value.establishmentContact as BrowserRenaveReadiness["establishmentContact"],
    integration: value.integration as BrowserRenaveReadiness["integration"],
    link: value.link as BrowserRenaveLinkStatus,
    mutations: "blocked",
    operatorIdentity:
      value.operatorIdentity as BrowserRenaveReadiness["operatorIdentity"],
    queries: value.queries as BrowserRenaveReadiness["queries"],
  };
}

const stockStates = new Set<BrowserStockState>([
  "SOLICITADO",
  "TRANSFERIDO",
  "CONFIRMADO",
  "FINALIZADO",
]);

const eligibilityStatuses = new Set<BrowserEligibilityStatus>([
  "eligible",
  "ineligible",
  "undetermined",
]);

const eligibilityImpediments = new Set<BrowserEligibilityImpediment>([
  "UNSPECIFIED_INELIGIBILITY",
  "VEHICLE_WRITTEN_OFF",
  "VEHICLE_ALARM",
  "PROVISIONAL_REGISTRATION",
  "CRV_ISSUANCE_PENDING",
  "RECALL_PENDING",
  "EXTRAJUDICIAL_RESTRICTION",
  "DETRAN_BLOCKING_RESTRICTION",
  "JUDICIAL_RESTRICTION",
  "FEDERAL_REVENUE_RESTRICTION",
  "PGFN_RESTRICTION",
  "THEFT_OR_ROBBERY",
  "ATPV_MISSING",
  "TRANSFER_AUTHORIZATION_FOR_DIFFERENT_ESTABLISHMENT",
  "SALE_NOTICE_FOR_DIFFERENT_BUYER",
  "SALE_INTENT_FOR_DIFFERENT_BUYER",
]);

function parseEligibility(value: unknown): BrowserEligibilitySummary {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 3 ||
    Object.keys(value).some(
      (key) =>
        key !== "status" &&
        key !== "detranUnavailable" &&
        key !== "impediments",
    ) ||
    typeof value.status !== "string" ||
    !eligibilityStatuses.has(value.status as BrowserEligibilityStatus) ||
    typeof value.detranUnavailable !== "boolean" ||
    !Array.isArray(value.impediments)
  ) {
    throw new Error("Resposta de aptidão inválida");
  }
  const seen = new Set<BrowserEligibilityImpediment>();
  const impediments = value.impediments.map((impediment) => {
    if (
      typeof impediment !== "string" ||
      !eligibilityImpediments.has(impediment as BrowserEligibilityImpediment) ||
      seen.has(impediment as BrowserEligibilityImpediment)
    ) {
      throw new Error("Resposta de aptidão inválida");
    }
    const code = impediment as BrowserEligibilityImpediment;
    seen.add(code);
    return code;
  });
  const status = value.status as BrowserEligibilityStatus;
  const semanticallyInvalid =
    (status === "eligible" &&
      (value.detranUnavailable || impediments.length > 0)) ||
    (status === "ineligible" &&
      (value.detranUnavailable || impediments.length === 0));
  if (semanticallyInvalid) {
    throw new Error("Resposta de aptidão inválida");
  }
  return {
    detranUnavailable: value.detranUnavailable,
    impediments,
    status,
  };
}

function parseStocks(value: unknown): readonly BrowserStockSummary[] {
  if (!Array.isArray(value)) throw new Error("Resposta de estoque inválida");
  const ids = new Set<number>();
  return value.map((stock) => {
    if (
      !isRecord(stock) ||
      Object.keys(stock).some(
        (key) => key !== "estado" && key !== "id" && key !== "placa",
      ) ||
      !Number.isSafeInteger(stock.id) ||
      (stock.id as number) <= 0 ||
      ids.has(stock.id as number) ||
      typeof stock.placa !== "string" ||
      !/^[A-Z0-9]{7}$/u.test(stock.placa) ||
      typeof stock.estado !== "string" ||
      !stockStates.has(stock.estado as BrowserStockState)
    ) {
      throw new Error("Item de estoque inválido");
    }
    ids.add(stock.id as number);
    return {
      estado: stock.estado as BrowserStockState,
      id: stock.id as number,
      placa: stock.placa,
    };
  });
}

class StockSearchClientError extends Error {
  constructor(readonly code?: string) {
    super("Consulta de estoque não concluída");
    this.name = "StockSearchClientError";
  }
}

class EligibilityClientError extends Error {
  constructor(readonly code?: string) {
    super("Consulta de aptidão não concluída");
    this.name = "EligibilityClientError";
  }
}

export class EstablishmentCreationClientError extends Error {
  constructor(
    readonly status: number,
    readonly code?: string,
    readonly retryAfterSeconds?: number,
  ) {
    super("Cadastro de estabelecimento não concluído");
    this.name = "EstablishmentCreationClientError";
  }
}

export class StockEntryCreationClientError extends Error {
  constructor(
    readonly status: number,
    readonly code?: string,
    readonly retryAfterSeconds?: number,
  ) {
    super("Criação local da entrada de estoque não concluída");
    this.name = "StockEntryCreationClientError";
  }
}

export const browserSessionClient: SessionClient = {
  async checkVehicleEligibility(tenantId, establishmentId, plate, crvType) {
    const response = await fetch(
      `/api/tenants/${encodeURIComponent(tenantId)}/establishments/${encodeURIComponent(establishmentId)}/vehicle-eligibility`,
      {
        body: JSON.stringify({ crvType, plate }),
        cache: "no-store",
        credentials: "same-origin",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        method: "POST",
      },
    );
    const value: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      throw new EligibilityClientError(
        isRecord(value) && typeof value.code === "string"
          ? value.code
          : undefined,
      );
    }
    return parseEligibility(value);
  },
  async createEstablishment(tenantId, input) {
    let response: Response;
    try {
      response = await fetch(
        `/api/tenants/${encodeURIComponent(tenantId)}/establishments`,
        {
          body: JSON.stringify({
            cnpj: input.cnpj,
            tradeName: input.tradeName,
          }),
          cache: "no-store",
          credentials: "same-origin",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            "idempotency-key": input.idempotencyKey,
          },
          method: "POST",
        },
      );
    } catch {
      throw new EstablishmentCreationClientError(0, "NETWORK_ERROR");
    }
    const value: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const retryAfter = Number(response.headers.get("retry-after"));
      throw new EstablishmentCreationClientError(
        response.status,
        isRecord(value) && typeof value.code === "string"
          ? value.code
          : undefined,
        Number.isInteger(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
      );
    }
    try {
      return parseCreatedEstablishment(value);
    } catch {
      // Um 2xx ilegível é ambíguo: a criação pode ter sido confirmada. A
      // mesma chave precisa ser preservada para uma repetição idempotente.
      throw new EstablishmentCreationClientError(0, "INVALID_RESPONSE");
    }
  },
  async createStockEntry(tenantId, establishmentId, input) {
    let response: Response;
    try {
      response = await fetch(
        `/api/tenants/${encodeURIComponent(tenantId)}/establishments/${encodeURIComponent(establishmentId)}/stock-entry-operations`,
        {
          body: JSON.stringify({
            dataCompra: input.dataCompra,
            emailVendedor: input.emailVendedor,
            valorCompra: input.valorCompra,
            veiculo: input.veiculo,
          }),
          cache: "no-store",
          credentials: "same-origin",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            "idempotency-key": input.idempotencyKey,
          },
          method: "POST",
        },
      );
    } catch {
      throw new StockEntryCreationClientError(0, "NETWORK_ERROR");
    }
    const value: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const retryAfter = Number(response.headers.get("retry-after"));
      throw new StockEntryCreationClientError(
        response.status,
        isRecord(value) && typeof value.code === "string"
          ? value.code
          : undefined,
        Number.isInteger(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
      );
    }
    try {
      const result = parseCreatedStockEntry(value);
      if (
        (response.status === 202 && result.replayed) ||
        (response.status === 200 &&
          (!result.replayed ||
            response.headers.get("idempotency-replayed") !== "true")) ||
        (response.status !== 200 && response.status !== 202)
      ) {
        throw new Error("Semântica HTTP incompatível");
      }
      return result;
    } catch {
      // Um 2xx ilegível é ambíguo; uma repetição precisa manter a chave.
      throw new StockEntryCreationClientError(0, "INVALID_RESPONSE");
    }
  },
  async load() {
    const response = await fetch("/api/session", {
      credentials: "same-origin",
      headers: { accept: "application/json" },
    });
    if (!response.ok) throw new Error("Não foi possível verificar a sessão");
    return parseSession(await response.json());
  },
  async loadTenants() {
    const response = await fetch("/api/tenants", {
      credentials: "same-origin",
      headers: { accept: "application/json" },
    });
    if (!response.ok)
      throw new Error("Não foi possível carregar as organizações");
    return parseTenants(await response.json());
  },
  async loadEstablishments(tenantId) {
    const response = await fetch(
      `/api/tenants/${encodeURIComponent(tenantId)}/establishments`,
      {
        credentials: "same-origin",
        headers: { accept: "application/json" },
      },
    );
    if (!response.ok)
      throw new Error("Não foi possível carregar os estabelecimentos");
    return parseEstablishmentCollection(await response.json());
  },
  async loadRenaveLinkStatus(tenantId, establishmentId) {
    const response = await fetch(
      `/api/tenants/${encodeURIComponent(tenantId)}/establishments/${encodeURIComponent(establishmentId)}/renave-link`,
      { credentials: "same-origin", headers: { accept: "application/json" } },
    );
    if (!response.ok) throw new Error("Não foi possível carregar o vínculo");
    return parseRenaveLink(await response.json());
  },
  async loadRenaveReadiness(tenantId, establishmentId) {
    const response = await fetch(
      `/api/tenants/${encodeURIComponent(tenantId)}/establishments/${encodeURIComponent(establishmentId)}/renave-readiness`,
      {
        cache: "no-store",
        credentials: "same-origin",
        headers: { accept: "application/json" },
      },
    );
    if (!response.ok) {
      throw new Error("Não foi possível carregar a prontidão RENAVE");
    }
    return parseRenaveReadiness(await response.json());
  },
  async logout() {
    const response = await fetch("/api/auth/logout", {
      method: "POST",
      credentials: "same-origin",
      headers: { accept: "application/json" },
    });
    if (!response.ok) throw new Error("Não foi possível encerrar a sessão");
    const value: unknown = await response.json();
    if (!isRecord(value) || value.loggedOut !== true) {
      throw new Error("Resposta de logout inválida");
    }
    if (typeof value.endSessionUrl !== "string") return {};
    const target = new URL(value.endSessionUrl);
    if (target.protocol !== "https:") {
      throw new Error("Destino de logout inválido");
    }
    return { endSessionUrl: target.href };
  },
  async runRenaveLinkPreflight(tenantId, establishmentId) {
    const response = await fetch(
      `/api/tenants/${encodeURIComponent(tenantId)}/establishments/${encodeURIComponent(establishmentId)}/renave-link-preflight`,
      {
        method: "POST",
        credentials: "same-origin",
        headers: { accept: "application/json" },
      },
    );
    if (!response.ok) throw new Error("Não foi possível verificar o vínculo");
  },
  async searchStocks(tenantId, establishmentId, plate) {
    const response = await fetch(
      `/api/tenants/${encodeURIComponent(tenantId)}/establishments/${encodeURIComponent(establishmentId)}/stocks/search`,
      {
        body: JSON.stringify({ plate }),
        cache: "no-store",
        credentials: "same-origin",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        method: "POST",
      },
    );
    const value: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      throw new StockSearchClientError(
        isRecord(value) && typeof value.code === "string"
          ? value.code
          : undefined,
      );
    }
    return parseStocks(value);
  },
};

export interface AppProps {
  client?: SessionClient;
  locationSearch?: string;
  onAuthErrorConsumed?: () => void;
  redirect?: (url: string) => void;
  stockEntryOperationsEnabled?: boolean;
}

export interface AuthFeedback {
  message: string;
  title: string;
}

const expiredLoginFeedback: AuthFeedback = {
  message:
    "Por segurança, essa tentativa de acesso expirou ou não pertence a este navegador. Inicie uma nova tentativa.",
  title: "Tentativa de acesso expirada",
};

/** Converte apenas códigos internos conhecidos em texto; nunca reflete a URL. */
export function authFeedbackFromSearch(
  search: string,
): AuthFeedback | undefined {
  const parameters = new URLSearchParams(search);
  if (!parameters.has("auth_error")) return undefined;
  switch (parameters.get("auth_error")) {
    case "provider_error":
      return {
        message:
          "O provedor corporativo não concluiu o acesso. Você pode tentar novamente quando estiver pronto.",
        title: "Acesso não concluído",
      };
    case "exchange_failed":
      return {
        message:
          "O provedor corporativo está temporariamente indisponível. Sua sessão anterior, se existir, foi preservada.",
        title: "Não foi possível concluir o acesso",
      };
    case "invalid_request":
    case "invalid_state":
    case "binding_mismatch":
    case "nonce_mismatch":
      return expiredLoginFeedback;
    default:
      return {
        message:
          "Não foi possível concluir o acesso. Nenhum detalhe recebido pela URL foi exibido.",
        title: "Acesso não concluído",
      };
  }
}

function clearCurrentAuthError(): void {
  const current = new URL(window.location.href);
  current.searchParams.delete("auth_error");
  window.history.replaceState(
    window.history.state,
    "",
    `${current.pathname}${current.search}${current.hash}`,
  );
}

type ViewState =
  | { status: "loading" }
  | { resource: "session"; status: "error" }
  | {
      resource: "directory";
      session: AuthenticatedSession;
      status: "error";
    }
  | {
      status: "ready";
      session: BrowserSession;
      tenants: readonly BrowserTenant[];
    };

type RenaveLinkView =
  | { status: "idle" | "loading" | "error" }
  | { link: BrowserRenaveLink; status: "ready" };

type RenaveReadinessView =
  | { status: "idle" | "loading" | "error" }
  | { readiness: BrowserRenaveReadiness; status: "ready" };

export function App({
  client = browserSessionClient,
  locationSearch = window.location.search,
  onAuthErrorConsumed = clearCurrentAuthError,
  redirect = (url) => window.location.assign(url),
  stockEntryOperationsEnabled = false,
}: AppProps) {
  const [authFeedback] = useState(() => authFeedbackFromSearch(locationSearch));
  const [view, setView] = useState<ViewState>({ status: "loading" });
  const [logoutPending, setLogoutPending] = useState(false);
  const [logoutError, setLogoutError] = useState(false);
  const [contextLoading, setContextLoading] = useState(false);
  const [contextError, setContextError] = useState(false);
  const [preflightPendingKey, setPreflightPendingKey] = useState<string>();
  const [preflightErrorKey, setPreflightErrorKey] = useState<string>();
  const [renaveLinkView, setRenaveLinkView] = useState<RenaveLinkView>({
    status: "idle",
  });
  const [renaveReadinessView, setRenaveReadinessView] =
    useState<RenaveReadinessView>({ status: "idle" });
  const [linkReloadVersion, setLinkReloadVersion] = useState(0);
  const [readinessReloadVersion, setReadinessReloadVersion] = useState(0);
  const [selectedTenantId, setSelectedTenantId] = useState("");
  const [establishmentManagement, setEstablishmentManagement] =
    useState<EstablishmentManagementCapability>("denied");
  const [establishments, setEstablishments] = useState<
    readonly BrowserEstablishment[]
  >([]);
  const [selectedEstablishmentByTenant, setSelectedEstablishmentByTenant] =
    useState<Record<string, string>>({});
  const tenantRequestVersion = useRef(0);
  const loadRequestVersion = useRef(0);
  const linkLoadVersion = useRef(0);
  const readinessLoadVersion = useRef(0);
  const activeSelectionKeyRef = useRef("");
  const selectedTenantIdRef = useRef("");
  selectedTenantIdRef.current = selectedTenantId;

  useEffect(() => {
    if (authFeedback) onAuthErrorConsumed();
  }, [authFeedback, onAuthErrorConsumed]);

  const load = useCallback(async () => {
    const requestVersion = ++loadRequestVersion.current;
    tenantRequestVersion.current += 1;
    setView({ status: "loading" });
    let session: BrowserSession;
    try {
      session = await client.load();
    } catch {
      if (loadRequestVersion.current === requestVersion) {
        setView({ resource: "session", status: "error" });
      }
      return;
    }

    if (!session.authenticated) {
      if (loadRequestVersion.current !== requestVersion) return;
      setSelectedTenantId("");
      setEstablishmentManagement("denied");
      setEstablishments([]);
      setSelectedEstablishmentByTenant({});
      setView({ status: "ready", session, tenants: [] });
      return;
    }

    try {
      const tenants = session.authenticated ? await client.loadTenants() : [];
      const initialTenantId = tenants[0]?.tenantId ?? "";
      const initialCollection = initialTenantId
        ? await client.loadEstablishments(initialTenantId)
        : {
            capabilities: { establishmentManagement: "denied" as const },
            establishments: [],
          };
      const initialEstablishments = initialCollection.establishments;
      if (loadRequestVersion.current !== requestVersion) return;
      setSelectedTenantId(initialTenantId);
      setEstablishmentManagement(
        initialCollection.capabilities.establishmentManagement,
      );
      setEstablishments(initialEstablishments);
      setSelectedEstablishmentByTenant(
        initialTenantId && initialEstablishments[0]
          ? { [initialTenantId]: initialEstablishments[0].id }
          : {},
      );
      setView({ status: "ready", session, tenants });
    } catch {
      if (loadRequestVersion.current === requestVersion) {
        setView({ resource: "directory", session, status: "error" });
      }
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const activeEstablishmentId = selectedEstablishmentByTenant[selectedTenantId];
  activeSelectionKeyRef.current = `${selectedTenantId}:${activeEstablishmentId ?? ""}`;
  useEffect(() => {
    const authenticated = view.status === "ready" && view.session.authenticated;
    if (!authenticated || !selectedTenantId || !activeEstablishmentId) {
      linkLoadVersion.current += 1;
      setRenaveLinkView({ status: "idle" });
      return;
    }
    const requestVersion = ++linkLoadVersion.current;
    setRenaveLinkView({ status: "loading" });
    void client
      .loadRenaveLinkStatus(selectedTenantId, activeEstablishmentId)
      .then((link) => {
        if (linkLoadVersion.current === requestVersion) {
          setRenaveLinkView({ link, status: "ready" });
        }
      })
      .catch(() => {
        if (linkLoadVersion.current === requestVersion) {
          setRenaveLinkView({ status: "error" });
        }
      });
  }, [
    activeEstablishmentId,
    client,
    linkReloadVersion,
    selectedTenantId,
    view,
  ]);

  useEffect(() => {
    const authenticated = view.status === "ready" && view.session.authenticated;
    if (!authenticated || !selectedTenantId || !activeEstablishmentId) {
      readinessLoadVersion.current += 1;
      setRenaveReadinessView({ status: "idle" });
      return;
    }
    const selectionKey = `${selectedTenantId}:${activeEstablishmentId}`;
    const requestVersion = ++readinessLoadVersion.current;
    setRenaveReadinessView({ status: "loading" });
    void client
      .loadRenaveReadiness(selectedTenantId, activeEstablishmentId)
      .then((readiness) => {
        if (
          readinessLoadVersion.current === requestVersion &&
          activeSelectionKeyRef.current === selectionKey
        ) {
          setRenaveReadinessView({ readiness, status: "ready" });
        }
      })
      .catch(() => {
        if (
          readinessLoadVersion.current === requestVersion &&
          activeSelectionKeyRef.current === selectionKey
        ) {
          setRenaveReadinessView({ status: "error" });
        }
      });
  }, [
    activeEstablishmentId,
    client,
    readinessReloadVersion,
    selectedTenantId,
    view,
  ]);

  if (view.status === "loading") {
    return (
      <main className="session-state" aria-busy="true">
        <p role="status">Verificando sua sessão segura…</p>
      </main>
    );
  }

  if (view.status === "error") {
    const directoryUnavailable = view.resource === "directory";
    return (
      <main className="session-state">
        <section
          className="session-error"
          aria-labelledby="session-error-title"
          role="alert"
        >
          <AlertCircle size={24} aria-hidden="true" />
          <div>
            <h1 id="session-error-title">
              {directoryUnavailable
                ? "Não foi possível carregar sua organização"
                : "Não foi possível verificar o acesso"}
            </h1>
            <p>
              {directoryUnavailable
                ? "Sua sessão continua ativa, mas o diretório de organizações ou estabelecimentos está indisponível. Nenhuma operação foi liberada."
                : "A sessão não foi alterada. Tente novamente antes de iniciar uma operação."}
            </p>
            <Button
              variant="secondary"
              leadingIcon={<RefreshCw size={18} />}
              onClick={() => void load()}
            >
              Tentar novamente
            </Button>
          </div>
        </section>
      </main>
    );
  }

  const { session, tenants } = view;
  const environment = resolveAppEnvironment(session.environment);
  if (!session.authenticated) {
    return (
      <LoginPage
        environment={environment}
        {...(authFeedback ? { authFeedback } : {})}
      />
    );
  }

  async function logout() {
    setLogoutPending(true);
    setLogoutError(false);
    try {
      const result = await client.logout();
      setView({
        status: "ready",
        tenants: [],
        session: {
          authenticated: false,
          authMode: "oidc",
          environment: session.environment,
        },
      });
      setSelectedTenantId("");
      setEstablishmentManagement("denied");
      setEstablishments([]);
      setSelectedEstablishmentByTenant({});
      tenantRequestVersion.current += 1;
      loadRequestVersion.current += 1;
      linkLoadVersion.current += 1;
      readinessLoadVersion.current += 1;
      if (result.endSessionUrl) redirect(result.endSessionUrl);
    } catch {
      setLogoutError(true);
    } finally {
      setLogoutPending(false);
    }
  }

  async function runPreflight() {
    if (!selectedTenantId || !activeEstablishmentId) return;
    const selectionKey = `${selectedTenantId}:${activeEstablishmentId}`;
    setPreflightPendingKey(selectionKey);
    setPreflightErrorKey(undefined);
    try {
      await client.runRenaveLinkPreflight(
        selectedTenantId,
        activeEstablishmentId,
      );
    } catch {
      if (activeSelectionKeyRef.current === selectionKey) {
        setPreflightErrorKey(selectionKey);
      }
    } finally {
      if (activeSelectionKeyRef.current === selectionKey) {
        setReadinessReloadVersion((current) => current + 1);
        const requestVersion = ++linkLoadVersion.current;
        setRenaveLinkView({ status: "loading" });
        try {
          const link = await client.loadRenaveLinkStatus(
            selectedTenantId,
            activeEstablishmentId,
          );
          if (
            linkLoadVersion.current === requestVersion &&
            activeSelectionKeyRef.current === selectionKey
          ) {
            setRenaveLinkView({ link, status: "ready" });
          }
        } catch {
          if (
            linkLoadVersion.current === requestVersion &&
            activeSelectionKeyRef.current === selectionKey
          ) {
            setRenaveLinkView({ status: "error" });
          }
        }
      }
      setPreflightPendingKey((current) =>
        current === selectionKey ? undefined : current,
      );
    }
  }

  if (tenants.length === 0) {
    return (
      <main className="session-state">
        <section className="session-error" aria-labelledby="tenant-empty-title">
          <AlertCircle size={24} aria-hidden="true" />
          <div>
            <h1 id="tenant-empty-title">
              Seu acesso ainda não está vinculado a uma organização
            </h1>
            <p>
              Peça ao administrador da sua empresa para liberar seu acesso.
              Nenhuma operação RENAVE foi disponibilizada para esta conta.
            </p>
            {logoutError ? (
              <p role="alert">
                Não foi possível encerrar a sessão. Você continua conectado e
                pode tentar novamente.
              </p>
            ) : null}
            <Button
              variant="secondary"
              loading={logoutPending}
              loadingLabel="Saindo..."
              onClick={() => void logout()}
            >
              Sair
            </Button>
          </div>
        </section>
      </main>
    );
  }

  const selectedTenant =
    tenants.find((tenant) => tenant.tenantId === selectedTenantId) ??
    tenants[0];

  async function selectTenant(tenantId: string) {
    const requestVersion = ++tenantRequestVersion.current;
    const previousTenantId = selectedTenantId;
    const previousEstablishments = establishments;
    const previousManagement = establishmentManagement;
    setContextError(false);
    setContextLoading(true);
    setSelectedTenantId(tenantId);
    setEstablishmentManagement("denied");
    setEstablishments([]);
    try {
      const nextCollection = await client.loadEstablishments(tenantId);
      const nextEstablishments = nextCollection.establishments;
      if (tenantRequestVersion.current === requestVersion) {
        setEstablishments(nextEstablishments);
        setEstablishmentManagement(
          nextCollection.capabilities.establishmentManagement,
        );
        setSelectedEstablishmentByTenant((current) => {
          const remembered = current[tenantId];
          const selected = nextEstablishments.some(
            (establishment) => establishment.id === remembered,
          )
            ? remembered
            : nextEstablishments[0]?.id;
          if (!selected) {
            const next = { ...current };
            delete next[tenantId];
            return next;
          }
          return { ...current, [tenantId]: selected };
        });
      }
    } catch {
      if (tenantRequestVersion.current === requestVersion) {
        setSelectedTenantId(previousTenantId);
        setEstablishmentManagement(previousManagement);
        setEstablishments(previousEstablishments);
        setContextError(true);
      }
    } finally {
      if (tenantRequestVersion.current === requestVersion) {
        setContextLoading(false);
      }
    }
  }

  async function createEstablishment(
    input: CreateEstablishmentInput,
  ): Promise<CreateEstablishmentResult> {
    const tenantId = selectedTenantId;
    const requestVersion = tenantRequestVersion.current;
    let result: CreateEstablishmentResult;
    try {
      result = await client.createEstablishment(tenantId, input);
    } catch (error) {
      if (
        tenantRequestVersion.current !== requestVersion ||
        selectedTenantIdRef.current !== tenantId
      ) {
        throw new EstablishmentCreationClientError(0, "CONTEXT_CHANGED");
      }
      if (error instanceof EstablishmentCreationClientError) {
        if (error.status === 401) void load();
        if (error.code === "MFA_REQUIRED") {
          setEstablishmentManagement("mfa_required");
        }
        if (
          error.code === "TENANT_RESOURCE_NOT_FOUND" ||
          error.code === "ESTABLISHMENT_CNPJ_CONFLICT"
        ) {
          void selectTenant(tenantId);
        }
      }
      throw error;
    }
    if (
      tenantRequestVersion.current !== requestVersion ||
      selectedTenantIdRef.current !== tenantId
    ) {
      throw new EstablishmentCreationClientError(0, "CONTEXT_CHANGED");
    }
    setEstablishments((current) => [
      ...current.filter(
        (establishment) => establishment.id !== result.establishment.id,
      ),
      result.establishment,
    ]);
    setSelectedEstablishmentByTenant((current) => ({
      ...current,
      [tenantId]: result.establishment.id,
    }));
    linkLoadVersion.current += 1;
    readinessLoadVersion.current += 1;
    setRenaveLinkView({
      link: { preflightAvailable: false, status: "not_started" },
      status: "ready",
    });
    return result;
  }

  return (
    <DashboardPage
      establishmentManagement={establishmentManagement}
      environment={environment}
      establishments={establishments.map((establishment) => ({
        id: establishment.id,
        label: establishment.tradeName,
      }))}
      contextError={contextError}
      contextLoading={contextLoading}
      logoutPending={logoutPending}
      logoutError={logoutError}
      {...(authFeedback ? { authFeedback } : {})}
      {...(renaveLinkView.status === "ready"
        ? { linkStatus: renaveLinkView.link.status }
        : {})}
      linkStatusError={renaveLinkView.status === "error"}
      linkStatusLoading={renaveLinkView.status === "loading"}
      {...(renaveReadinessView.status === "ready"
        ? { readiness: renaveReadinessView.readiness }
        : {})}
      readinessError={renaveReadinessView.status === "error"}
      readinessLoading={renaveReadinessView.status === "loading"}
      stockEntryOperationsEnabled={stockEntryOperationsEnabled}
      onCheckEligibility={(plate, crvType) =>
        client.checkVehicleEligibility(
          selectedTenantId,
          activeEstablishmentId ?? "",
          plate,
          crvType,
        )
      }
      onCreateEstablishment={createEstablishment}
      onCreateStockEntry={(input) =>
        client.createStockEntry(
          selectedTenantId,
          activeEstablishmentId ?? "",
          input,
        )
      }
      onRunPreflight={() => void runPreflight()}
      onSearchStocks={(plate) =>
        client.searchStocks(
          selectedTenantId,
          activeEstablishmentId ?? "",
          plate,
        )
      }
      onReloadLinkStatus={() => setLinkReloadVersion((current) => current + 1)}
      preflightAvailable={
        renaveLinkView.status === "ready" &&
        renaveLinkView.link.preflightAvailable &&
        renaveReadinessView.status === "ready" &&
        renaveReadinessView.readiness.integration === "configured" &&
        (renaveReadinessView.readiness.certificate === "ready" ||
          renaveReadinessView.readiness.certificate === "warning")
      }
      preflightError={
        preflightErrorKey ===
        `${selectedTenantId}:${activeEstablishmentId ?? ""}`
      }
      preflightPending={
        preflightPendingKey ===
        `${selectedTenantId}:${activeEstablishmentId ?? ""}`
      }
      onEstablishmentChange={(establishmentId) =>
        setSelectedEstablishmentByTenant((current) => ({
          ...current,
          [selectedTenantId]: establishmentId,
        }))
      }
      onLogout={logout}
      onTenantChange={(tenantId) => void selectTenant(tenantId)}
      {...(selectedEstablishmentByTenant[selectedTenantId]
        ? {
            selectedEstablishmentId:
              selectedEstablishmentByTenant[selectedTenantId],
          }
        : {})}
      {...(selectedTenant ? { selectedTenantId: selectedTenant.tenantId } : {})}
      tenants={tenants.map((tenant) => ({
        id: tenant.tenantId,
        label: tenant.displayName,
      }))}
      userDisplayName={
        session.user.name ?? session.user.email ?? "Usuário autenticado"
      }
    />
  );
}
