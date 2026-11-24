import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["src/**/*.test.ts"],
          exclude: ["src/integration/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "integration",
          include: ["src/integration/**/*.test.ts"],
          globalSetup: ["../../packages/db/test/integration/global-setup.ts"],
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
