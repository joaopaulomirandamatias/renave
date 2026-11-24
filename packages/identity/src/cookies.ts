export interface CookieOptions {
  maxAgeSeconds: number;
  secure: boolean;
}

export interface CookieNames {
  session: string;
  login: string;
}

/**
 * Com `Secure` o prefixo `__Host-` é usado: o navegador só aceita o cookie se
 * ele for Secure, Path=/ e sem Domain, o que impede cookie tossing por
 * subdomínios.
 */
export function cookieNames(secure: boolean): CookieNames {
  const prefix = secure ? "__Host-" : "";
  return {
    session: `${prefix}renave_session`,
    login: `${prefix}renave_login`,
  };
}

/** Cookie sempre HttpOnly, SameSite=Lax (o retorno do IdP é navegação top-level) e Path=/. */
export function serializeCookie(
  name: string,
  value: string,
  options: CookieOptions,
): string {
  const parts = [
    `${name}=${value}`,
    "Path=/",
    `Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearCookie(name: string, secure: boolean): string {
  return serializeCookie(name, "", { maxAgeSeconds: 0, secure });
}

/**
 * Lê um cookie do cabeçalho. Nome repetido é tratado como ausente: é sinal de
 * cookie tossing e não há como saber qual valor é legítimo.
 */
export function readCookie(
  header: string | undefined,
  name: string,
): string | undefined {
  if (!header) return undefined;
  let found: string | undefined;
  let count = 0;
  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 0) continue;
    if (pair.slice(0, separator).trim() !== name) continue;
    count += 1;
    found = pair.slice(separator + 1).trim();
  }
  return count === 1 && found ? found : undefined;
}
