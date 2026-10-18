import { describe, it, expect } from "vitest";
import { buildContentSecurityPolicy } from "@/lib/security/csp.mjs";

describe("buildContentSecurityPolicy", () => {
  it("does not allow eval in production", () => {
    expect(buildContentSecurityPolicy()).not.toContain("unsafe-eval");
    expect(buildContentSecurityPolicy({ dev: true })).toContain("'unsafe-eval'");
  });

  it("locks down plugins, base URI and form targets", () => {
    const policy = buildContentSecurityPolicy();
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("base-uri 'self'");
    expect(policy).toContain("form-action 'self'");
    expect(policy).toContain("frame-ancestors 'none'");
  });

  it("omits directives that a meta tag cannot carry", () => {
    expect(buildContentSecurityPolicy({ meta: true })).not.toContain("frame-ancestors");
  });

  it("allows any HTTPS provider and local endpoints", () => {
    expect(buildContentSecurityPolicy()).toContain("connect-src 'self' https: http://localhost:* http://127.0.0.1:*");
  });
});
