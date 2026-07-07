import { execFile } from "node:child_process";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { basename, extname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const ENTRY_FILE = fileURLToPath(import.meta.url);
const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)));
const DIST = join(ROOT, "dist");
const UPSTREAM = "https://veil.ortlinde.com";
const IS_DEV = process.argv.includes("--dev");
const PORT = sanitizePort(process.env.PORT, 5173);

const CACHE_TTL = {
  meta: 10 * 60_000,
  gallery: 5 * 60_000,
  preview: 45_000
};

const globalLimiter = createWindowLimiter(55, 300_000);
const previewLimiter = createWindowLimiter(28, 300_000);
const responseCache = new Map();
const pendingRequests = new Map();
const execFileAsync = promisify(execFile);
const MAX_CACHE_ENTRIES = 180;

let upstreamBlockedUntil = 0;
let upstreamBackoffUntil = 0;
let backoffMs = 0;

function sanitizePort(value, fallback) {
  const port = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return fallback;
  return port;
}

function createWindowLimiter(maxRequests, windowMs) {
  const timestamps = [];
  return {
    take(now = Date.now()) {
      while (timestamps.length && now - timestamps[0] >= windowMs) timestamps.shift();
      if (timestamps.length >= maxRequests) {
        return { ok: false, retryAfterMs: windowMs - (now - timestamps[0]) };
      }
      timestamps.push(now);
      return { ok: true, remaining: maxRequests - timestamps.length };
    }
  };
}

function json(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers
  });
  res.end(payload);
}

function sanitizePositiveInt(value, fallback, max, min = 0) {
  const n = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(Math.max(n, min), max);
}

export function buildRoute(reqUrl) {
  let url;
  let pathname;
  let rawPathname;
  try {
    url = new URL(reqUrl, "http://local");
    rawPathname = url.pathname;
    pathname = decodeURI(rawPathname);
  } catch {
    return null;
  }
  const query = new URLSearchParams();
  let upstreamPath = "";
  let ttl = CACHE_TTL.meta;
  let isPreview = false;
  let cacheable = true;

  if (pathname === "/api/site-config") {
    upstreamPath = "/v1/site-config";
  } else if (pathname === "/api/categories") {
    upstreamPath = "/v1/categories";
  } else if (pathname === "/api/featured-tags") {
    upstreamPath = "/v1/featured-tags";
  } else if (pathname === "/api/tags") {
    upstreamPath = "/v1/tags";
    query.set("limit", String(sanitizePositiveInt(url.searchParams.get("limit"), 100, 1000, 1)));
    query.set("offset", String(sanitizePositiveInt(url.searchParams.get("offset"), 0, 200000)));
  } else if (pathname === "/api/gallery/random") {
    upstreamPath = "/v1/gallery/random";
    cacheable = false;
    for (const key of ["category", "include_category", "exclude_category", "tag", "include_tag", "exclude_tag"]) {
      const value = url.searchParams.get(key);
      const normalized = value?.trim().slice(0, 240);
      if (normalized) query.set(key, normalized);
    }
  } else if (/^\/api\/gallery\/\d+$/.test(pathname)) {
    upstreamPath = pathname.replace("/api", "/v1");
    ttl = CACHE_TTL.gallery;
  } else if (/^\/api\/image\/\d+\/meta$/.test(pathname)) {
    upstreamPath = pathname.replace("/api", "/v1");
    ttl = CACHE_TTL.gallery;
  } else if (rawPathname.startsWith("/api/tag/") && rawPathname.endsWith("/preview")) {
    const encodedName = rawPathname.slice("/api/tag/".length, -"/preview".length);
    let tagName;
    try {
      tagName = decodeURIComponent(encodedName);
    } catch {
      return null;
    }
    if (!tagName || tagName.length > 160) return null;
    upstreamPath = `/v1/tag/${encodeURIComponent(tagName)}/preview`;
    ttl = CACHE_TTL.preview;
    isPreview = true;
  } else {
    return null;
  }

  const qs = query.toString();
  return {
    upstreamUrl: `${UPSTREAM}${upstreamPath}${qs ? `?${qs}` : ""}`,
    cacheKey: `${upstreamPath}?${qs}`,
    ttl,
    isPreview,
    cacheable
  };
}

async function readUpstream(route) {
  const now = Date.now();
  if (upstreamBlockedUntil > now) {
    return {
      status: 403,
      body: {
        error: "upstream_blocked",
        message: "上游已返回封禁状态，本会话暂停请求。",
        retryAfterMs: upstreamBlockedUntil - now
      }
    };
  }
  if (upstreamBackoffUntil > now) {
    return {
      status: 429,
      body: {
        error: "cooldown",
        message: "上游限流冷却中。",
        retryAfterMs: upstreamBackoffUntil - now
      }
    };
  }

  const cached = responseCache.get(route.cacheKey);
  if (route.cacheable && cached && cached.expiresAt > now) {
    return { status: 200, body: cached.body, cache: "hit" };
  }

  if (pendingRequests.has(route.cacheKey)) {
    return pendingRequests.get(route.cacheKey);
  }

  const globalTicket = globalLimiter.take(now);
  if (!globalTicket.ok) {
    return {
      status: 429,
      body: {
        error: "local_rate_limit",
        message: "本地代理已暂停请求以避免触发上游封禁。",
        retryAfterMs: globalTicket.retryAfterMs
      }
    };
  }

  if (route.isPreview) {
    const previewTicket = previewLimiter.take(now);
    if (!previewTicket.ok) {
      return {
        status: 429,
        body: {
          error: "preview_rate_limit",
          message: "标签预览请求过快。",
          retryAfterMs: previewTicket.retryAfterMs
        }
      };
    }
  }

  const promise = fetchUpstream(route.upstreamUrl)
    .then(async (upstream) => {
      const text = upstream.text;
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        if (upstream.status === 403) {
          body = { error: "upstream_forbidden", message: "上游返回 403，可能已触发 Cloudflare 或封禁策略。" };
        } else if (upstream.status === 429) {
          body = { error: "upstream_rate_limited", message: "上游返回 429，请等待冷却。" };
        } else {
          body = { error: "invalid_upstream_json", message: text.slice(0, 500) };
        }
      }

      if (upstream.status === 403) {
        upstreamBlockedUntil = Date.now() + 30 * 60_000;
      } else if (upstream.status === 429) {
        backoffMs = backoffMs ? Math.min(backoffMs * 2, 5 * 60_000) : 30_000;
        upstreamBackoffUntil = Date.now() + backoffMs;
      } else if (upstream.status >= 200 && upstream.status < 300) {
        backoffMs = 0;
        if (route.cacheable) setCachedResponse(route.cacheKey, body, route.ttl);
      }

      return { status: upstream.status, body, cache: "miss" };
    })
    .catch((error) => ({
      status: 502,
      body: {
        error: "upstream_fetch_failed",
        message: error instanceof Error ? error.message : String(error)
      }
    }))
    .finally(() => pendingRequests.delete(route.cacheKey));

  pendingRequests.set(route.cacheKey, promise);
  return promise;
}

function setCachedResponse(key, body, ttl) {
  const now = Date.now();
  for (const [cacheKey, cached] of responseCache) {
    if (cached.expiresAt <= now) responseCache.delete(cacheKey);
  }

  responseCache.set(key, {
    body,
    expiresAt: now + ttl
  });

  while (responseCache.size > MAX_CACHE_ENTRIES) {
    const oldestKey = responseCache.keys().next().value;
    if (!oldestKey) break;
    responseCache.delete(oldestKey);
  }
}

async function fetchUpstream(url) {
  if (process.platform === "win32") {
    return fetchUpstreamWithCurl(url, "curl.exe");
  }

  try {
    return await fetchUpstreamWithCurl(url, "curl");
  } catch {
    const response = await fetch(url, {
      headers: {
        accept: "application/json",
        referer: "https://veil.ortlinde.com/"
      }
    });
    return {
      status: response.status,
      text: await response.text(),
      contentType: response.headers.get("content-type") || ""
    };
  }
}

async function fetchUpstreamWithCurl(url, binary) {
  const marker = "__ORTLINDE_VIEWER_META__";
  const { stdout } = await execFileAsync(
    binary,
    [
      "-sS",
      "-L",
      "--max-time",
      "25",
      "-H",
      "Accept: application/json",
      "-H",
      "Referer: https://veil.ortlinde.com/",
      "-w",
      `\n${marker}:%{http_code}:%{content_type}`,
      url
    ],
    {
      maxBuffer: 12 * 1024 * 1024,
      windowsHide: true
    }
  );

  const markerIndex = stdout.lastIndexOf(`\n${marker}:`);
  if (markerIndex < 0) {
    return { status: 502, text: stdout, contentType: "" };
  }
  const text = stdout.slice(0, markerIndex);
  const meta = stdout.slice(markerIndex + marker.length + 2).trim();
  const [statusText, ...contentParts] = meta.split(":");
  return {
    status: Number(statusText) || 502,
    text,
    contentType: contentParts.join(":")
  };
}

async function handleApi(req, res) {
  if (req.method !== "GET") {
    json(res, 405, { error: "method_not_allowed" }, { "allow": "GET" });
    return;
  }

  const route = buildRoute(req.url || "/");
  if (!route) {
    json(res, 404, { error: "not_found" });
    return;
  }

  const result = await readUpstream(route);
  const retryAfterMs = Number(result.body?.retryAfterMs || 0);
  json(res, result.status, result.body, {
    "x-proxy-cache": result.cache || "bypass",
    ...(retryAfterMs > 0 ? { "retry-after": String(Math.ceil(retryAfterMs / 1000)) } : {})
  });
}

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp"
};

function serveStatic(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "allow": "GET, HEAD"
    });
    res.end("Method not allowed");
    return;
  }

  let url;
  let requested;
  try {
    url = new URL(req.url || "/", "http://local");
    requested = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store"
    });
    res.end("Bad request");
    return;
  }
  const filePath = requested === "/" ? join(DIST, "index.html") : join(DIST, requested);
  const resolved = resolve(filePath);
  const lowerDist = DIST.toLowerCase();
  const lowerResolved = resolved.toLowerCase();
  const insideDist = lowerResolved === lowerDist || lowerResolved.startsWith(`${lowerDist}${sep}`);

  let target = insideDist && existsSync(resolved) ? resolved : join(DIST, "index.html");
  if (existsSync(target) && statSync(target).isDirectory()) target = join(target, "index.html");
  if (!existsSync(target)) {
    res.writeHead(404, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store"
    });
    res.end("Build output not found. Run npm run build first.");
    return;
  }

  const ext = extname(target);
  const fileName = basename(target);
  const cacheControl =
    ext === ".html" || ext === ".webmanifest" || fileName === "sw.js"
      ? "no-store"
      : "public, max-age=31536000, immutable";
  res.writeHead(200, {
    "content-type": mimeTypes[ext] || "application/octet-stream",
    "cache-control": cacheControl
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }

  createReadStream(target)
    .on("error", (error) => {
      res.destroy(error);
    })
    .pipe(res);
}

export async function startServer({ silent = false } = {}) {
  let vite = null;
  if (IS_DEV) {
    const { createServer: createViteServer } = await import("vite");
    vite = await createViteServer({
      root: ROOT,
      server: {
        middlewareMode: true,
        hmr: silent ? false : undefined,
        ws: silent ? false : undefined,
        watch: {
          ignored: ["**/.chrome-profile/**", "**/test-results/**", "**/*.log"]
        }
      },
      appType: "spa"
    });
  }

  const server = createServer((req, res) => {
    if ((req.url || "").startsWith("/api/")) {
      handleApi(req, res).catch((error) => {
        if (res.headersSent) {
          res.destroy(error);
          return;
        }
        json(res, 500, {
          error: "internal_error",
          message: error instanceof Error ? error.message : String(error)
        });
      });
      return;
    }

    if (vite) {
      vite.middlewares(req, res, () => {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("Not found");
      });
      return;
    }

    serveStatic(req, res);
  });
  attachViteClose(server, vite);

  try {
    await new Promise((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(PORT, "0.0.0.0", () => {
        server.off("error", rejectListen);
        if (!silent) {
          const mode = IS_DEV ? "dev" : "production";
          console.log(`Ortlinde Viewer ${mode} server: http://localhost:${PORT}`);
        }
        resolveListen();
      });
    });
  } catch (error) {
    if (vite) await vite.close().catch(() => undefined);
    throw error;
  }

  return server;
}

function attachViteClose(server, vite) {
  if (!vite) return;
  const closeServer = server.close.bind(server);
  let viteClosePromise = null;

  server.close = (callback) => {
    closeServer((serverError) => {
      viteClosePromise ||= vite.close();
      viteClosePromise
        .then(() => {
          if (callback) callback(serverError);
        })
        .catch((viteError) => {
          if (callback) {
            callback(viteError);
            return;
          }
          server.emit("error", viteError);
        });
    });
    return server;
  };
}

if (process.argv[1] && resolve(process.argv[1]) === ENTRY_FILE) {
  startServer().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
