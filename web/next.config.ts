import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactCompiler: true,
  turbopack: {
    root: __dirname,
  },
  // Cross-origin isolation headers required for real SharedArrayBuffer.
  //
  // Now that the Kiri iframe is served from our own origin via the /kiri/ proxy,
  // all embedded resources are same-origin and automatically satisfy COEP.
  // This was impossible before (when the iframe was cross-origin at grid.space).
  //
  // With these headers:
  //   - The parent window gets crossOriginIsolated=true → real SharedArrayBuffer
  //   - The same-origin /kiri/ iframe inherits isolation → real SAB inside Kiri
  //   - Workers at /lib/kiri/run/worker.js (same-origin) → real SAB → animate works
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
        ],
      },
    ];
  },
  // Proxy the static assets that Kiri's HTML loads via root-relative URLs.
  // /lib/ is handled by src/app/lib/[[...path]]/route.ts (injects SAB polyfill
  // as a belt-and-suspenders fallback; no-op once COEP gives real SAB).
  async rewrites() {
    const gridSpace = "https://grid.space";
    return [
      { source: "/moto/:path*", destination: `${gridSpace}/moto/:path*` },
      { source: "/font/:path*", destination: `${gridSpace}/font/:path*` },
      { source: "/icon/:path*", destination: `${gridSpace}/icon/:path*` },
      { source: "/wasm/:path*", destination: `${gridSpace}/wasm/:path*` },
    ];
  },
};

export default nextConfig;
