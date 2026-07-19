import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Workspace packages ship TS/TSX source; Next transpiles them.
  transpilePackages: ["@wcp/ui", "@wcp/tokens", "@wcp/analytics"],
  // Ship the OG-image fonts (read via fs at generation time) in the bundle.
  outputFileTracingIncludes: {
    "/opengraph-image": ["./app/_og/**"],
  },
};

export default nextConfig;
