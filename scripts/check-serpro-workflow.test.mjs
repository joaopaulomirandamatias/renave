import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const workflowUrl = new URL(
  "../.github/workflows/serpro-contract.yml",
  import.meta.url,
);

function executableYaml(source) {
  return source
    .split(/\r?\n/u)
    .map((line) => line.replace(/\s+#.*$/u, ""))
    .join("\n");
}

function stepContaining(source, marker) {
  const markerIndex = source.indexOf(marker);
  if (markerIndex === -1) return "";
  const start = source.lastIndexOf("\n      - ", markerIndex);
  const end = source.indexOf("\n      - ", markerIndex);
  return source.slice(start === -1 ? 0 : start, end === -1 ? undefined : end);
}

describe("workflow do monitor SERPRO", () => {
  it("mantém checkout sem credencial, ações imutáveis e execução sem privilégios", async () => {
    const source = executableYaml(await readFile(workflowUrl, "utf8"));
    const jobs = source.slice(source.indexOf("\njobs:\n") + 7);
    const jobNames = [...jobs.matchAll(/^  ([a-z0-9-]+):\s*$/gmu)].map(
      (match) => match[1],
    );
    const actionReferences = [
      ...jobs.matchAll(/^\s*uses:\s*([^\s]+)\s*$/gmu),
    ].map((match) => match[1]);
    const checkoutActions = actionReferences.filter((reference) =>
      reference.startsWith("actions/checkout@"),
    );
    const checkoutStep = stepContaining(jobs, "uses: actions/checkout@");

    assert.deepEqual(jobNames, ["compare"]);
    assert.equal(checkoutActions.length, 1);
    assert.ok(actionReferences.length > 0);
    assert.ok(
      actionReferences.every((reference) => /@[a-f0-9]{40}$/u.test(reference)),
    );
    assert.match(source, /permissions:\s*\n\s*contents:\s*read\b/u);
    assert.doesNotMatch(source, /permissions:\s*write-all\b/u);
    assert.doesNotMatch(source, /^\s*[a-z-]+:\s*write\b/mu);
    assert.match(checkoutStep, /persist-credentials:\s*false\b/u);
    assert.match(checkoutStep, /fetch-depth:\s*1\b/u);
    assert.match(jobs, /runs-on:\s*ubuntu-24\.04\b/u);
    assert.match(jobs, /timeout-minutes:\s*10\b/u);
    assert.match(source, /uses:\s*actions\/checkout@[a-f0-9]{40}\b/u);
    assert.match(source, /uses:\s*actions\/setup-node@[a-f0-9]{40}\b/u);
    assert.match(
      source,
      /shell:\s*bash --noprofile --norc -euo pipefail \{0\}/u,
    );
    assert.doesNotMatch(source, /\b(?:id-token|packages):\s*write\b/u);
    assert.doesNotMatch(source, /pull_request_target|continue-on-error/u);
    assert.doesNotMatch(source, /\|\|\s*true\b/u);
    assert.doesNotMatch(source, /\$\{\{\s*secrets\./u);
  });

  it("executa controles locais antes das consultas de rede", async () => {
    const source = executableYaml(await readFile(workflowUrl, "utf8"));
    const compareJob = source.slice(source.indexOf("\n  compare:\n"));
    const tests = compareJob.indexOf(
      "node --test scripts/check-serpro-*.test.mjs",
    );
    const firstNetworkCheck = compareJob.indexOf(
      "node scripts/check-serpro-contract.mjs",
    );

    assert.notEqual(tests, -1);
    assert.notEqual(firstNetworkCheck, -1);
    assert.ok(tests < firstNetworkCheck);
  });
});
