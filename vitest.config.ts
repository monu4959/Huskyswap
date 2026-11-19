import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Unit tests only: no database, no network, no model calls. Anything that would
// reach Postgres (db.ts, ops-db.ts) or a model (llm.ts) is mocked in the tests.
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
    // Fixed zone so date formatting is the same on every machine (and Boston is the app's zone)
    env: { TZ: "America/New_York" },
    clearMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
  },
});
