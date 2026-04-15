// Git smart-HTTP CORS shim: forwards GET/POST to an allow-listed host.
// URL shape: https://{this-worker}/{targetUrl including protocol}
// Example:   https://proxy.example/https://git.genesisrnd.com/g/r.git/info/refs?service=git-upload-pack

// Exact host matches AND any subdomain of these suffixes are allowed.
const ALLOWED_HOSTS: string[] = [];
const ALLOWED_SUFFIXES = [".frontierrnd.com", ".genesisrnd.com"];

function corsHeaders(extra: Record<string, string> = {}): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers":
      "authorization,content-type,user-agent,accept,content-encoding,git-protocol",
    "Access-Control-Expose-Headers":
      "content-type,content-length,content-encoding,www-authenticate",
    ...extra,
  };
}

function isAllowed(target: URL): boolean {
  if (ALLOWED_HOSTS.includes(target.host)) return true;
  return ALLOWED_SUFFIXES.some(s => target.host.endsWith(s));
}

export default {
  async fetch(req: Request): Promise<Response> {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    const url = new URL(req.url);
    const targetStr = url.pathname.slice(1) + url.search;
    if (!targetStr.startsWith("http://") && !targetStr.startsWith("https://")) {
      return new Response("Bad proxy URL", { status: 400, headers: corsHeaders() });
    }

    let target: URL;
    try {
      target = new URL(targetStr);
    } catch {
      return new Response("Invalid URL", { status: 400, headers: corsHeaders() });
    }

    if (!isAllowed(target)) {
      return new Response("Host not allowed", { status: 403, headers: corsHeaders() });
    }

    const fwdHeaders = new Headers();
    for (const [k, v] of req.headers) {
      const key = k.toLowerCase();
      if (
        [
          "host",
          "origin",
          "referer",
          "cookie",
          "sec-fetch-site",
          "sec-fetch-mode",
          "sec-fetch-dest",
        ].includes(key)
      )
        continue;
      fwdHeaders.set(k, v);
    }

    const upstream = await fetch(target.toString(), {
      method: req.method,
      headers: fwdHeaders,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
      // @ts-expect-error cloudflare-specific
      redirect: "manual",
    });

    const resHeaders = new Headers(upstream.headers);
    for (const [k, v] of Object.entries(corsHeaders())) resHeaders.set(k, v as string);

    return new Response(upstream.body, { status: upstream.status, headers: resHeaders });
  },
};
