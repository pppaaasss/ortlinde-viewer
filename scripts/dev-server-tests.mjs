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

function withTimeout(promise, timeoutMs, message) {
  let timer = null;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, rejectTimeout) => {
      timer = setTimeout(() => rejectTimeout(new Error(message)), timeoutMs);
    })
  ]);
}

function closeServer(server) {
  return new Promise((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
}

const port = await findFreePort();
process.env.PORT = String(port);
if (!process.argv.includes("--dev")) process.argv.push("--dev");

const { startServer } = await import("../server.mjs");
const server = await withTimeout(startServer({ silent: true }), 20_000, "dev server did not start");
const baseUrl = `http://127.0.0.1:${port}`;

try {
  const response = await fetch(`${baseUrl}/`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /<div id="app"><\/div>/);
} finally {
  await withTimeout(closeServer(server), 20_000, "dev server did not close");
}

console.log("dev server tests passed");
