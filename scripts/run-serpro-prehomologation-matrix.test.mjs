import assert from "node:assert/strict";
import {
  access,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  main,
  normalizePrehomologationReport,
  parseCliArguments,
  PREHOMOLOGATION_SCENARIOS,
  renderJsonReport,
  renderJunitReport,
  runPrehomologationMatrix,
  writePrehomologationReports,
} from "./run-serpro-prehomologation-matrix.mjs";

const expectedCodes = [
  "THEFT_OR_ROBBERY",
  "PGFN_RESTRICTION",
  "CRV_ISSUANCE_PENDING",
  "VEHICLE_WRITTEN_OFF",
];

function deterministicClock() {
  let value = 0;
  return () => (value += 5);
}

const rawFlagCodes = Object.freeze({
  veiculoBaixado: "VEHICLE_WRITTEN_OFF",
  veiculoComPendenciaDeEmissaoCrv: "CRV_ISSUANCE_PENDING",
  veiculoComRestricaoPgfn: "PGFN_RESTRICTION",
  veiculoComRouboFurto: "THEFT_OR_ROBBERY",
});

function summarizeRawFixture(response) {
  const impediments = Object.entries(rawFlagCodes).flatMap(([field, code]) =>
    response.diagnostico?.[field] === true ? [code] : [],
  );
  return {
    detranUnavailable: false,
    impediments,
    status:
      response.diagnostico?.veiculoApto === false
        ? "ineligible"
        : "undetermined",
  };
}

function runOfflineMatrix(options = {}) {
  return runPrehomologationMatrix({
    loadSummarizer: async () => summarizeRawFixture,
    ...options,
  });
}

describe("matriz pré-homologação SERPRO", () => {
  it("executa H-04 a H-07 offline e confirma o impedimento exato", async () => {
    let loads = 0;
    const rawFields = [];
    const report = await runOfflineMatrix({
      clock: deterministicClock(),
      loadSummarizer: async () => {
        loads += 1;
        return (response) => {
          const fields = Object.keys(response.diagnostico).filter(
            (field) => field !== "veiculoApto",
          );
          rawFields.push(fields[0]);
          return summarizeRawFixture(response);
        };
      },
    });

    assert.equal(report.status, "passed");
    assert.equal(report.suiteId, "SERPRO_PREHOMOLOGATION_H04_H07");
    assert.deepEqual(
      report.cases.map(({ expectedCode, id, observedCode, status }) => ({
        expectedCode,
        id,
        observedCode,
        status,
      })),
      expectedCodes.map((code, index) => ({
        expectedCode: code,
        id: `H-0${index + 4}`,
        observedCode: code,
        status: "passed",
      })),
    );
    assert.deepEqual(
      PREHOMOLOGATION_SCENARIOS.map(({ mock }) => mock),
      [
        "comRouboFurto",
        "comRestricaoPgfn",
        "comPendenciaEmissaoCrv",
        "jaBaixado",
      ],
    );
    assert.equal(loads, 1);
    assert.deepEqual(rawFields, [
      "veiculoComRouboFurto",
      "veiculoComRestricaoPgfn",
      "veiculoComPendenciaDeEmissaoCrv",
      "veiculoBaixado",
    ]);
  });

  it("falha fechado nos quatro cenários quando o normalizador não carrega", async () => {
    let loads = 0;
    const secret = "CPF 12345678901";
    const report = await runPrehomologationMatrix({
      clock: deterministicClock(),
      loadSummarizer: async () => {
        loads += 1;
        throw new Error(secret);
      },
    });

    assert.equal(loads, 1);
    assert.equal(report.status, "failed");
    assert.deepEqual(
      report.cases.map(({ observedCode }) => observedCode),
      Array.from({ length: 4 }, () => "EXECUTION_FAILED"),
    );
    assert.doesNotMatch(renderJsonReport(report), /12345678901/u);
  });

  it("usa o normalizador compilado de produção no executor padrão", async () => {
    const report = await runPrehomologationMatrix({
      clock: deterministicClock(),
    });

    assert.equal(report.status, "passed");
    assert.deepEqual(
      report.cases.map(({ expectedCode, observedCode, status }) => ({
        expectedCode,
        observedCode,
        status,
      })),
      expectedCodes.map((code) => ({
        expectedCode: code,
        observedCode: code,
        status: "passed",
      })),
    );
  });

  it("isola falhas e nunca inclui a exceção ou o retorno bruto", async () => {
    const secret =
      "CPF 12345678901 CNPJ 11222333000181 RENAVAM 00607701676 ABC1D23";
    const report = await runPrehomologationMatrix({
      clock: deterministicClock(),
      execute: async (scenario) => {
        if (scenario.id === "H-04") throw new Error(secret);
        if (scenario.id === "H-05") return { detail: secret };
        if (scenario.id === "H-06") {
          return {
            detranUnavailable: false,
            impediments: ["CRV_ISSUANCE_PENDING", "THEFT_OR_ROBBERY"],
            payload: secret,
            status: "ineligible",
          };
        }
        return {
          detranUnavailable: true,
          impediments: ["VEHICLE_WRITTEN_OFF"],
          status: "ineligible",
        };
      },
    });
    const serialized = `${renderJsonReport(report)}${renderJunitReport(report)}`;

    assert.equal(report.status, "failed");
    assert.deepEqual(
      report.cases.map(({ observedCode }) => observedCode),
      [
        "EXECUTION_FAILED",
        "RESULT_INVALID",
        "RESULT_INVALID",
        "DETRAN_UNAVAILABLE",
      ],
    );
    assert.doesNotMatch(
      serialized,
      /12345678901|11222333000181|00607701676|ABC1D23|payload|detail|response/u,
    );
  });

  it("falha fechado para código desconhecido, ausência e status positivo", async () => {
    const returns = [
      {
        detranUnavailable: false,
        impediments: ["FREE_TEXT_FROM_REMOTE"],
        status: "ineligible",
      },
      { detranUnavailable: false, impediments: [], status: "ineligible" },
      { detranUnavailable: false, impediments: [], status: "eligible" },
      null,
    ];
    let index = 0;
    const report = await runPrehomologationMatrix({
      clock: deterministicClock(),
      execute: async () => returns[index++],
    });

    assert.deepEqual(
      report.cases.map(({ observedCode }) => observedCode),
      [
        "RESULT_INVALID",
        "IMPEDIMENT_MISSING",
        "STATUS_NOT_INELIGIBLE",
        "RESULT_INVALID",
      ],
    );
    assert.doesNotMatch(renderJsonReport(report), /FREE_TEXT_FROM_REMOTE/u);
  });

  it("recusa campos extras, getters, protótipo e impedimento duplicado", async () => {
    const withGetter = {};
    Object.defineProperty(withGetter, "status", {
      enumerable: true,
      get() {
        throw new Error("CPF 12345678901");
      },
    });
    Object.defineProperty(withGetter, "detranUnavailable", {
      enumerable: true,
      value: false,
    });
    Object.defineProperty(withGetter, "impediments", {
      enumerable: true,
      value: ["PGFN_RESTRICTION"],
    });
    const returns = [
      {
        detranUnavailable: false,
        extra: "RENAVAM 00607701676",
        impediments: ["THEFT_OR_ROBBERY"],
        status: "ineligible",
      },
      withGetter,
      Object.assign(Object.create(null), {
        detranUnavailable: false,
        impediments: ["CRV_ISSUANCE_PENDING"],
        status: "ineligible",
      }),
      {
        detranUnavailable: false,
        impediments: ["VEHICLE_WRITTEN_OFF", "VEHICLE_WRITTEN_OFF"],
        status: "ineligible",
      },
    ];
    let index = 0;
    const report = await runPrehomologationMatrix({
      clock: deterministicClock(),
      execute: async () => returns[index++],
    });

    assert.deepEqual(
      report.cases.map(({ observedCode }) => observedCode),
      [
        "RESULT_INVALID",
        "RESULT_INVALID",
        "RESULT_INVALID",
        "UNEXPECTED_IMPEDIMENT_SET",
      ],
    );
    assert.doesNotMatch(renderJsonReport(report), /12345678901|00607701676/u);
  });

  it("gera JSON estrito e JUnit consistente a partir da mesma evidência", async () => {
    const report = await runOfflineMatrix({
      clock: deterministicClock(),
    });
    const json = renderJsonReport(report);
    const junit = renderJunitReport(report);

    assert.deepEqual(JSON.parse(json), report);
    assert.match(junit, /^<\?xml version="1\.0" encoding="UTF-8"\?>/u);
    assert.match(junit, /tests="4" failures="0" errors="0" skipped="0"/u);
    assert.equal((junit.match(/<testcase /gu) ?? []).length, 4);
    assert.doesNotMatch(junit, /<failure /u);
    assert.doesNotMatch(junit, /system-(?:out|err)/u);
  });

  it("registra no JUnit somente código controlado quando um cenário falha", async () => {
    const report = await runPrehomologationMatrix({
      clock: deterministicClock(),
      execute: async () => {
        throw new Error('"<segredo>&');
      },
    });
    const junit = renderJunitReport(report);

    assert.match(junit, /failures="4"/u);
    assert.equal((junit.match(/message="EXECUTION_FAILED"/gu) ?? []).length, 4);
    assert.doesNotMatch(junit, /segredo/u);
  });

  it("recusa relatório arbitrário antes de serializar qualquer dado externo", async () => {
    const secret = "CPF 12345678901 RENAVAM 00607701676";
    const valid = await runOfflineMatrix({
      clock: deterministicClock(),
    });
    const malicious = JSON.parse(JSON.stringify(valid));
    malicious.secret = secret;

    for (const render of [
      normalizePrehomologationReport,
      renderJsonReport,
      renderJunitReport,
    ]) {
      assert.throws(
        () => render(malicious),
        (error) =>
          error?.code === "PREHOMOLOGATION_REPORT_INVALID" &&
          !String(error).includes(secret),
      );
    }

    const withGetter = {};
    Object.defineProperty(withGetter, "cases", {
      enumerable: true,
      get() {
        throw new Error(secret);
      },
    });
    assert.throws(
      () => renderJsonReport(withGetter),
      (error) =>
        error?.code === "PREHOMOLOGATION_REPORT_INVALID" &&
        !String(error).includes(secret),
    );
  });

  it("normaliza clocks NaN, infinitos, regressivos e extremos", async () => {
    const values = [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      1_000,
      -1_000,
      Number.MAX_VALUE,
      -Number.MAX_VALUE,
      0,
      1,
      Number.MAX_VALUE,
    ];
    let index = 0;
    const report = await runOfflineMatrix({
      clock: () => values[index++] ?? Number.MAX_VALUE,
    });

    for (const duration of [
      report.durationMs,
      ...report.cases.map(({ durationMs }) => durationMs),
    ]) {
      assert.equal(Number.isFinite(duration), true);
      assert.equal(Number.isInteger(duration), true);
      assert.equal(duration >= 0, true);
      assert.equal(duration <= 86_400_000, true);
    }
    assert.doesNotThrow(() => renderJsonReport(report));
    assert.doesNotMatch(renderJsonReport(report), /NaN|Infinity/u);
  });

  it("grava JSON e JUnit atomicamente com permissão privada", async (context) => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "renave-prehomologation-"),
    );
    context.after(async () => rm(directory, { force: true, recursive: true }));
    const jsonPath = path.join(directory, "nested", "matrix.json");
    const junitPath = path.join(directory, "nested", "matrix.junit.xml");
    const report = await runOfflineMatrix({
      clock: deterministicClock(),
    });

    await writePrehomologationReports(report, { jsonPath, junitPath });

    assert.deepEqual(JSON.parse(await readFile(jsonPath, "utf8")), report);
    assert.match(await readFile(junitPath, "utf8"), /<testsuite /u);
    assert.equal((await stat(jsonPath)).mode & 0o777, 0o600);
    assert.equal((await stat(junitPath)).mode & 0o777, 0o600);
    assert.equal(
      (await readdir(path.join(directory, "nested"))).some((name) =>
        name.endsWith(".tmp"),
      ),
      false,
    );
  });

  it("remove a primeira publicação se a segunda falha", async (context) => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "renave-prehomologation-"),
    );
    context.after(async () => rm(directory, { force: true, recursive: true }));
    const jsonPath = path.join(directory, "matrix.json");
    const junitPath = path.join(directory, "matrix.junit.xml");
    await writeFile(junitPath, "preexisting", "utf8");
    const report = await runOfflineMatrix({
      clock: deterministicClock(),
    });

    await assert.rejects(
      writePrehomologationReports(report, { jsonPath, junitPath }),
      (error) => error?.code === "EEXIST",
    );

    await assert.rejects(access(jsonPath));
    assert.equal(await readFile(junitPath, "utf8"), "preexisting");
    assert.equal(
      (await readdir(directory)).some((name) => name.endsWith(".tmp")),
      false,
    );
  });

  it("não sobrescreve arquivo ou symlink existente", async (context) => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "renave-prehomologation-"),
    );
    context.after(async () => rm(directory, { force: true, recursive: true }));
    const report = await runOfflineMatrix({
      clock: deterministicClock(),
    });
    const existing = path.join(directory, "existing.json");
    await writeFile(existing, "preserve", "utf8");
    await assert.rejects(
      writePrehomologationReports(report, { jsonPath: existing }),
      (error) => error?.code === "EEXIST",
    );
    assert.equal(await readFile(existing, "utf8"), "preserve");

    const target = path.join(directory, "target.json");
    const linked = path.join(directory, "linked.json");
    await writeFile(target, "linked-preserve", "utf8");
    await symlink(target, linked);
    await assert.rejects(
      writePrehomologationReports(report, { jsonPath: linked }),
      (error) => error?.code === "EEXIST",
    );
    assert.equal(await readFile(target, "utf8"), "linked-preserve");
  });

  it("recusa destinos JSON e JUnit iguais antes de escrever", async (context) => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "renave-prehomologation-"),
    );
    context.after(async () => rm(directory, { force: true, recursive: true }));
    const destination = path.join(directory, "same-report");
    const report = await runOfflineMatrix({
      clock: deterministicClock(),
    });

    await assert.rejects(
      writePrehomologationReports(report, {
        jsonPath: destination,
        junitPath: destination,
      }),
      /REPORT_DESTINATIONS_CONFLICT/u,
    );
    await assert.rejects(access(destination));
    assert.equal(
      parseCliArguments(["--json", destination, "--junit", destination]),
      undefined,
    );
  });

  it("aceita destinos opcionais e recusa flags ambíguas", () => {
    assert.deepEqual(parseCliArguments([]), {});
    assert.deepEqual(parseCliArguments(["--json", "report.json"]), {
      jsonPath: "report.json",
    });
    assert.deepEqual(
      parseCliArguments(["--junit", "report.xml", "--json", "report.json"]),
      { jsonPath: "report.json", junitPath: "report.xml" },
    );
    assert.equal(parseCliArguments(["--json"]), undefined);
    assert.equal(parseCliArguments(["--json", "a", "--json", "b"]), undefined);
    assert.equal(parseCliArguments(["--unknown", "a"]), undefined);
  });

  it("CLI sem destino imprime apenas JSON sanitizado", async () => {
    const lines = [];
    const errors = [];
    const code = await main([], {
      error: (line) => errors.push(line),
      output: (line) => lines.push(line),
      run: () => runOfflineMatrix({ clock: deterministicClock() }),
    });

    assert.equal(code, 0);
    assert.equal(errors.length, 0);
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).status, "passed");
  });

  it("CLI retorna 2 para uso inválido sem ecoar argumentos", async () => {
    const errors = [];
    const code = await main(["--json", "CPF-12345678901", "--unknown"], {
      error: (line) => errors.push(line),
      output: () => assert.fail("não deveria produzir relatório"),
    });

    assert.equal(code, 2);
    assert.equal(errors.length, 1);
    assert.doesNotMatch(errors[0], /12345678901/u);
  });

  it("CLI retorna 1 para falha de cenário sem tentar reexecutar", async () => {
    const lines = [];
    let runs = 0;
    const failedReport = await runPrehomologationMatrix({
      clock: deterministicClock(),
      execute: async () => {
        throw new Error("secret");
      },
    });
    const code = await main([], {
      error: () => assert.fail("não deveria escrever erro de infraestrutura"),
      output: (line) => lines.push(line),
      run: async () => {
        runs += 1;
        return failedReport;
      },
    });

    assert.equal(code, 1);
    assert.equal(runs, 1);
    assert.equal(JSON.parse(lines[0]).status, "failed");
  });

  it("CLI não revela destino quando a escrita falha", async () => {
    const secretPath = path.join("/dev/null", "CPF-12345678901", "report.json");
    const lines = [];
    const errors = [];
    const code = await main(["--json", secretPath], {
      error: (line) => errors.push(line),
      output: (line) => lines.push(line),
      run: () => runOfflineMatrix({ clock: deterministicClock() }),
    });

    assert.equal(code, 1);
    assert.deepEqual(lines, []);
    assert.deepEqual(errors, ["prehomologation: REPORT_WRITE_FAILED"]);
    assert.doesNotMatch(errors.join("\n"), new RegExp(secretPath, "u"));
  });
});
