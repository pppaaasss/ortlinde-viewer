import assert from "node:assert/strict";
import { createServer } from "node:net";

function findFreePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.on("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolvePort(port));
    });
  });
}

async function fetchText(url, init) {
  const response = await fetch(url, init);
  return {
    response,
    text: await response.text()
  };
}

const port = await findFreePort();
process.env.PORT = String(port);

const { startServer } = await import("../server.mjs");
const server = await startServer({ silent: true });
const baseUrl = `http://127.0.0.1:${port}`;

try {
  const root = await fetchText(`${baseUrl}/`);
  assert.equal(root.response.status, 200);
  assert.match(root.response.headers.get("content-type") || "", /text\/html/);
  assert.equal(root.response.headers.get("cache-control"), "no-store");
  assert.match(root.text, /<div id="app"><\/div>/);

  const manifest = await fetchText(`${baseUrl}/manifest.webmanifest`);
  assert.equal(manifest.response.status, 200);
  assert.equal(manifest.response.headers.get("cache-control"), "no-store");
  assert.match(manifest.response.headers.get("content-type") || "", /manifest\+json/);

  const serviceWorker = await fetchText(`${baseUrl}/sw.js`);
  assert.equal(serviceWorker.response.status, 200);
  assert.equal(serviceWorker.response.headers.get("cache-control"), "no-store");
  assert.match(serviceWorker.response.headers.get("content-type") || "", /javascript/);
  assert.match(serviceWorker.text, /cache\.addAll\(APP_SHELL\)\)\s*\.catch\(\(\) => undefined\)/);
  assert.match(serviceWorker.text, /caches\.delete\(key\)\.catch\(\(\) => false\)/);
  assert.match(serviceWorker.text, /caches\.match\(event\.request\)\.catch\(\(\) => undefined\)/);
  assert.match(serviceWorker.text, /cache\.put\(event\.request, copy\)\)\s*\.catch\(\(\) => undefined\)/);

  const assetMatch = root.text.match(/\/assets\/[^"]+\.js/);
  assert.ok(assetMatch, "expected built JavaScript asset in index");
  const asset = await fetchText(`${baseUrl}${assetMatch[0]}`);
  assert.equal(asset.response.status, 200);
  assert.equal(asset.response.headers.get("cache-control"), "public, max-age=31536000, immutable");

  const headRoot = await fetchText(`${baseUrl}/`, { method: "HEAD" });
  assert.equal(headRoot.response.status, 200);
  assert.match(headRoot.response.headers.get("content-type") || "", /text\/html/);
  assert.equal(headRoot.text, "");

  const postStatic = await fetchText(`${baseUrl}/`, { method: "POST" });
  assert.equal(postStatic.response.status, 405);
  assert.equal(postStatic.response.headers.get("cache-control"), "no-store");
  assert.equal(postStatic.response.headers.get("allow"), "GET, HEAD");
  assert.equal(postStatic.text, "Method not allowed");

  const badStaticPath = await fetchText(`${baseUrl}/%E0%A4%A`);
  assert.equal(badStaticPath.response.status, 400);
  assert.equal(badStaticPath.response.headers.get("cache-control"), "no-store");
  assert.equal(badStaticPath.text, "Bad request");

  const spaFallback = await fetchText(`${baseUrl}/gallery/anything`);
  assert.equal(spaFallback.response.status, 200);
  assert.match(spaFallback.text, /<div id="app"><\/div>/);

  const traversal = await fetchText(`${baseUrl}/%2e%2e/server.mjs`);
  assert.equal(traversal.response.status, 200);
  assert.match(traversal.text, /<div id="app"><\/div>/);
  assert.doesNotMatch(traversal.text, /UPSTREAM|createServer/);

  const badApi = await fetchText(`${baseUrl}/api/not-real`);
  assert.equal(badApi.response.status, 404);
  assert.deepEqual(JSON.parse(badApi.text), { error: "not_found" });

  const postApi = await fetchText(`${baseUrl}/api/categories`, { method: "POST" });
  assert.equal(postApi.response.status, 405);
  assert.equal(postApi.response.headers.get("allow"), "GET");
  assert.deepEqual(JSON.parse(postApi.text), { error: "method_not_allowed" });

  console.log("static tests passed");
} finally {
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
}
