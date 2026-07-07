import assert from "node:assert/strict";
import { buildRoute } from "../server.mjs";

function route(path) {
  const result = buildRoute(path);
  assert.ok(result, `expected route for ${path}`);
  return result;
}

const slashTag = route("/api/tag/A%2FB/preview");
assert.equal(slashTag.upstreamUrl, "https://veil.ortlinde.com/v1/tag/A%2FB/preview");
assert.equal(slashTag.cacheKey, "/v1/tag/A%2FB/preview?");
assert.equal(slashTag.isPreview, true);

const rawSlashTag = route("/api/tag/A/B/preview");
assert.equal(rawSlashTag.upstreamUrl, "https://veil.ortlinde.com/v1/tag/A%2FB/preview");

const chineseTag = route(`/api/tag/${encodeURIComponent("蠢沫沫")}/preview`);
assert.equal(chineseTag.upstreamUrl, "https://veil.ortlinde.com/v1/tag/%E8%A0%A2%E6%B2%AB%E6%B2%AB/preview");

const randomWithTag = route(`/api/gallery/random?tag=${encodeURIComponent("A/B")}&ignored=1`);
assert.equal(randomWithTag.upstreamUrl, "https://veil.ortlinde.com/v1/gallery/random?tag=A%2FB");
assert.equal(randomWithTag.cacheable, false);

const randomWithWhitespace = route(`/api/gallery/random?category=${encodeURIComponent(" China ")}&tag=%20`);
assert.equal(randomWithWhitespace.upstreamUrl, "https://veil.ortlinde.com/v1/gallery/random?category=China");

const tagsPage = route("/api/tags?limit=5000&offset=-9");
assert.equal(tagsPage.upstreamUrl, "https://veil.ortlinde.com/v1/tags?limit=1000&offset=0");

const minimumTagsPage = route("/api/tags?limit=0&offset=12.9");
assert.equal(minimumTagsPage.upstreamUrl, "https://veil.ortlinde.com/v1/tags?limit=1&offset=12");

assert.equal(buildRoute("/api/tag/%E0%A4%A/preview"), null);
assert.equal(buildRoute("/api/gallery/not-a-number"), null);

console.log("route tests passed");
