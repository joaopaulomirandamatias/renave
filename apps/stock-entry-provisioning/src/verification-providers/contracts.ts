import type {
  RenaveProfileEvidenceBinding,
  RenaveProfileEvidenceProvider,
  VerifiedProfileEvidence,
} from "@seu-renave/protected-evidence";

export interface RenaveVerificationProvider {
  readonly id: RenaveProfileEvidenceProvider;
  verifyEvidence(
    attestation: string,
    binding: RenaveProfileEvidenceBinding,
  ): Promise<VerifiedProfileEvidence>;
}

export interface RenaveVerificationProviderRegistry {
  get(providerId: string): RenaveVerificationProvider;
  list(): readonly string[];
}
