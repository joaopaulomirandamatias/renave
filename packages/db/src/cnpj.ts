/**
 * CNPJ normalizado: 12 posições alfanuméricas (A-Z, 0-9; o numérico é
 * subconjunto) + 2 dígitos verificadores numéricos. Armazenado em maiúsculas
 * e sem máscara. Espelha `renave.normalize_cnpj` / `renave.cnpj_is_valid`.
 */
const NORMALIZED_PATTERN = /^[0-9A-Z]{12}[0-9]{2}$/;
const WEIGHTS_FIRST = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
const WEIGHTS_SECOND = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];

export function normalizeCnpj(raw: string): string {
  return raw.replace(/[./\s-]/g, "").toUpperCase();
}

function checkDigit(
  values: readonly number[],
  weights: readonly number[],
): number {
  const total = values.reduce(
    (sum, value, index) => sum + value * (weights[index] ?? 0),
    0,
  );
  const remainder = total % 11;
  return remainder < 2 ? 0 : 11 - remainder;
}

/** Calcula os dois dígitos verificadores de uma base de 12 posições. */
export function computeCnpjCheckDigits(base: string): string {
  const normalized = normalizeCnpj(base);
  if (!/^[0-9A-Z]{12}$/.test(normalized)) {
    throw new RangeError(
      "A base do CNPJ deve ter 12 posições alfanuméricas (A-Z, 0-9).",
    );
  }
  const values = [...normalized].map((char) => char.charCodeAt(0) - 48);
  const first = checkDigit(values, WEIGHTS_FIRST);
  const second = checkDigit([...values, first], WEIGHTS_SECOND);
  return `${first}${second}`;
}

/** Valida a forma normalizada (não aplica a normalização). */
export function isValidNormalizedCnpj(cnpj: string): boolean {
  if (!NORMALIZED_PATTERN.test(cnpj) || /^([0-9])\1{13}$/.test(cnpj))
    return false;
  return computeCnpjCheckDigits(cnpj.slice(0, 12)) === cnpj.slice(12);
}

/** Normaliza e valida; lança se o CNPJ for inválido. */
export function parseCnpj(raw: string): string {
  const normalized = normalizeCnpj(raw);
  if (!isValidNormalizedCnpj(normalized)) {
    throw new RangeError("CNPJ inválido (forma ou dígitos verificadores).");
  }
  return normalized;
}
