import { StockEntryProvisioningError } from "../errors.js";
import type {
  RenaveVerificationProvider,
  RenaveVerificationProviderRegistry,
} from "./contracts.js";

/** Registro deliberadamente vazio: promoção exige uma integração futura explícita. */
export const verificationProviders: RenaveVerificationProviderRegistry =
  Object.freeze({
    get(_providerId: string): RenaveVerificationProvider {
      throw new StockEntryProvisioningError("PROFILE_VERIFICATION_UNAVAILABLE");
    },
    list(): readonly string[] {
      return Object.freeze([]);
    },
  });
