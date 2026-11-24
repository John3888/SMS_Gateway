import type { NextConfig } from "next";

import { networkInterfaces } from "node:os";

const localAddresses = Object.values(networkInterfaces()).flatMap(entries =>
  (entries ?? []).filter(entry => entry.family === "IPv4" && !entry.internal).map(entry => entry.address),
);

const nextConfig: NextConfig = {
  output: "standalone",
  allowedDevOrigins: localAddresses,
  async rewrites() {
    const backend = process.env.GATEWAY_ORIGIN || "http://192.168.1.108:5400";
    return [{ source: "/api/:path*", destination: backend + "/api/:path*" }];
  },
  experimental: {
    agentFeedback: true,
  },
  cacheComponents: true,
  partialPrefetching: true,
};
export default nextConfig;
