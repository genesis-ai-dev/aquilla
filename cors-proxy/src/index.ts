// Git smart-HTTP CORS shim: forwards GET/POST to an allow-listed host.
// URL shape: https://{this-worker}/{targetUrl including protocol}
// Example:   https://proxy.example/https://gitlab.frontierrnd.com/g/r.git/info/refs?service=git-upload-pack

// Exact host matches AND any subdomain of these suffixes are allowed.
const ALLOWED_HOSTS: string[] = [];
const ALLOWED_SUFFIXES = [".frontierrnd.com", ".genesisrnd.com"];

function corsHeaders(extra: Record<string, string> = {}): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers":
      "authorization,content-type,user-agent,accept,accept-encoding,content-encoding,git-protocol,private-token,x-requested-with",
    "Access-Control-Expose-Headers":
      "content-type,content-length,content-encoding,www-authenticate,x-total,x-total-pages,x-page,x-per-page,x-next-page,x-prev-page,link",
    ...extra,
  };
}

function isAllowed(target: URL): boolean {
  if (ALLOWED_HOSTS.includes(target.host)) return true;
  return ALLOWED_SUFFIXES.some((s) => target.host.endsWith(s));
}

// Extract the target URL from the original request string (not via URL parser,
// to avoid path normalization collapsing `//` in `https://`).
function extractTarget(reqUrl: string): string | null {
  const u = new URL(reqUrl);
  const prefix = `${u.protocol}//${u.host}/`;
  if (!reqUrl.startsWith(prefix)) return null;
  let rest = reqUrl.slice(prefix.length);
  // Strip any leading slashes (some clients emit `proxy//https://...`).
  while (rest.startsWith("/")) rest = rest.slice(1);
  return rest;
}

const HOP_BY_HOP = new Set([
  "host", "origin", "referer", "cookie",
  "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest",
  "x-forwarded-for", "x-forwarded-proto", "x-real-ip",
  "cf-connecting-ip", "cf-ipcountry", "cf-ray", "cf-visitor",
]);

export default {
  async fetch(req: Request): Promise<Response> {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    const targetStr = extractTarget(req.url);
    if (!targetStr || (!targetStr.startsWith("http://") && !targetStr.startsWith("https://"))) {
      return new Response(`Bad proxy URL: ${req.url}`, { status: 400, headers: corsHeaders() });
    }

    let target: URL;
    try {
      target = new URL(targetStr);
    } catch {
      return new Response(`Invalid URL: ${targetStr}`, { status: 400, headers: corsHeaders() });
    }

    if (!isAllowed(target)) {
      return new Response(`Host not allowed: ${target.host}`, { status: 403, headers: corsHeaders() });
    }

    const fwdHeaders = new Headers();
    for (const [k, v] of req.headers) {
      if (HOP_BY_HOP.has(k.toLowerCase())) continue;
      fwdHeaders.set(k, v);
    }

    const init: RequestInit & { duplex?: "half" } = {
      method: req.method,
      headers: fwdHeaders,
      redirect: "follow",
    };
    if (req.method !== "GET" && req.method !== "HEAD") {
      init.body = req.body;
      init.duplex = "half";
    }

    let upstream: Response;
    try {
      upstream = await fetch(target.toString(), init);
    } catch (e) {
      return new Response(
        `Upstream fetch failed for ${target.toString()}: ${e instanceof Error ? e.message : String(e)}`,
        { status: 502, headers: corsHeaders() },
      );
    }

    const resHeaders = new Headers(upstream.headers);
    for (const [k, v] of Object.entries(corsHeaders())) resHeaders.set(k, v as string);

    return new Response(upstream.body, { status: upstream.status, headers: resHeaders });
  },
};
