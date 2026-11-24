const MAX_LENGTH = 512;
const DEFAULT_RETURN_TO = "/";
// Caracteres de controle e barras invertidas permitem truques de parsing.
// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[\u0000-\u001f\u007f\\]/u;

/**
 * Aceita apenas caminhos relativos da própria aplicação. Qualquer coisa que
 * possa apontar para outro host (`//host`, `/\host`, `https://…`, `javascript:`)
 * volta ao padrão. Os caminhos de `/api/auth/` são recusados para evitar laços.
 */
export function sanitizeReturnTo(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_RETURN_TO;
  if (value.length === 0 || value.length > MAX_LENGTH) return DEFAULT_RETURN_TO;
  if (!value.startsWith("/") || value.startsWith("//"))
    return DEFAULT_RETURN_TO;
  if (FORBIDDEN.test(value)) return DEFAULT_RETURN_TO;

  let parsed: URL;
  try {
    parsed = new URL(value, "https://app.invalid");
  } catch {
    return DEFAULT_RETURN_TO;
  }
  if (parsed.origin !== "https://app.invalid") return DEFAULT_RETURN_TO;
  if (parsed.pathname.startsWith("/api/auth/")) return DEFAULT_RETURN_TO;

  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}
