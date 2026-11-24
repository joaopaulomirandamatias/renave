/**
 * O callback OIDC carrega `code` e `state` na query string. O log de requisição
 * padrão do Fastify registraria a URL inteira, então a query é sempre removida.
 */
export function stripQuery(url: string): string {
  const index = url.search(/[?#]/u);
  return index === -1 ? url : url.slice(0, index);
}

export const redactedLogPaths = [
  "req.headers.authorization",
  "req.headers.cookie",
  'req.headers["idempotency-key"]',
  "req.body.cnpj",
  "req.body.password",
  "req.body.token",
  "req.body.tradeName",
  'res.headers["set-cookie"]',
  "res.headers.location",
];
