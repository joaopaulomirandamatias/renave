import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import { checkSerproContract } from "./check-serpro-contract.mjs";
import { fetchBoundedJson } from "./serpro-json-monitor.mjs";

const officialSource =
  "https://hom.renave.estaleiro.serpro.gov.br/renave-ws/v2/api-docs?group=Estabelecimento%20(Concession%C3%A1ria%20ou%20Revenda)";

function swaggerDocument() {
  return {
    paths: {
      "/api/cliente-autenticado": {
        get: { security: [{ cnpjEstabelecimento: [] }] },
      },
    },
    securityDefinitions: {
      cnpjEstabelecimento: { name: "CNPJ-Estabelecimento" },
    },
  };
}

function fixture(document = swaggerDocument()) {
  const body = JSON.stringify(document);
  return {
    baseline: {
      environments: {
        homologation: {
          operationCount: 1,
          operationsSecuredByCnpjEstabelecimento: 1,
          pathCount: 1,
          sha256: createHash("sha256").update(body).digest("hex"),
          source: officialSource,
        },
      },
    },
    body,
  };
}

function outputCapture() {
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

describe("monitor de contrato Swagger SERPRO", () => {
  it("aceita contrato compatível com fetch endurecido", async () => {
    const { baseline, body } = fixture();
    const requests = [];
    const { errors, logs, output } = outputCapture();

    const result = await checkSerproContract({
      baseline,
      fetchImpl: async (source, init) => {
        requests.push({ init, source });
        return new Response(body, { status: 200 });
      },
      output,
    });

    assert.deepEqual(result, { changed: false });
    assert.equal(errors.length, 0);
    assert.deepEqual(logs, ["homologation: contrato sem mudanças"]);
    assert.equal(requests[0].source, officialSource);
    assert.equal(requests[0].init.redirect, "error");
    assert.equal(requests[0].init.headers.accept, "application/json");
    assert.equal(requests[0].init.headers["accept-encoding"], "identity");
    assert.ok(requests[0].init.signal instanceof AbortSignal);
  });

  it("sinaliza métricas ou hash divergentes sem imprimir o corpo", async () => {
    const { baseline, body } = fixture();
    baseline.environments.homologation.pathCount = 2;
    const { errors, output } = outputCapture();

    const result = await checkSerproContract({
      baseline,
      fetchImpl: async () => new Response(body),
      output,
    });

    assert.deepEqual(result, { changed: true });
    assert.ok(errors.some((message) => message.includes("pathCount")));
    assert.ok(errors.every((message) => !message.includes(body)));
  });

  it("falha fechado quando o header de segurança muda", async () => {
    const document = swaggerDocument();
    document.securityDefinitions.cnpjEstabelecimento.name = "Outro-Header";
    const { baseline } = fixture(document);

    await assert.rejects(
      checkSerproContract({
        baseline,
        fetchImpl: async () => new Response(JSON.stringify(document)),
      }),
      /deixou de usar CNPJ-Estabelecimento/,
    );
  });

  it("recusa origem, path, query e credenciais fora da allowlist antes do fetch", async () => {
    for (const source of [
      "http://hom.renave.estaleiro.serpro.gov.br/renave-ws/v2/api-docs?group=Estabelecimento%20(Concession%C3%A1ria%20ou%20Revenda)",
      "https://evil.test/renave-ws/v2/api-docs?group=Estabelecimento%20(Concession%C3%A1ria%20ou%20Revenda)",
      "https://hom.renave.estaleiro.serpro.gov.br/renave-ws/v2/outro?group=Estabelecimento%20(Concession%C3%A1ria%20ou%20Revenda)",
      `${officialSource}&extra=1`,
      officialSource.replace("https://", "https://user:pass@"),
    ]) {
      let called = false;
      await assert.rejects(
        fetchBoundedJson("homologation", source, {
          fetchImpl: async () => {
            called = true;
            return new Response("{}");
          },
        }),
        /allowlist oficial/,
      );
      assert.equal(called, false);
    }
  });

  it("recusa HTTP, redirect e JSON inválido sem ecoar URL ou corpo", async () => {
    let httpBodyCancelled = false;
    await assert.rejects(
      fetchBoundedJson("homologation", officialSource, {
        fetchImpl: async () =>
          new Response(
            new ReadableStream({
              cancel() {
                httpBodyCancelled = true;
              },
            }),
            { status: 503 },
          ),
      }),
      (error) =>
        error.message === "homologation: Swagger respondeu HTTP 503" &&
        !error.message.includes(officialSource) &&
        !error.message.includes("segredo-no-corpo"),
    );
    assert.equal(httpBodyCancelled, true);

    await assert.rejects(
      fetchBoundedJson("homologation", officialSource, {
        fetchImpl: async (_source, init) => {
          assert.equal(init.redirect, "error");
          throw new TypeError("redirect recusado para https://evil.test");
        },
      }),
      (error) =>
        error.message === "homologation: falha ao consultar Swagger oficial" &&
        !error.message.includes("evil.test"),
    );

    await assert.rejects(
      fetchBoundedJson("homologation", officialSource, {
        fetchImpl: async () => new Response("segredo-json-inválido"),
      }),
      (error) =>
        error.message === "homologation: Swagger retornou JSON inválido" &&
        !error.message.includes("segredo-json-inválido"),
    );
  });

  it("propaga timeout como falha sanitizada", async () => {
    await assert.rejects(
      fetchBoundedJson("homologation", officialSource, {
        fetchImpl: async (_source, init) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener(
              "abort",
              () => reject(init.signal.reason),
              { once: true },
            );
          }),
        timeoutMs: 5,
      }),
      (error) =>
        error.message === "homologation: falha ao consultar Swagger oficial",
    );
  });

  it("recusa tamanho declarado, chunked e Content-Length enganoso", async () => {
    let cancelledByHeader = false;
    const declaredBody = new ReadableStream({
      cancel() {
        cancelledByHeader = true;
      },
    });
    await assert.rejects(
      fetchBoundedJson("homologation", officialSource, {
        fetchImpl: async () =>
          new Response(declaredBody, {
            headers: { "content-length": "100" },
          }),
        maxBytes: 4,
      }),
      /excede limite de 4 bytes/,
    );
    assert.equal(cancelledByHeader, true);

    for (const headers of [undefined, { "content-length": "1" }]) {
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(Buffer.from('{"a"'));
          controller.enqueue(Buffer.from(":1}"));
          controller.close();
        },
      });
      await assert.rejects(
        fetchBoundedJson("homologation", officialSource, {
          fetchImpl: async () => new Response(body, { headers }),
          maxBytes: 4,
        }),
        /excede limite de 4 bytes/,
      );
    }
  });

  it("aceita corpo exatamente no limite e sanitiza timeout durante leitura", async () => {
    const exact = '{"a":1}';
    const { document } = await fetchBoundedJson(
      "homologation",
      officialSource,
      {
        fetchImpl: async () => new Response(exact),
        maxBytes: Buffer.byteLength(exact),
      },
    );
    assert.deepEqual(document, { a: 1 });

    await assert.rejects(
      fetchBoundedJson("homologation", officialSource, {
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
        timeoutMs: 5,
      }),
      (error) =>
        error.message === "homologation: falha ao ler Swagger oficial" &&
        !error.message.includes("evil.test"),
    );
  });

  it("recusa Content-Length malformado e aceita zeros à esquerda", async () => {
    for (const declaredLength of ["-1", "1.5", "1, 2", "not-a-number"]) {
      await assert.rejects(
        fetchBoundedJson("homologation", officialSource, {
          fetchImpl: async () =>
            new Response("{}", {
              headers: { "content-length": declaredLength },
            }),
        }),
        /Content-Length da resposta é inválido/,
      );
    }

    const { document } = await fetchBoundedJson(
      "homologation",
      officialSource,
      {
        fetchImpl: async () =>
          new Response("{}", { headers: { "content-length": "0002" } }),
      },
    );
    assert.deepEqual(document, {});
  });

  it("mede bytes multibyte, recusa UTF-8 inválido e não mascara falha de cancel", async () => {
    const multibyte = JSON.stringify({ valor: "é" });
    await assert.rejects(
      fetchBoundedJson("homologation", officialSource, {
        fetchImpl: async () => new Response(multibyte),
        maxBytes: Buffer.byteLength(multibyte) - 1,
      }),
      /excede limite/,
    );

    await assert.rejects(
      fetchBoundedJson("homologation", officialSource, {
        fetchImpl: async () => new Response(new Uint8Array([0x7b, 0xff, 0x7d])),
      }),
      /Swagger retornou JSON inválido/,
    );

    let cancelAttempted = false;
    const hostileBody = new ReadableStream({
      cancel() {
        cancelAttempted = true;
        throw new Error("cancel falhou");
      },
      start(controller) {
        controller.enqueue(Buffer.alloc(8));
      },
    });
    await assert.rejects(
      fetchBoundedJson("homologation", officialSource, {
        fetchImpl: async () => new Response(hostileBody),
        maxBytes: 4,
      }),
      /excede limite de 4 bytes/,
    );
    assert.equal(cancelAttempted, true);
  });
});
