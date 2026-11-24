import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const CONNECTOR_MODULE = "../packages/renave-connector/dist/index.js";

const REQUIRED_ENVIRONMENT = [
  "RENAVE_MTLS_CA_FILE",
  "RENAVE_MTLS_CERT_FILE",
  "RENAVE_MTLS_KEY_FILE",
  "RENAVE_INTEGRATOR_CNPJ",
  "RENAVE_ESTABLISHMENT_CNPJ",
];

export class SerproSmokeConfigurationError extends Error {
  code = "SERPRO_SMOKE_CONFIG_MISSING";

  constructor(missing) {
    super(`Configuração ausente: ${missing.join(", ")}`);
    this.name = "SerproSmokeConfigurationError";
    this.missing = Object.freeze([...missing]);
  }
}

export class SerproSmokeMaterialReadError extends Error {
  code = "SERPRO_SMOKE_MATERIAL_UNAVAILABLE";

  constructor(field) {
    super(`Material mTLS indisponível: ${field}`);
    this.name = "SerproSmokeMaterialReadError";
    this.field = field;
  }
}

function optionalText(value) {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

export function loadHomologationSmokeConfig(environment = process.env) {
  const missing = REQUIRED_ENVIRONMENT.filter(
    (name) => optionalText(environment[name]) === undefined,
  );
  if (missing.length > 0) throw new SerproSmokeConfigurationError(missing);
  return Object.freeze({
    caFile: optionalText(environment.RENAVE_MTLS_CA_FILE),
    certificateFile: optionalText(environment.RENAVE_MTLS_CERT_FILE),
    establishmentCnpj: optionalText(environment.RENAVE_ESTABLISHMENT_CNPJ),
    integratorCnpj: optionalText(environment.RENAVE_INTEGRATOR_CNPJ),
    keyFile: optionalText(environment.RENAVE_MTLS_KEY_FILE),
    keyPassphrase: optionalText(environment.RENAVE_MTLS_KEY_PASSPHRASE),
  });
}

async function readMaterial(path, field, reader) {
  try {
    return await reader(path, "utf8");
  } catch {
    throw new SerproSmokeMaterialReadError(field);
  }
}

export async function runHomologationSmoke(
  config,
  { loadConnector = () => import(CONNECTOR_MODULE), reader = readFile } = {},
) {
  const [ca, cert, key] = await Promise.all([
    readMaterial(config.caFile, "ca", reader),
    readMaterial(config.certificateFile, "cert", reader),
    readMaterial(config.keyFile, "key", reader),
  ]);
  const {
    createHomologationPemMtlsClient,
    HttpRenaveTransport,
    RenaveConnector,
  } = await loadConnector();
  const mtls = createHomologationPemMtlsClient("homologation", {
    ca,
    cert,
    key,
    ...(config.keyPassphrase === undefined
      ? {}
      : { passphrase: config.keyPassphrase }),
  });
  try {
    const connector = new RenaveConnector(
      new HttpRenaveTransport({
        environment: "homologation",
        request: mtls.request,
      }),
    );
    await connector.verifyIdentity({
      environment: "homologation",
      establishmentCnpj: config.establishmentCnpj,
      establishmentId: "serpro-smoke-establishment",
      integratorCnpj: config.integratorCnpj,
      tenantId: "serpro-smoke-tenant",
    });
  } finally {
    mtls.close();
  }
}

function safeFailure(error) {
  if (error instanceof SerproSmokeConfigurationError) {
    return `${error.code}: ${error.missing.join(",")}`;
  }
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[A-Z][A-Z0-9_]{2,79}$/u.test(error.code)
  ) {
    return error.code;
  }
  return "SERPRO_SMOKE_FAILED";
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  try {
    await runHomologationSmoke(loadHomologationSmokeConfig());
    console.log(
      "homologation: identidade mTLS confirmada em modo somente leitura",
    );
  } catch (error) {
    console.error(`homologation: ${safeFailure(error)}`);
    process.exitCode = 1;
  }
}
