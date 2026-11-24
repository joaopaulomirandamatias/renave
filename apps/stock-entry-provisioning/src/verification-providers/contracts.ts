export interface RenaveVerificationProvider {
  readonly id: string;
}

export interface RenaveVerificationProviderRegistry {
  get(providerId: string): RenaveVerificationProvider;
  list(): readonly string[];
}
