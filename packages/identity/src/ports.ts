/**
 * Portas do módulo de identidade. Nada aqui conhece Fastify, Redis ou
 * Keycloak: o serviço depende apenas destas interfaces, de modo que os testes
 * não precisam de um IdP real e o armazenamento pode trocar de memória para
 * Redis/Postgres sem alterar o fluxo.
 */

/** Identidade já verificada (assinatura, issuer, audience, expiração). */
export interface VerifiedIdentity {
  /** Issuer validado literalmente contra discovery/configuração. */
  issuer: string;
  /** Claim `sub`: identificador estável do usuário no IdP. */
  subject: string;
  /** Claim `nonce` exatamente como veio no ID token. */
  nonce: string | undefined;
  /** Claim `acr` validado e normalizado; nunca implica MFA sem política local. */
  authenticationContext?: string;
  /** Claim `auth_time` validado, em milissegundos Unix. */
  authenticationTime?: number;
  name?: string;
  email?: string;
  roles: readonly string[];
}

export interface AuthorizationRequest {
  state: string;
  nonce: string;
  codeChallenge: string;
  redirectUri: string;
  /** Valor server-side de OIDC `max_age`; o navegador não o escolhe. */
  maxAgeSeconds?: number;
}

export interface CodeExchange {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}

/**
 * Cliente OIDC. A implementação real conversa com o IdP; o ID token é
 * validado e descartado dentro dela. Tokens nunca atravessam esta porta.
 */
export interface OidcClient {
  buildAuthorizationUrl(request: AuthorizationRequest): Promise<string>;
  exchangeCode(exchange: CodeExchange): Promise<VerifiedIdentity>;
  /** URL de logout no IdP (RP-initiated logout), quando suportada e configurada. */
  buildEndSessionUrl?(): Promise<string | undefined>;
}

/** Tentativa de login em andamento. Vive poucos minutos e é de uso único. */
export interface LoginAttempt {
  /** O verifier PKCE precisa ser enviado ao IdP; fica só no servidor. */
  codeVerifier: string;
  /** SHA-256 (base64url) do nonce enviado ao IdP. */
  nonceHash: string;
  /** SHA-256 do segredo entregue ao navegador por cookie (anti login-CSRF). */
  bindingHash: string;
  returnTo: string;
  createdAt: number;
  expiresAt: number;
}

export interface SessionRecord {
  /** Issuer persistido junto com o subject; sessões legadas falham fechadas. */
  issuer: string;
  subject: string;
  /** Evidência `acr` mínima; o serviço reavalia a política a cada leitura. */
  authenticationContext?: string;
  /** A política vigente no callback aceitou o contexto; nunca elevar depois. */
  mfaVerifiedAtLogin: boolean;
  /** Instante `auth_time` do IdP; nunca derivado do horário da sessão. */
  mfaAuthenticatedAt?: number;
  name?: string;
  email?: string;
  roles: readonly string[];
  createdAt: number;
  lastSeenAt: number;
  /** Fim por inatividade. */
  idleExpiresAt: number;
  /** Fim absoluto, independente de atividade. */
  absoluteExpiresAt: number;
}

/**
 * Armazenamento de sessões e tentativas de login. As chaves recebidas já são
 * SHA-256 dos identificadores entregues ao navegador, então um vazamento do
 * armazenamento não revela cookies utilizáveis.
 *
 * Contrato para implementações Redis/Postgres:
 * - `consumeLoginAttempt` DEVE ser atômico (GETDEL / DELETE ... RETURNING);
 *   é isso que impede replay do callback;
 * - registros expirados nunca podem ser devolvidos.
 */
export interface SessionStore {
  saveLoginAttempt(key: string, attempt: LoginAttempt): Promise<void>;
  consumeLoginAttempt(
    key: string,
    now: number,
  ): Promise<LoginAttempt | undefined>;
  saveSession(key: string, session: SessionRecord): Promise<void>;
  getSession(key: string, now: number): Promise<SessionRecord | undefined>;
  /** Só atualiza se a sessão ainda existir: nunca ressuscita uma sessão encerrada. */
  touchSession(
    key: string,
    lastSeenAt: number,
    idleExpiresAt: number,
  ): Promise<void>;
  deleteSession(key: string): Promise<void>;
}

export interface Clock {
  now(): number;
}
