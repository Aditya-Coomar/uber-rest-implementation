import type { NextConfig } from "next";

/**
 * The browser talks to same-origin paths that Next proxies to the local
 * backend, so the app works on localhost and behind a single public URL
 * (e.g. a Cloudflare tunnel). `npm start` writes the actual targets into
 * .env.local. Only the public Rides API and the load simulator are proxied;
 * Marketplace and Payments stay on localhost.
 */
const ridesTarget = (process.env.RIDES_API_PROXY_TARGET ?? "http://127.0.0.1:4100").replace(/\/+$/, "");
const simTarget = (process.env.SIM_API_PROXY_TARGET ?? "http://127.0.0.1:4103").replace(/\/+$/, "");

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      { source: "/rides-api/:path*", destination: `${ridesTarget}/:path*` },
      { source: "/sim-api/:path*", destination: `${simTarget}/:path*` },
    ];
  },
  cacheComponents: true,
  partialPrefetching: true,
  reactCompiler: true,
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
