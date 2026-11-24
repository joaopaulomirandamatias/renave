import { fileURLToPath } from "node:url";

/** Dono dos objetos e executor das migrations. Nunca usado pela aplicação. */
export const MIGRATOR_ROLE = "renave_migrator";
/** Papel de runtime da API: sem BYPASSRLS, não proprietário, só DML mínimo. */
export const APP_ROLE = "renave_app";
/** Papel exclusivo do armazenamento OIDC; não acessa tabelas de negócio. */
export const IDENTITY_APP_ROLE = "renave_identity_app";
/** Papel do job operacional; apenas EXECUTE em rotinas fechadas de manutenção. */
export const MAINTENANCE_APP_ROLE = "renave_maintenance_app";
/** Papel exclusivo do worker de operações; somente EXECUTE em rotinas fechadas. */
export const OPERATION_WORKER_ROLE = "renave_operation_worker";
/** Papel offline que promove HELD_LOCAL após revalidar o selo regulatório. */
export const OPERATION_PROMOTER_ROLE = "renave_operation_promoter";
/** Papel administrativo mínimo: somente EXECUTE nas rotinas de perfis RENAVE. */
export const PROFILE_PROVISIONER_ROLE = "renave_profile_provisioner";
/** Papel offline exclusivo para jurisdição e escopos Credencia. */
export const CREDENTIAL_SCOPE_PROVISIONER_ROLE =
  "renave_credential_scope_provisioner";
/** Papel global somente leitura para consultar status sanitizado de perfis. */
export const PROFILE_READER_ROLE = "renave_profile_reader";
/** Leitor isolado do console global; somente EXECUTE em consultas fechadas. */
export const PLATFORM_READER_ROLE = "renave_platform_reader";
/** Provisionador offline de operadores globais; não lê a fila operacional. */
export const PLATFORM_PROVISIONER_ROLE = "renave_platform_provisioner";
/** Esquema de negócio e do ledger de migrations. */
export const SCHEMA = "renave";
/** GUC transacional com o tenant ativo, lido por `renave.current_tenant_id()`. */
export const TENANT_SETTING = "renave.tenant_id";

/** Diretório padrão das migrations SQL versionadas (db/migrations). */
export const DEFAULT_MIGRATIONS_DIR = fileURLToPath(
  new URL("../../../db/migrations", import.meta.url),
);

export class ConfigError extends Error {
  override name = "ConfigError";
}

export function requireEnv(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const value = env[name];
  if (value === undefined || value.trim() === "") {
    throw new ConfigError(`Variável de ambiente obrigatória ausente: ${name}`);
  }
  return value;
}

export function isLoopbackUrl(connectionString: string): boolean {
  const { hostname } = new URL(connectionString);
  return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(hostname);
}

/** Troca usuário/senha de uma URL de conexão, preservando host, porta e banco. */
export function withCredentials(
  connectionString: string,
  user: string,
  password: string,
): string {
  const url = new URL(connectionString);
  url.username = user;
  url.password = password;
  return url.toString();
}
