import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // The Next.js dashboard (src/app/page.tsx) is served at "/".
  // The static TheFrontHub site remains accessible at /index.html,
  // /dashboard.html, /profile.html, /runs.html, /tournois.html, etc.
};

export default nextConfig;
