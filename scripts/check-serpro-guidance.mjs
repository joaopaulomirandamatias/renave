import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const baselineUrl = new URL(
  "../contracts/serpro/guidance-baseline.json",
  import.meta.url,
);

export const MAX_GUIDANCE_RESPONSE_BYTES = 10 * 1024 * 1024;

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
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    Number.isFinite(Number(declaredLength)) &&
    Number(declaredLength) > maxBytes
  ) {
    throw new Error(`resposta excede limite de ${maxBytes} bytes`);
  }
  if (!response.body) return Buffer.alloc(0);

  const chunks = [];
  let receivedBytes = 0;
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk);
    receivedBytes += bytes.byteLength;
    if (receivedBytes > maxBytes) {
      throw new Error(`resposta excede limite de ${maxBytes} bytes`);
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, receivedBytes);
}

export async function fetchOfficial(
  source,
  accept,
  {
    fetchImpl = globalThis.fetch,
    maxBytes = MAX_GUIDANCE_RESPONSE_BYTES,
    timeoutMs = 30_000,
  } = {},
) {
  const response = await fetchImpl(source, {
    headers: { accept },
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`${source}: respondeu HTTP ${response.status}`);
  }
  return readBoundedBody(response, maxBytes);
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
