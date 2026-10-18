import { buildContentSecurityPolicy, SECURITY_HEADERS } from "./src/lib/security/csp.mjs";

const standalone = process.env.NEXT_OUTPUT_MODE === "standalone";

/** @type {import("next").NextConfig} */
const config = {
  output: standalone ? "standalone" : "export",
  basePath: process.env.NEXT_PUBLIC_BASE_PATH || "",
  transpilePackages: ["db-schema-toolkit"],
  images: {
    unoptimized: true,
  },
  trailingSlash: true,
  // A static export cannot send headers: layout.tsx carries the CSP in a <meta> tag.
  headers: standalone ? async () => [
    {
      source: "/(.*)",
      headers: [
        {
          key: "Content-Security-Policy",
          value: buildContentSecurityPolicy({ dev: process.env.NODE_ENV !== "production" }),
        },
        ...SECURITY_HEADERS,
      ],
    },
  ] : undefined,
};

export default config;
