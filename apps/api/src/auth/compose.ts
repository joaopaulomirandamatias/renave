import {
  createIdentityService,
  createOidcClient,
  InMemorySessionStore,
  type IdentityService,
  type SessionStore,
} from "@seu-renave/identity";

import type { AppConfig } from "../config.js";

export interface ComposeIdentityOptions {
  /** Armazenamento persistente (Redis/Postgres) a ser usado em produção. */
  store?: SessionStore;
}

/**
 * Monta o serviço de identidade real (cliente OIDC + armazenamento). Falha
 * fechada: sem OIDC completo ou sem armazenamento permitido, não há serviço.
 */
export function composeIdentity(
  config: AppConfig,
  options: ComposeIdentityOptions = {},
): IdentityService {
  if (config.authMode !== "oidc" || !config.oidc) {
    throw new Error("AUTH_MODE=oidc é necessário para compor a identidade");
  }

  let store = options.store;
  if (!store) {
    if (config.sessionStore !== "memory") {
      throw new Error(
        "Nenhum armazenamento de sessão configurado: injete um SessionStore persistente ou, fora de produção, defina SESSION_STORE=memory",
      );
    }
    // O construtor recusa `production` (defesa em profundidade).
    store = new InMemorySessionStore({ environment: config.appEnvironment });
  }

  return createIdentityService({
    oidc: createOidcClient({ config: config.oidc }),
    store,
    config: config.oidc,
  });
}
