// Single source for the Content-Security-Policy. It is served as an HTTP header
// in standalone mode (next.config.js) and as a <meta http-equiv> tag in the
// static export (app/layout.tsx), where headers cannot be set.
//
// 'unsafe-inline' stays on scripts because Next injects inline bootstrap
// scripts and nonces are impossible in a static export. 'unsafe-eval' is only
// needed by the dev server.

/**
 * @param {{ dev?: boolean, meta?: boolean }} [options]
 *   `meta` drops directives that browsers ignore in a <meta> tag.
 * @returns {string}
 */
export function buildContentSecurityPolicy({ dev = false, meta = false } = {}) {
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    // AI calls go straight from the browser to any provider or custom endpoint.
    "connect-src 'self' https: http://localhost:* http://127.0.0.1:*",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ];
  if (!meta) directives.push("frame-ancestors 'none'");
  return directives.join("; ");
}

export const SECURITY_HEADERS = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
];
