export const MAX_SERPRO_JSON_RESPONSE_BYTES = 10 * 1024 * 1024;

const ALLOWED_SWAGGER_ORIGINS = new Set([
  "https://hom.renave.estaleiro.serpro.gov.br",
  "https://renave.estaleiro.serpro.gov.br",
]);
const ALLOWED_SWAGGER_PATH = "/renave-ws/v2/api-docs";
const ALLOWED_SWAGGER_GROUP = "Estabelecimento (Concessionária ou Revenda)";

class BoundedJsonResponseError extends Error {}

function responseTooLarge(maxBytes) {
  return new BoundedJsonResponseError(
    `resposta excede limite de ${maxBytes} bytes`,
  );
}

async function cancelBestEffort(cancel) {
  try {
    await cancel();
  } catch {
    // A falha ao interromper o transporte não pode mascarar a rejeição primária.
  }
}

export function assertOfficialSerproSwaggerSource(source) {
  let parsed;
  try {
    parsed = new URL(source);
  } catch {
    throw new Error("fonte Swagger oficial inválida");
  }
  if (
    !ALLOWED_SWAGGER_ORIGINS.has(parsed.origin) ||
    parsed.pathname !== ALLOWED_SWAGGER_PATH ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.hash !== "" ||
    parsed.searchParams.size !== 1 ||
    parsed.searchParams.get("group") !== ALLOWED_SWAGGER_GROUP
  ) {
    throw new Error("fonte Swagger fora da allowlist oficial");
  }
}

export async function readBoundedJsonBody(
  response,
  maxBytes = MAX_SERPRO_JSON_RESPONSE_BYTES,
) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new TypeError("limite de resposta JSON inválido");
  }

  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^\d+$/u.test(declaredLength)) {
      await cancelBestEffort(() => response.body?.cancel());
      throw new BoundedJsonResponseError(
        "Content-Length da resposta é inválido",
      );
    }
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength)) {
      await cancelBestEffort(() => response.body?.cancel());
      throw new BoundedJsonResponseError(
        "Content-Length da resposta é inválido",
      );
    }
    if (parsedLength > maxBytes) {
      await cancelBestEffort(() => response.body?.cancel());
      throw responseTooLarge(maxBytes);
    }
  }
  if (!response.body) return Buffer.alloc(0);

  const chunks = [];
  let receivedBytes = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > maxBytes - receivedBytes) {
        await cancelBestEffort(() => reader.cancel());
        throw responseTooLarge(maxBytes);
      }
      const bytes = Buffer.from(value);
      receivedBytes += bytes.byteLength;
      chunks.push(bytes);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, receivedBytes);
}

export async function fetchBoundedJson(
  label,
  source,
  {
    fetchImpl = globalThis.fetch,
    maxBytes = MAX_SERPRO_JSON_RESPONSE_BYTES,
    timeoutMs = 30_000,
  } = {},
) {
  assertOfficialSerproSwaggerSource(source);
  let response;
  try {
    response = await fetchImpl(source, {
      headers: {
        accept: "application/json",
        "accept-encoding": "identity",
      },
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new Error(`${label}: falha ao consultar Swagger oficial`);
  }

  if (!response.ok) {
    await cancelBestEffort(() => response.body?.cancel());
    throw new Error(`${label}: Swagger respondeu HTTP ${response.status}`);
  }

  let bytes;
  try {
    bytes = await readBoundedJsonBody(response, maxBytes);
  } catch (error) {
    if (
      error instanceof BoundedJsonResponseError ||
      error instanceof TypeError
    ) {
      throw error;
    }
    throw new Error(`${label}: falha ao ler Swagger oficial`);
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { bytes, document: JSON.parse(text) };
  } catch {
    throw new Error(`${label}: Swagger retornou JSON inválido`);
  }
}
