import type { NextConfig } from "next";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "0.0.0.0"]);

/**
 * Development only. Next.js blocks `/_next` dev resources (HMR) requested from a page on
 * another hostname unless that hostname is listed in `allowedDevOrigins`. A hosted preview
 * frame is exactly that case, so the hostnames come from the product origins the operator
 * explicitly configured in `MOVY_PRODUCT_ORIGINS`.
 *
 * Rules, all fail-closed:
 *  - only exact `http(s)` origins (scheme, host, optional port), the same shape that
 *    `src/lib/site-origins.ts` accepts: no wildcard, path, query, fragment, or credentials;
 *  - one invalid entry rejects the whole list and leaves Next.js's default behavior;
 *  - loopback hosts are skipped (Next.js already allows them);
 *  - nothing is derived from a request's Host header, and production builds get nothing.
 *
 * This only controls dev-resource access. Product/demo classification and unknown-host
 * rejection stay exact-origin checks in `src/proxy.ts`.
 */
function devPreviewHostnames(env: NodeJS.ProcessEnv): string[] | undefined {
  if (env.NODE_ENV === "production") return undefined;
  const configured = env.MOVY_PRODUCT_ORIGINS?.trim();
  if (!configured) return undefined;

  const hostnames = new Set<string>();
  for (const candidate of configured.split(/[\s,]+/).filter(Boolean)) {
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      return undefined;
    }
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
      candidate.includes("*") || url.origin !== candidate.replace(/\/$/, "")
    ) {
      return undefined;
    }
    if (!LOOPBACK_HOSTS.has(url.hostname)) hostnames.add(url.hostname);
  }
  return hostnames.size > 0 ? [...hostnames] : undefined;
}

const allowedDevOrigins = devPreviewHostnames(process.env);

const nextConfig: NextConfig = {
  ...(allowedDevOrigins ? { allowedDevOrigins } : {}),
};

export default nextConfig;
