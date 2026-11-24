/**
 * Valores descartáveis exclusivos do CLI/setup e dos testes locais. Este
 * módulo não faz parte de nenhum entrypoint de runtime.
 */
export const LOCAL_DEFAULTS = {
  adminUrl: "postgres://postgres:renave_local_dev@127.0.0.1:54317/renave",
  migratorPassword: "renave_migrator_local",
  appPassword: "renave_app_local",
  identityAppPassword: "renave_identity_app_local",
  maintenanceAppPassword: "renave_maintenance_app_local",
  operationWorkerPassword: "renave_operation_worker_local",
  profileProvisionerPassword: "renave_profile_provisioner_local",
  profileReaderPassword: "renave_profile_reader_local",
  platformProvisionerPassword: "renave_platform_provisioner_local",
  platformReaderPassword: "renave_platform_reader_local",
} as const;
