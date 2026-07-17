import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Workspace packages ship TS/TSX source; Next transpiles them.
  transpilePackages: ["@wcp/ui", "@wcp/tokens", "@wcp/analytics"],
};

export default nextConfig;
