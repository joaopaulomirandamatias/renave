declare module "vitest" {
  interface ProvidedContext {
    dbUrls: {
      admin: string;
      app: string;
      identity: string;
      maintenance: string;
      migrator: string;
      operationWorker: string;
      profileProvisioner: string;
    };
  }
}

export {};
