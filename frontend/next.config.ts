import type { NextConfig } from "next";

import { networkInterfaces } from "node:os";

const localAddresses = Object.values(networkInterfaces()).flatMap(entries =>
  (entries ?? []).filter(entry => entry.family === "IPv4" && !entry.internal).map(entry => entry.address),
);

const nextConfig: NextConfig = {
  output: "standalone",
  allowedDevOrigins: localAddresses,
  async rewrites() {
    const backend = process.env.GATEWAY_ORIGIN || "http://127.0.0.1:5008";
    return [{ source: "/admin-api/:path*", destination: backend + "/admin-api/:path*" }];
  },
  experimental: {
    agentFeedback: true,
  },
  cacheComponents: true,
  partialPrefetching: true,
};
export default nextConfig;
