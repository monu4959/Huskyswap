import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  // Loaded from their package folders at runtime, so the tracer can't see them: the SQL
  // guard's Postgres parser (.wasm) and the embedding model's native runtime (Linux, for Vercel)
  serverExternalPackages: ["libpg-query"],
  // onnxruntime-node needs its package.json and JS (not just the binary), and onnxruntime-common;
  // without them the route fails to load on Vercel with "Cannot find module 'onnxruntime-node'".
  // Only the two CPU files: a Linux install may also download GPU libraries into that folder,
  // which would push the function past Vercel's size limit.
  outputFileTracingIncludes: {
    "/api/ask": [
      "./node_modules/libpg-query/wasm/*",
      "./node_modules/onnxruntime-node/package.json",
      "./node_modules/onnxruntime-node/dist/**",
      "./node_modules/onnxruntime-node/bin/napi-v6/linux/x64/libonnxruntime.so.1",
      "./node_modules/onnxruntime-node/bin/napi-v6/linux/x64/onnxruntime_binding.node",
      "./node_modules/onnxruntime-common/**",
    ],
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
