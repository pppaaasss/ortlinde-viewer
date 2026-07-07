import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const LOCK_DIR = resolve(".build-lock");
const STALE_MS = 2 * 60_000;

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

async function acquireBuildLock() {
  const started = Date.now();
  while (Date.now() - started < STALE_MS) {
    try {
      mkdirSync(LOCK_DIR);
      writeFileSync(resolve(LOCK_DIR, "pid"), String(process.pid));
      return;
    } catch {
      await sleep(250);
    }
  }

  rmSync(LOCK_DIR, { recursive: true, force: true });
  mkdirSync(LOCK_DIR);
  writeFileSync(resolve(LOCK_DIR, "pid"), String(process.pid));
}

function run(script, args) {
  const result = spawnSync(process.execPath, [resolve(script), ...args], { stdio: "inherit" });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const error = new Error(`${script} exited with status ${result.status ?? 1}`);
    error.exitCode = result.status ?? 1;
    throw error;
  }
}

await acquireBuildLock();
try {
  run("node_modules/typescript/lib/tsc.js", ["--noEmit"]);
  run("node_modules/vite/bin/vite.js", ["build"]);
} catch (error) {
  if (!error?.exitCode) console.error(error);
  process.exitCode = error?.exitCode || 1;
} finally {
  rmSync(LOCK_DIR, { recursive: true, force: true });
}
