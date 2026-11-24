import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  checkCanarySource,
  checkHomologationCanaryBoundary,
} from "./check-homologation-canary-boundary.mjs";

const safePort = `
import type { BrowserVehicle } from "../../App.js";
export interface ReadonlyCanaryPort {
  loadReadiness(signal: AbortSignal): Promise<unknown>;
  runPreflight(signal: AbortSignal): Promise<void>;
  checkEligibility(plate: string, crv: string, signal: AbortSignal): Promise<unknown>;
  searchStocks(plate: string, signal: AbortSignal): Promise<readonly unknown[]>;
  lookupVehicle(plate: string, signal: AbortSignal): Promise<BrowserVehicle>;
}
`;

test("aceita a implementação real da feature", async () => {
  const violations = await checkHomologationCanaryBoundary(
    path.resolve("apps/web/src/features/homologation-canary"),
  );
  assert.deepEqual(violations, []);
});

test("aceita somente a porta estreita esperada", async (context) => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "renave-canary-boundary-"),
  );
  context.after(async () => rm(directory, { force: true, recursive: true }));
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "port.ts"), safePort, "utf8");
  await writeFile(
    path.join(directory, "runner.ts"),
    `import type { ReadonlyCanaryPort } from "./port.js"; export type Safe = ReadonlyCanaryPort;`,
    "utf8",
  );
  assert.deepEqual(await checkHomologationCanaryBoundary(directory), []);

  await writeFile(
    path.join(directory, "port.ts"),
    safePort.replace("lookupVehicle", "deleteStock"),
    "utf8",
  );
  const violations = await checkHomologationCanaryBoundary(directory);
  assert.ok(violations.some((value) => value.includes("lookupVehicle")));
  assert.ok(violations.some((value) => value.includes("deleteStock")));
});

test("recusa todas as capacidades laterais e canais de exfiltração", () => {
  const adversarial = [
    ["createStockEntry()", "criação de estoque"],
    ['import "@seu-renave/stock-entry";', "entrada de estoque"],
    ["executeMutation()", "mutação"],
    ["mutation()", "mutação"],
    ['import "@seu-renave/renave-connector";', "conector"],
    ['import "@seu-renave/db";', "banco"],
    ['import "../../../api/runtime.js";', "runtime"],
    ['import "./connectors.js";', "runtime"],
    ["document.cookie", "cookie"],
    ["localStorage.setItem('x', 'y')", "persistência"],
    ["setTimeout(work, 10)", "temporizador"],
    ["setInterval(work, 10)", "temporizador"],
    ["retry()", "repetição"],
    ["fetch('/api/renave')", "fetch"],
    ['const endpoint = "https://example.invalid"', "URL"],
    ['const SERPRO_ENDPOINT = "/renave"', "SERPRO"],
    ["console.log('fixture')", "console"],
  ];
  for (const [source, expected] of adversarial) {
    assert.ok(
      checkCanarySource(source, "attack.ts").some((value) =>
        value.toLowerCase().includes(expected.toLowerCase()),
      ),
      `guard deveria recusar: ${source}`,
    );
  }
});

test("ignora testes adversariais ao verificar a árvore de produção", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "renave-canary-tests-"));
  context.after(async () => rm(directory, { force: true, recursive: true }));
  await writeFile(path.join(directory, "port.ts"), safePort, "utf8");
  await writeFile(
    path.join(directory, "adversarial.test.ts"),
    "createStockEntry(); fetch('https://serpro.gov.br')",
    "utf8",
  );
  assert.deepEqual(await checkHomologationCanaryBoundary(directory), []);
});
