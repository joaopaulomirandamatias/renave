import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const baselineUrl = new URL(
  "../contracts/serpro/guidance-baseline.json",
  import.meta.url,
);

export const MAX_GUIDANCE_RESPONSE_BYTES = 10 * 1024 * 1024;

const GUIDANCE_ORIGIN = "https://centraldeajuda.serpro.gov.br";
const GUIDANCE_PAGE_PATHS = new Set([
  "/renave/",
  "/renave/central-ajuda/dicas/",
  "/renave/central-ajuda/homologacao/",
  "/renave/diagramas/",
]);
const GUIDANCE_ASSET_PATH =
  /^\/renave\/assets\/diagramas\/[A-Za-z0-9_-]+\.png$/u;

class BoundedGuidanceResponseError extends Error {}

async function cancelBestEffort(cancel) {
  try {
    await cancel();
  } catch {
    // A falha de cancelamento não pode mascarar a rejeição primária.
  }
}

export function assertOfficialGuidanceSource(source, accept) {
  let parsed;
  try {
    parsed = new URL(source);
  } catch {
    throw new Error("fonte de orientação oficial inválida");
  }
  const allowedPath =
    accept === "text/html"
      ? GUIDANCE_PAGE_PATHS.has(parsed.pathname)
      : accept === "image/png" && GUIDANCE_ASSET_PATH.test(parsed.pathname);
  if (
    parsed.origin !== GUIDANCE_ORIGIN ||
    !allowedPath ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error("fonte de orientação fora da allowlist oficial");
  }
}

export function htmlToText(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&nbsp;", " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function readBoundedBody(
  response,
  maxBytes = MAX_GUIDANCE_RESPONSE_BYTES,
) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new TypeError("limite de resposta de orientação inválido");
  }
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^\d+$/u.test(declaredLength)) {
      await cancelBestEffort(() => response.body?.cancel());
      throw new BoundedGuidanceResponseError(
        "Content-Length da orientação é inválido",
      );
    }
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength)) {
      await cancelBestEffort(() => response.body?.cancel());
      throw new BoundedGuidanceResponseError(
        "Content-Length da orientação é inválido",
      );
    }
    if (parsedLength > maxBytes) {
      await cancelBestEffort(() => response.body?.cancel());
      throw new BoundedGuidanceResponseError(
        `resposta excede limite de ${maxBytes} bytes`,
      );
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
        throw new BoundedGuidanceResponseError(
          `resposta excede limite de ${maxBytes} bytes`,
        );
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

export async function fetchOfficial(
  source,
  accept,
  {
    fetchImpl = globalThis.fetch,
    label = "SERPRO",
    maxBytes = MAX_GUIDANCE_RESPONSE_BYTES,
    timeoutMs = 30_000,
  } = {},
) {
  assertOfficialGuidanceSource(source, accept);
  let response;
  try {
    response = await fetchImpl(source, {
      headers: { accept, "accept-encoding": "identity" },
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new Error(`${label}: falha ao consultar orientação oficial`);
  }
  if (!response.ok) {
    await cancelBestEffort(() => response.body?.cancel());
    throw new Error(`${label}: orientação respondeu HTTP ${response.status}`);
  }
  try {
    return await readBoundedBody(response, maxBytes);
  } catch (error) {
    if (
      error instanceof BoundedGuidanceResponseError ||
      error instanceof TypeError
    ) {
      throw error;
    }
    throw new Error(`${label}: falha ao ler orientação oficial`);
  }
}

export async function checkSerproGuidance({
  baseline,
  fetchImpl = globalThis.fetch,
  maxBytes = MAX_GUIDANCE_RESPONSE_BYTES,
  output = console,
}) {
  let changed = false;

  for (const page of baseline.pages) {
    const bytes = await fetchOfficial(page.source, "text/html", {
      fetchImpl,
      label: page.name,
      maxBytes,
    });
    const text = htmlToText(bytes.toString("utf8"));
    const missing = page.requiredText.filter(
      (marker) => !text.includes(marker),
    );
    if (missing.length === 0) {
      output.log(`${page.name}: orientação semântica compatível`);
      continue;
    }

    changed = true;
    output.error(`${page.name}: orientação oficial mudou`);
    for (const marker of missing) output.error(`  texto ausente: ${marker}`);
  }

  for (const asset of baseline.assets) {
    const bytes = await fetchOfficial(asset.source, "image/png", {
      fetchImpl,
      label: asset.name,
      maxBytes,
    });
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual === asset.sha256) {
      output.log(`${asset.name}: diagrama sem mudanças`);
      continue;
    }

    changed = true;
    output.error(`${asset.name}: diagrama oficial mudou`);
    output.error(`  sha256 esperado=${asset.sha256}`);
    output.error(`  sha256 atual=${actual}`);
  }

  return { changed };
}

export async function runGuidanceCli() {
  const baseline = JSON.parse(await readFile(baselineUrl, "utf8"));
  const { changed } = await checkSerproGuidance({ baseline });
  if (changed) process.exitCode = 1;
}

const entrypoint = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : undefined;
if (entrypoint === import.meta.url) {
  await runGuidanceCli();
}
