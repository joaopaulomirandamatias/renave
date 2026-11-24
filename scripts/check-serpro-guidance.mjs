import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const baselineUrl = new URL(
  "../contracts/serpro/guidance-baseline.json",
  import.meta.url,
);
const baseline = JSON.parse(await readFile(baselineUrl, "utf8"));

function htmlToText(html) {
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

async function fetchOfficial(source, accept) {
  const response = await fetch(source, {
    headers: { accept },
    redirect: "follow",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`${source}: respondeu HTTP ${response.status}`);
  }
  return response;
}

let changed = false;

for (const page of baseline.pages) {
  const response = await fetchOfficial(page.source, "text/html");
  const text = htmlToText(await response.text());
  const missing = page.requiredText.filter((marker) => !text.includes(marker));
  if (missing.length === 0) {
    console.log(`${page.name}: orientação semântica compatível`);
    continue;
  }

  changed = true;
  console.error(`${page.name}: orientação oficial mudou`);
  for (const marker of missing) console.error(`  texto ausente: ${marker}`);
}

for (const asset of baseline.assets) {
  const response = await fetchOfficial(asset.source, "image/png");
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual === asset.sha256) {
    console.log(`${asset.name}: diagrama sem mudanças`);
    continue;
  }

  changed = true;
  console.error(`${asset.name}: diagrama oficial mudou`);
  console.error(`  sha256 esperado=${asset.sha256}`);
  console.error(`  sha256 atual=${actual}`);
}

if (changed) process.exitCode = 1;
