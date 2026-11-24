import { describe, expect, it } from "vitest";
import {
  computeCnpjCheckDigits,
  isValidNormalizedCnpj,
  normalizeCnpj,
  parseCnpj,
} from "../../src/cnpj.js";

describe("cnpj", () => {
  it("normaliza máscara e caixa, sem tocar nas letras válidas", () => {
    expect(normalizeCnpj("11.222.333/0001-81")).toBe("11222333000181");
    expect(normalizeCnpj(" 12.abc.345/01de-35 ")).toBe("12ABC34501DE35");
  });

  it("calcula dígitos verificadores numéricos e alfanuméricos (ASCII − 48)", () => {
    expect(computeCnpjCheckDigits("112223330001")).toBe("81");
    expect(computeCnpjCheckDigits("12ABC34501DE")).toBe("35");
  });

  it("valida a forma normalizada", () => {
    expect(isValidNormalizedCnpj("11222333000181")).toBe(true);
    expect(isValidNormalizedCnpj("12ABC34501DE35")).toBe(true);
    expect(isValidNormalizedCnpj("11222333000182")).toBe(false); // DV errado
    expect(isValidNormalizedCnpj("12ABC34501DE3A")).toBe(false); // DV não numérico
    expect(isValidNormalizedCnpj("12abc34501de35")).toBe(false); // exige normalizado
    expect(isValidNormalizedCnpj("00000000000000")).toBe(false); // sequência repetida
    expect(isValidNormalizedCnpj("1122233300018")).toBe(false); // tamanho
  });

  it("parseCnpj normaliza e rejeita inválidos", () => {
    expect(parseCnpj("12.ABC.345/01DE-35")).toBe("12ABC34501DE35");
    expect(() => parseCnpj("11.222.333/0001-80")).toThrow(RangeError);
  });
});
