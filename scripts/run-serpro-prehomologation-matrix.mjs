import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DOMAIN_CODES = Object.freeze([
  "THEFT_OR_ROBBERY",
  "PGFN_RESTRICTION",
  "CRV_ISSUANCE_PENDING",
  "VEHICLE_WRITTEN_OFF",
]);

const RESULT_CODES = new Set([
  ...DOMAIN_CODES,
  "DETRAN_UNAVAILABLE",
  "EXECUTION_FAILED",
  "IMPEDIMENT_MISSING",
  "RESULT_INVALID",
  "STATUS_NOT_INELIGIBLE",
  "UNEXPECTED_IMPEDIMENT_SET",
]);

const MAX_DURATION_MS = 86_400_000;
const SUITE_ID = "SERPRO_PREHOMOLOGATION_H04_H07";
const APPLICATION_MODULE =
  "../packages/renave-application/dist/vehicle-eligibility.js";

export const PREHOMOLOGATION_SCENARIOS = Object.freeze([
  Object.freeze({
    expectedCode: "THEFT_OR_ROBBERY",
    id: "H-04",
    mock: "comRouboFurto",
  }),
  Object.freeze({
    expectedCode: "PGFN_RESTRICTION",
    id: "H-05",
    mock: "comRestricaoPgfn",
  }),
  Object.freeze({
    expectedCode: "CRV_ISSUANCE_PENDING",
    id: "H-06",
    mock: "comPendenciaEmissaoCrv",
  }),
  Object.freeze({
    expectedCode: "VEHICLE_WRITTEN_OFF",
    id: "H-07",
    mock: "jaBaixado",
  }),
]);

const OFFLINE_RESPONSES = Object.freeze({
  comPendenciaEmissaoCrv: Object.freeze({
    diagnostico: Object.freeze({
      veiculoApto: false,
      veiculoComPendenciaDeEmissaoCrv: true,
    }),
  }),
  comRestricaoPgfn: Object.freeze({
    diagnostico: Object.freeze({
      veiculoApto: false,
      veiculoComRestricaoPgfn: true,
    }),
  }),
  comRouboFurto: Object.freeze({
    diagnostico: Object.freeze({
      veiculoApto: false,
      veiculoComRouboFurto: true,
    }),
  }),
  jaBaixado: Object.freeze({
    diagnostico: Object.freeze({
      veiculoApto: false,
      veiculoBaixado: true,
    }),
  }),
});

export async function loadVehicleEligibilitySummarizer() {
  const application = await import(APPLICATION_MODULE);
  if (typeof application.summarizeVehicleEligibilityResponse !== "function") {
    throw new Error("VEHICLE_ELIGIBILITY_SUMMARIZER_UNAVAILABLE");
  }
  return application.summarizeVehicleEligibilityResponse;
}

export async function executeOfflineMock(scenario, summarize) {
  return summarize(OFFLINE_RESPONSES[scenario.mock]);
}

function safeDuration(startedAt, finishedAt) {
  const elapsed = finishedAt - startedAt;
  if (!Number.isFinite(elapsed) || elapsed <= 0) return 0;
  return Math.min(MAX_DURATION_MS, Math.round(elapsed));
}

function classifyResult(value, expectedCode) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return "RESULT_INVALID";
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Object.keys(descriptors).sort().join(",") !==
      "detranUnavailable,impediments,status" ||
    Object.values(descriptors).some(
      (descriptor) =>
        !("value" in descriptor) || descriptor.enumerable !== true,
    )
  ) {
    return "RESULT_INVALID";
  }
  const detranUnavailable = descriptors.detranUnavailable.value;
  const impediments = descriptors.impediments.value;
  const status = descriptors.status.value;
  if (detranUnavailable === true) return "DETRAN_UNAVAILABLE";
  if (detranUnavailable !== false) return "RESULT_INVALID";
  if (status !== "ineligible") return "STATUS_NOT_INELIGIBLE";
  if (
    !Array.isArray(impediments) ||
    impediments.some(
      (code) => typeof code !== "string" || !DOMAIN_CODES.includes(code),
    )
  ) {
    return "RESULT_INVALID";
  }
  if (!impediments.includes(expectedCode)) return "IMPEDIMENT_MISSING";
  if (impediments.length !== 1) return "UNEXPECTED_IMPEDIMENT_SET";
  return expectedCode;
}

export async function runPrehomologationMatrix({
  clock = () => performance.now(),
  execute,
  loadSummarizer = loadVehicleEligibilitySummarizer,
} = {}) {
  const suiteStartedAt = clock();
  const cases = [];
  let scenarioExecutor = execute;
  if (scenarioExecutor === undefined) {
    const summarizer = Promise.resolve()
      .then(() => loadSummarizer())
      .then((value) => {
        if (typeof value !== "function") {
          throw new Error("VEHICLE_ELIGIBILITY_SUMMARIZER_UNAVAILABLE");
        }
        return value;
      });
    scenarioExecutor = async (scenario) =>
      executeOfflineMock(scenario, await summarizer);
  }

  for (const scenario of PREHOMOLOGATION_SCENARIOS) {
    const startedAt = clock();
    let observedCode;
    try {
      observedCode = classifyResult(
        await scenarioExecutor(scenario),
        scenario.expectedCode,
      );
    } catch {
      observedCode = "EXECUTION_FAILED";
    }
    if (!RESULT_CODES.has(observedCode)) observedCode = "RESULT_INVALID";
    const status = observedCode === scenario.expectedCode ? "passed" : "failed";
    cases.push(
      Object.freeze({
        durationMs: safeDuration(startedAt, clock()),
        expectedCode: scenario.expectedCode,
        id: scenario.id,
        observedCode,
        status,
      }),
    );
  }

  const status = cases.every((testCase) => testCase.status === "passed")
    ? "passed"
    : "failed";
  return Object.freeze({
    cases: Object.freeze(cases),
    durationMs: safeDuration(suiteStartedAt, clock()),
    status,
    suiteId: SUITE_ID,
  });
}

export class PrehomologationReportValidationError extends Error {
  code = "PREHOMOLOGATION_REPORT_INVALID";

  constructor() {
    super("PREHOMOLOGATION_REPORT_INVALID");
    this.name = "PrehomologationReportValidationError";
  }
}

function invalidReport() {
  throw new PrehomologationReportValidationError();
}

function dataDescriptors(value, expectedKeys) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    invalidReport();
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Object.keys(descriptors).sort().join(",") !==
      [...expectedKeys].sort().join(",") ||
    Object.values(descriptors).some(
      (descriptor) =>
        !("value" in descriptor) || descriptor.enumerable !== true,
    )
  ) {
    invalidReport();
  }
  return descriptors;
}

function validatedDuration(value) {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > MAX_DURATION_MS
  ) {
    invalidReport();
  }
  return value;
}

export function normalizePrehomologationReport(value) {
  try {
    const report = dataDescriptors(value, [
      "cases",
      "durationMs",
      "status",
      "suiteId",
    ]);
    if (report.suiteId.value !== SUITE_ID) invalidReport();
    const cases = report.cases.value;
    if (
      !Array.isArray(cases) ||
      cases.length !== PREHOMOLOGATION_SCENARIOS.length ||
      Object.keys(cases).join(",") !== "0,1,2,3"
    ) {
      invalidReport();
    }

    const normalizedCases = PREHOMOLOGATION_SCENARIOS.map((scenario, index) => {
      const itemDescriptor = Object.getOwnPropertyDescriptor(
        cases,
        String(index),
      );
      if (!itemDescriptor || !("value" in itemDescriptor)) invalidReport();
      const testCase = dataDescriptors(itemDescriptor.value, [
        "durationMs",
        "expectedCode",
        "id",
        "observedCode",
        "status",
      ]);
      const observedCode = testCase.observedCode.value;
      const expectedStatus =
        observedCode === scenario.expectedCode ? "passed" : "failed";
      if (
        testCase.id.value !== scenario.id ||
        testCase.expectedCode.value !== scenario.expectedCode ||
        typeof observedCode !== "string" ||
        !RESULT_CODES.has(observedCode) ||
        testCase.status.value !== expectedStatus
      ) {
        invalidReport();
      }
      return Object.freeze({
        durationMs: validatedDuration(testCase.durationMs.value),
        expectedCode: scenario.expectedCode,
        id: scenario.id,
        observedCode,
        status: expectedStatus,
      });
    });
    const status = normalizedCases.every(
      (testCase) => testCase.status === "passed",
    )
      ? "passed"
      : "failed";
    if (report.status.value !== status) invalidReport();
    return Object.freeze({
      cases: Object.freeze(normalizedCases),
      durationMs: validatedDuration(report.durationMs.value),
      status,
      suiteId: SUITE_ID,
    });
  } catch (error) {
    if (error instanceof PrehomologationReportValidationError) throw error;
    invalidReport();
  }
}

function renderJsonSnapshot(report) {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function renderJsonReport(report) {
  return renderJsonSnapshot(normalizePrehomologationReport(report));
}

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function seconds(milliseconds) {
  return (milliseconds / 1_000).toFixed(3);
}

function renderJunitSnapshot(report) {
  const failures = report.cases.filter(
    (testCase) => testCase.status === "failed",
  ).length;
  const cases = report.cases
    .map((testCase) => {
      const attributes =
        `classname="serpro.prehomologation" name="${xmlEscape(testCase.id)}" ` +
        `time="${seconds(testCase.durationMs)}"`;
      if (testCase.status === "passed") return `  <testcase ${attributes}/>`;
      return (
        `  <testcase ${attributes}>\n` +
        `    <failure message="${xmlEscape(testCase.observedCode)}" ` +
        `type="PREHOMOLOGATION_SCENARIO_FAILED"/>\n` +
        "  </testcase>"
      );
    })
    .join("\n");
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    `<testsuite name="${report.suiteId}" tests="${report.cases.length}" ` +
    `failures="${failures}" errors="0" skipped="0" ` +
    `time="${seconds(report.durationMs)}">\n` +
    `${cases}\n` +
    "</testsuite>\n"
  );
}

export function renderJunitReport(report) {
  return renderJunitSnapshot(normalizePrehomologationReport(report));
}

async function stageWrite(destination, content) {
  const target = path.resolve(destination);
  const directory = path.dirname(target);
  const temporary = path.join(
    directory,
    `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`,
  );
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(temporary, content, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    return Object.freeze({ target, temporary });
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function sameFile(first, second) {
  try {
    const [firstStat, secondStat] = await Promise.all([
      lstat(first),
      lstat(second),
    ]);
    return firstStat.dev === secondStat.dev && firstStat.ino === secondStat.ino;
  } catch {
    return false;
  }
}

async function cleanupStages(stages) {
  await Promise.all(
    stages.map(({ temporary }) =>
      rm(temporary, { force: true }).catch(() => undefined),
    ),
  );
}

async function publishStages(stages) {
  const published = [];
  try {
    for (const stage of stages) {
      await link(stage.temporary, stage.target);
      published.push(stage);
    }
  } catch (error) {
    for (const stage of published.reverse()) {
      if (await sameFile(stage.temporary, stage.target)) {
        await unlink(stage.target).catch(() => undefined);
      }
    }
    throw error;
  } finally {
    await cleanupStages(stages);
  }
}

export async function writePrehomologationReports(
  report,
  { jsonPath, junitPath } = {},
) {
  if (
    jsonPath !== undefined &&
    junitPath !== undefined &&
    path.resolve(jsonPath) === path.resolve(junitPath)
  ) {
    throw new Error("REPORT_DESTINATIONS_CONFLICT");
  }
  const snapshot = normalizePrehomologationReport(report);
  const stages = [];
  try {
    if (jsonPath !== undefined) {
      stages.push(await stageWrite(jsonPath, renderJsonSnapshot(snapshot)));
    }
    if (junitPath !== undefined) {
      stages.push(await stageWrite(junitPath, renderJunitSnapshot(snapshot)));
    }
  } catch (error) {
    await cleanupStages(stages);
    throw error;
  }
  await publishStages(stages);
}

export function parseCliArguments(arguments_) {
  const result = {};
  for (let index = 0; index < arguments_.length; index += 1) {
    const flag = arguments_[index];
    if (flag !== "--json" && flag !== "--junit") return undefined;
    const value = arguments_[index + 1];
    if (value === undefined || value.length === 0 || value.startsWith("--")) {
      return undefined;
    }
    const key = flag === "--json" ? "jsonPath" : "junitPath";
    if (result[key] !== undefined) return undefined;
    result[key] = value;
    index += 1;
  }
  if (
    result.jsonPath !== undefined &&
    result.junitPath !== undefined &&
    path.resolve(result.jsonPath) === path.resolve(result.junitPath)
  ) {
    return undefined;
  }
  return Object.freeze(result);
}

export async function main(
  arguments_ = process.argv.slice(2),
  {
    error = console.error,
    output = console.log,
    run = runPrehomologationMatrix,
    writeReports = writePrehomologationReports,
  } = {},
) {
  const destinations = parseCliArguments(arguments_);
  if (destinations === undefined) {
    error(
      "Uso: node scripts/run-serpro-prehomologation-matrix.mjs [--json <arquivo>] [--junit <arquivo>]",
    );
    return 2;
  }
  try {
    const report = normalizePrehomologationReport(await run());
    await writeReports(report, destinations);
    if (Object.keys(destinations).length === 0) {
      output(renderJsonReport(report).trimEnd());
    }
    return report.status === "passed" ? 0 : 1;
  } catch {
    error("prehomologation: REPORT_WRITE_FAILED");
    return 1;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) process.exitCode = await main();
