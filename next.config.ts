import type { NextConfig } from "next";

// Security headers. The CSP is the docs' non-nonce variant (node_modules/next/dist/docs/
// 01-app/02-guides/content-security-policy.md, "Without Nonces"): pages are prerendered,
// so scripts need 'unsafe-inline' (Next's inline bootstrap and layout.tsx's THEME_SCRIPT).
// The browser talks to Supabase directly (REST, auth, storage, realtime websockets).
const isDev = process.env.NODE_ENV === "development";
const supabase = (() => {
  try {
    return new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "");
  } catch {
    return null;
  }
})();
const supabaseOrigins = supabase
  ? [supabase.origin, `${supabase.protocol === "https:" ? "wss:" : "ws:"}//${supabase.host}`]
  : [];
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: blob: ${supabase?.origin ?? ""}`.trim(),
  "font-src 'self'",
  // data:/blob: because store.tsx turns the photo picker's data URLs into uploads with fetch()
  `connect-src 'self' data: blob: ${supabaseOrigins.join(" ")}`.trim(),
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  // Only when the app talks to an https Supabase (not the local http test stack)
  ...(supabase?.protocol === "https:" ? ["upgrade-insecure-requests"] : []),
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const nextConfig: NextConfig = {
  /* config options here */
  // scripts/test-env.mjs sets NEXT_DIST_DIR=.next-test so a test build never overwrites .next
  distDir: process.env.NEXT_DIST_DIR || ".next",
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
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
