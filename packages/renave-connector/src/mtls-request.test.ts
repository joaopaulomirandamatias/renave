import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createHomologationPemMtlsClient,
  InvalidPemMtlsMaterialError,
  PemMtlsProductionBlockedError,
  RenaveMtlsOriginError,
  RenaveMtlsResponseTooLargeError,
  readBoundedResponseBody,
  type PemMtlsMaterial,
} from "./index.js";

// Material autocontido, gerado exclusivamente para teste. Não é credencial.
const TEST_CERTIFICATE = `-----BEGIN CERTIFICATE-----
MIIDLTCCAhWgAwIBAgIUCr8j6Ml10B0v6vb00UYuNiVjqA4wDQYJKoZIhvcNAQEL
BQAwHTEbMBkGA1UEAwwSUkVOQVZFIFRlc3QgQ2xpZW50MB4XDTI2MTEyNDAxMTM1
N1oXDTM2MTEyMTAxMTM1N1owHTEbMBkGA1UEAwwSUkVOQVZFIFRlc3QgQ2xpZW50
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAz1BgINyqUOHCzanonSfN
4jmXxcAazHFAWHJ7834gdIqWLN9fU4YOCgL7fGSE8kGHx4BeCy9jlXOmG1MRzhlt
UFTqYCGx3lvUqSgG8YMsStQOdcKBLoe5MaW5XdbBaO7/PjvS/gNwhELjcWj170tL
gz2s9VsX+Sn5CtVrDeH1bFpzyFG9PvlPiJRfJHYL0wiu+iGYXlD48aQt7fzHp4AG
9cLQfwYmzlD52paGbBEq7PHtWtIClxXhCKztZEHPpLTUAMor9Djnre6e1GsJTZwB
CsuRICe+mMZDNcCuxu7LnUsE2Ri+tXoAw0Jnq8qp1YxSCX2eQmbUqKIqiQiPwc0T
yQIDAQABo2UwYzAdBgNVHQ4EFgQUfByRK77gADPHByVoAq+H+mNigAAwHwYDVR0j
BBgwFoAUfByRK77gADPHByVoAq+H+mNigAAwDAYDVR0TAQH/BAIwADATBgNVHSUE
DDAKBggrBgEFBQcDAjANBgkqhkiG9w0BAQsFAAOCAQEAEd+NoGf6qRN4FBBQqzbk
+PgJpzopSjYnz77NhufZeiINDWke9+c9SOCNlynXJqfnz2XTfiIyQtjbSiWAqEcj
ufcFNMPWCg7tIHzMOJ4LF+BHzFY/vmPlo9vqqkgOQEpYKXoIkMYl37yzePiDyRyq
2SXU9GinMkKFBCO6P+Bf+8tQw3fwvVpYOEK0l8Nv74tKPurr273+fvhr54SyFfRm
I2I4Ii8X4ScKyHMpG2cs8vHX1sq4CVAA7i6tcyihykhCWPbBTy1NVJgyzdkGtd7I
yeunb2Kmt2w1XSqDYOF9cT+izNijyOczUwYZsge1p/6ZPjJm8loE2arAIX6Ci+i1
LQ==
-----END CERTIFICATE-----`;

const TEST_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQDPUGAg3KpQ4cLN
qeidJ83iOZfFwBrMcUBYcnvzfiB0ipYs319Thg4KAvt8ZITyQYfHgF4LL2OVc6Yb
UxHOGW1QVOpgIbHeW9SpKAbxgyxK1A51woEuh7kxpbld1sFo7v8+O9L+A3CEQuNx
aPXvS0uDPaz1Wxf5KfkK1WsN4fVsWnPIUb0++U+IlF8kdgvTCK76IZheUPjxpC3t
/MengAb1wtB/BibOUPnaloZsESrs8e1a0gKXFeEIrO1kQc+ktNQAyiv0OOet7p7U
awlNnAEKy5EgJ76YxkM1wK7G7sudSwTZGL61egDDQmeryqnVjFIJfZ5CZtSooiqJ
CI/BzRPJAgMBAAECggEADZ0CCvZiirggch/fof48o0fT4wzn1Zf0OTqfUBBusiht
jxnF6Taq0lZ6zCLPphbOgze3NTXR7Lzw4ed1ClsaFgXVdCWSR/8wukDiH9bUwD8n
ie0RTYxlCVEQGIzjG3BiO2RzSPHR4CWCSO6zA5kmpsIUivIF43sxmtgD1SAK3Sf/
DYdZMltFIBbs7hk9kB1ztbUl0gEJptgJ1/CkR9is7z3vnWbDZXnlRuEwXatTo8fz
cwl4KkP8Y/SGjlZ71Tb+BuzbPbrgSqGHd+FAjZbPzVgGVjSaPCT3R1l/STqqtvTi
cALCe/vEoYPkn2vuKCwliDA4dIsN7V4Vw1TRBw+4GQKBgQD4kycUskY2m7lr9l+h
koiqD070DddP7U6kWD+TS42L2L2qHVG3cUcjL3PA0ydbnAoAnKxoOoT0f4ZlK1k8
cNatyWAJuH5pvZKZKx2LVPXlXkU+0uioObhqNHlWr/F0Syz1yONjR/lMPq0uZazw
XlftwHdqQc80jgXkkQVNp7GQJQKBgQDVgbOsDA/ltzmmtXBZVi6XuGqgy64eNlnW
zLSYecCk7+/kXIHLWFJWZjkI8cZOygPXB+o5NMpZT2yEbFynFsoO5xXFozK+GDne
+IaLKC/EKPsNjSsS4GzaJW4Xah/vkaw838ZTcS0H13I1LitucnUZ0WljZbf84LMb
vQb0a4AB1QKBgCqBx3ITlkwqTwf2Rp4zl6k1GvRDFam2U/dom96NUfQzKSPZBatP
9LFAoRO9SAKzaUZ3hEgCkc/ZqtrMEeNzDFMFl6Wx5fQhFduZcuDrs2z4tPCsUlrK
HA4VURaQ2cJgRJz3MGM+4JO4OBcyDePAzlp6yjDidhNvofRXFEgWQBf9AoGAW71f
do24RvxzyS4tGDXvz0Fuj6j1KAYylBlhgCLQpA51Baq6GqXYu0cxOqaojzI+dCby
faIxUC7QchYdua4RJFYnBMUbCJNgSm5/YUvjOmZheXEvEO1d2F4879Kp5kaxu3Zr
wW7f6n6olDFCeDK2HmHc5tjONdpXG5QdaOjIGAECgYBSSlu1U0KHIkf7CpsXTn/X
z34I+7xmQ74tZxNaOjJADbMRPSPzaqAAjMuk7fNhBYl2I03MEEpRhiL0H6AfyDj/
MfX6g+kOMjWdeYNxDoeupsFTSPRT+5aRdLolqSZeGgbSxHu9n72ahvXnV/hcewg8
9CybltMFNGTGH0IY6nhtTQ==
-----END PRIVATE KEY-----`;

const POLICY_TEST_PRIVATE_KEY = `-----BEGIN EC PRIVATE KEY-----
MHcCAQEEIE+JFPJJpDRwwu7oxjCVP7+33QFKbmhwUZlWZBbGcAPcoAoGCCqGSM49
AwEHoUQDQgAE/nXNZ1jOkDLCQonPnmEZU1r26mnnNoDRhdYwPCyf+E1hG30QZsjF
mspqNwmEAzT0aNBpJokxrbBbqK/3q/FcUw==
-----END EC PRIVATE KEY-----`;

const CA_CERTIFICATE = `-----BEGIN CERTIFICATE-----
MIIBgzCCASmgAwIBAgIUSP7Nmiw0sMfBEKkHO32cRcWWQ7wwCgYIKoZIzj0EAwIw
FzEVMBMGA1UEAwwMVGVzdCBDQSBsZWFmMB4XDTI2MTEyNDAxMTUzMFoXDTM2MTEy
MTAxMTUzMFowFzEVMBMGA1UEAwwMVGVzdCBDQSBsZWFmMFkwEwYHKoZIzj0CAQYI
KoZIzj0DAQcDQgAE/nXNZ1jOkDLCQonPnmEZU1r26mnnNoDRhdYwPCyf+E1hG30Q
ZsjFmspqNwmEAzT0aNBpJokxrbBbqK/3q/FcU6NTMFEwHQYDVR0OBBYEFAml+7W6
kGCOqLf22QypmOrJaPLrMB8GA1UdIwQYMBaAFAml+7W6kGCOqLf22QypmOrJaPLr
MA8GA1UdEwEB/wQFMAMBAf8wCgYIKoZIzj0EAwIDSAAwRQIgBdxQwANFobp0WJZz
18WI0FFce1QO0+TYY2HCHMgX8b8CIQC9xk8VVH90ltUVbxC5DejFikSgWll2YZC6
tqvb4cucpQ==
-----END CERTIFICATE-----`;

const SERVER_ONLY_CERTIFICATE = `-----BEGIN CERTIFICATE-----
MIIBnDCCAUOgAwIBAgIUV+z2uh5lJWNYGPkmyHwxfgkiD9swCgYIKoZIzj0EAwIw
GzEZMBcGA1UEAwwQVGVzdCBzZXJ2ZXIgb25seTAeFw0yNjExMjQwMTE1MzBaFw0z
NjExMjEwMTE1MzBaMBsxGTAXBgNVBAMMEFRlc3Qgc2VydmVyIG9ubHkwWTATBgcq
hkjOPQIBBggqhkjOPQMBBwNCAAT+dc1nWM6QMsJCic+eYRlTWvbqaec2gNGF1jA8
LJ/4TWEbfRBmyMWaymo3CYQDNPRo0GkmiTGtsFuor/er8VxTo2UwYzAdBgNVHQ4E
FgQUCaX7tbqQYI6ot/bZDKmY6slo8uswHwYDVR0jBBgwFoAUCaX7tbqQYI6ot/bZ
DKmY6slo8uswDAYDVR0TAQH/BAIwADATBgNVHSUEDDAKBggrBgEFBQcDATAKBggq
hkjOPQQDAgNHADBEAiAtyNDGLh89x2U1qTbdI9D5/WsI6pqKM3/Dj2tGPvBkHwIg
Rrd2wGWzMv7AeR3vRZ+prp74o1tJuR40APOboL5yJRQ=
-----END CERTIFICATE-----`;

const material: PemMtlsMaterial = {
  ca: TEST_CERTIFICATE,
  cert: TEST_CERTIFICATE,
  key: TEST_PRIVATE_KEY,
};

const VALID_NOW = new Date("2030-01-01T00:00:00.000Z");

function createClient(candidate: PemMtlsMaterial = material) {
  return createHomologationPemMtlsClient("homologation", candidate, {
    now: () => VALID_NOW,
  });
}

describe("createHomologationPemMtlsClient", () => {
  it("interrompe a leitura antes de acumular resposta acima do limite", async () => {
    async function* chunks() {
      yield Buffer.alloc(4, 1);
      yield Buffer.alloc(4, 2);
    }

    await expect(readBoundedResponseBody(chunks(), 7)).rejects.toBeInstanceOf(
      RenaveMtlsResponseTooLargeError,
    );
    await expect(readBoundedResponseBody(chunks(), 8)).resolves.toHaveLength(8);
  });

  it("bloqueia PEM em produção antes de criar o agente", () => {
    expect(() =>
      createHomologationPemMtlsClient("production", material),
    ).toThrow(PemMtlsProductionBlockedError);
  });

  it.each([
    ["ca", { ...material, ca: "inválida" }],
    ["cert", { ...material, cert: "inválido" }],
    ["key", { ...material, key: "inválida" }],
  ] as const)("recusa material %s malformado", (field, candidate) => {
    try {
      createHomologationPemMtlsClient("homologation", candidate);
      throw new Error("deveria recusar o material");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidPemMtlsMaterialError);
      expect(error).toMatchObject({ field });
    }
  });

  it("recusa chave válida que não corresponde ao certificado", () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const unrelatedKey = privateKey.export({
      format: "pem",
      type: "pkcs8",
    });

    expect(() => createClient({ ...material, key: unrelatedKey })).toThrow(
      expect.objectContaining({
        code: "RENAVE_MTLS_KEY_MISMATCH",
        field: "key",
      }),
    );
  });

  it.each([
    ["2020-01-01T00:00:00.000Z", "RENAVE_MTLS_CERT_NOT_YET_VALID"],
    ["2040-01-01T00:00:00.000Z", "RENAVE_MTLS_CERT_EXPIRED"],
  ] as const)("recusa certificado fora da validade em %s", (now, code) => {
    expect(() =>
      createHomologationPemMtlsClient("homologation", material, {
        now: () => new Date(now),
      }),
    ).toThrow(expect.objectContaining({ code, field: "cert" }));
  });

  it.each([
    ["certificado de CA", CA_CERTIFICATE],
    ["EKU sem clientAuth", SERVER_ONLY_CERTIFICATE],
  ])("recusa %s como certificado cliente", (_label, cert) => {
    expect(() =>
      createClient({ ...material, cert, key: POLICY_TEST_PRIVATE_KEY }),
    ).toThrow(
      expect.objectContaining({
        code: "RENAVE_MTLS_CERT_USAGE_INVALID",
        field: "cert",
      }),
    );
  });

  it("reavalia validade temporal sem reprocessar a chave", () => {
    const client = createClient();
    try {
      expect(client.isCertificateValidAt(VALID_NOW)).toBe(true);
      expect(
        client.isCertificateValidAt(new Date("2040-01-01T00:00:00Z")),
      ).toBe(false);
      expect(client.isCertificateValidAt(new Date("invalid"))).toBe(false);
    } finally {
      client.close();
    }
  });

  it("recusa qualquer origem fora da allowlist antes de abrir conexão", async () => {
    const client = createClient();
    try {
      await expect(
        client.request("https://example.com/api/cliente-autenticado", {
          method: "GET",
          redirect: "error",
        }),
      ).rejects.toBeInstanceOf(RenaveMtlsOriginError);
    } finally {
      client.close();
    }
  });

  it.each([
    "https://hom.renave.estaleiro.serpro.gov.br/renave-ws/api/rota-nao-classificada",
    "https://usuario:senha@hom.renave.estaleiro.serpro.gov.br/renave-ws/api/cliente-autenticado",
  ])("recusa rota ou credencial não autorizada: %s", async (url) => {
    const client = createClient();
    try {
      await expect(
        client.request(url, { method: "GET" }),
      ).rejects.toBeInstanceOf(RenaveMtlsOriginError);
    } finally {
      client.close();
    }
  });

  it("exige política explícita contra redirecionamento", async () => {
    const client = createClient();
    try {
      await expect(
        client.request(
          "https://hom.renave.estaleiro.serpro.gov.br/renave-ws/api/cliente-autenticado",
          { method: "GET" },
        ),
      ).rejects.toBeInstanceOf(RenaveMtlsOriginError);
    } finally {
      client.close();
    }
  });
});
