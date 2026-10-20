import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  // Loaded from their package folders at runtime, so the tracer can't see them: the SQL
  // guard's Postgres parser (.wasm) and the embedding model's native runtime (Linux, for Vercel)
  serverExternalPackages: ["libpg-query"],
  outputFileTracingIncludes: {
    "/api/ask": ["./node_modules/libpg-query/wasm/*", "./node_modules/onnxruntime-node/bin/napi-v6/linux/x64/**"],
  },
  partialPrefetching: true,
  experimental: {
    // Only validate instant navigation where a segment opts in with `instant`.
    // The demo's signed-in pages render in the browser (localStorage session),
    // so implicit validation would flag every one of them.
    instantInsights: { validationLevel: "manual-warning" },
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
