import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import {
  checkSerproGuidance,
  fetchOfficial,
  readBoundedBody,
} from "./check-serpro-guidance.mjs";

const diagram = Buffer.from("official-diagram");
const baseline = {
  assets: [
    {
      name: "fluxo",
      sha256: createHash("sha256").update(diagram).digest("hex"),
      source:
        "https://centraldeajuda.serpro.gov.br/renave/assets/diagramas/fluxo.png",
    },
  ],
  pages: [
    {
      name: "manual",
      requiredText: ["CNPJ-Estabelecimento", "cliente-autenticado"],
      source: "https://centraldeajuda.serpro.gov.br/renave/",
    },
  ],
};

function createOutput() {
  const errors = [];
  const logs = [];
  return {
    errors,
    logs,
    output: {
      error: (message) => errors.push(message),
      log: (message) => logs.push(message),
    },
  };
}

function responseFor(source, pageBody, assetBody = diagram) {
  return source.endsWith(".png")
    ? new Response(assetBody, { status: 200 })
    : new Response(pageBody, { status: 200 });
}

describe("monitor de orientação SERPRO", () => {
  it("aceita orientação e diagramas compatíveis sem seguir redirects", async () => {
    const requests = [];
    const { errors, logs, output } = createOutput();
    const result = await checkSerproGuidance({
      baseline,
      fetchImpl: async (source, init) => {
        requests.push({ init, source });
        return responseFor(
          source,
          "<html>CNPJ-Estabelecimento cliente-autenticado</html>",
        );
      },
      output,
    });

    assert.deepEqual(result, { changed: false });
    assert.equal(errors.length, 0);
    assert.equal(logs.length, 2);
    assert.equal(requests.length, 2);
    assert.ok(requests.every(({ init }) => init.redirect === "error"));
    assert.ok(
      requests.every(
        ({ init }) => init.headers["accept-encoding"] === "identity",
      ),
    );
  });

  it("sinaliza texto obrigatório ausente", async () => {
    const { errors, output } = createOutput();
    const result = await checkSerproGuidance({
      baseline: { assets: [], pages: baseline.pages },
      fetchImpl: async (source) => responseFor(source, "CNPJ-Estabelecimento"),
      output,
    });

    assert.deepEqual(result, { changed: true });
    assert.ok(
      errors.some((message) => message.includes("cliente-autenticado")),
    );
  });

  it("sinaliza hash divergente do diagrama", async () => {
    const { errors, output } = createOutput();
    const result = await checkSerproGuidance({
      baseline: { assets: baseline.assets, pages: [] },
      fetchImpl: async (source) =>
        responseFor(source, "", Buffer.from("changed")),
      output,
    });

    assert.deepEqual(result, { changed: true });
    assert.ok(
      errors.some((message) => message.includes("diagrama oficial mudou")),
    );
  });

  it("recusa HTTP não-2xx", async () => {
    await assert.rejects(
      checkSerproGuidance({
        baseline: { assets: [], pages: baseline.pages },
        fetchImpl: async () => new Response("indisponível", { status: 503 }),
      }),
      /respondeu HTTP 503/,
    );
  });

  it("propaga recusa de redirect sem analisar o destino", async () => {
    await assert.rejects(
      checkSerproGuidance({
        baseline: { assets: [], pages: baseline.pages },
        fetchImpl: async (_source, init) => {
          assert.equal(init.redirect, "error");
          throw new TypeError("redirect recusado");
        },
      }),
      /falha ao consultar orientação oficial/,
    );
  });

  it("interrompe resposta acima do limite de bytes", async () => {
    await assert.rejects(
      checkSerproGuidance({
        baseline: { assets: [], pages: baseline.pages },
        fetchImpl: async () => new Response("conteúdo excessivo"),
        maxBytes: 4,
      }),
      /excede limite de 4 bytes/,
    );
  });

  it("recusa fontes fora da allowlist antes do fetch", async () => {
    for (const source of [
      "http://centraldeajuda.serpro.gov.br/renave/",
      "https://evil.test/renave/",
      "https://centraldeajuda.serpro.gov.br/fora/",
      "https://centraldeajuda.serpro.gov.br/renave/?extra=1",
      "https://user:pass@centraldeajuda.serpro.gov.br/renave/",
    ]) {
      let called = false;
      await assert.rejects(
        fetchOfficial(source, "text/html", {
          fetchImpl: async () => {
            called = true;
            return new Response("ok");
          },
        }),
        /allowlist oficial/,
      );
      assert.equal(called, false);
    }
  });

  it("sanitiza falhas HTTP e de transporte", async () => {
    const source = baseline.pages[0].source;
    await assert.rejects(
      fetchOfficial(source, "text/html", {
        fetchImpl: async () => new Response("sentinela-corpo", { status: 503 }),
        label: "central-ajuda",
      }),
      (error) =>
        error.message === "central-ajuda: orientação respondeu HTTP 503" &&
        !error.message.includes(source) &&
        !error.message.includes("sentinela-corpo"),
    );
    await assert.rejects(
      fetchOfficial(source, "text/html", {
        fetchImpl: async () => {
          throw new Error("redirecionou para https://evil.test");
        },
        label: "central-ajuda",
      }),
      (error) =>
        error.message ===
        "central-ajuda: falha ao consultar orientação oficial",
    );
  });

  it("falha fechado para limite e Content-Length inválidos", async () => {
    await assert.rejects(
      readBoundedBody(new Response("{}"), Number.NaN),
      /limite de resposta de orientação inválido/,
    );
    for (const declaredLength of ["-1", "1.5", "1, 2", "inválido"]) {
      await assert.rejects(
        readBoundedBody(
          new Response("{}", {
            headers: { "content-length": declaredLength },
          }),
        ),
        /Content-Length da orientação é inválido/,
      );
    }
  });

  it("aceita corpo exatamente no limite e sanitiza timeout durante leitura", async () => {
    const source = baseline.pages[0].source;
    const exact = "conteúdo";
    const bytes = await fetchOfficial(source, "text/html", {
      fetchImpl: async () => new Response(exact),
      label: "central-ajuda",
      maxBytes: Buffer.byteLength(exact),
    });
    assert.equal(bytes.toString("utf8"), exact);

    await assert.rejects(
      fetchOfficial(source, "text/html", {
        fetchImpl: async (_source, init) =>
          new Response(
            new ReadableStream({
              start(controller) {
                init.signal.addEventListener(
                  "abort",
                  () =>
                    controller.error(
                      new Error("falha de corpo em https://evil.test"),
                    ),
                  { once: true },
                );
              },
            }),
          ),
        label: "central-ajuda",
        timeoutMs: 5,
      }),
      (error) =>
        error.message === "central-ajuda: falha ao ler orientação oficial" &&
        !error.message.includes("evil.test"),
    );
  });
});
