import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const RESULTS_DIR = resolve("test-results");
let cdpEndpoint = "";
let appUrl = process.env.APP_URL || "";
let profileDir = "";

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

function findChrome() {
  return process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
}

async function removePathWithRetry(path, attempts = 8) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === attempts) throw error;
      await sleep(150 * attempt);
    }
  }
}

async function stopProcess(child) {
  if (child.exitCode !== null) return;
  child.kill();
  await new Promise((resolveExit) => {
    const timer = setTimeout(resolveExit, 2500);
    child.once("exit", () => {
      clearTimeout(timer);
      resolveExit();
    });
  });
}

async function findFreePort() {
  if (process.env.CDP_PORT) return Number(process.env.CDP_PORT);

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

async function waitForCdp(timeoutMs = 10_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`${cdpEndpoint}/json/version`);
      if (response.ok) return;
    } catch {
      await sleep(250);
    }
  }
  throw new Error("Chrome CDP did not become ready");
}

async function getPageWs() {
  let pages = await (await fetch(`${cdpEndpoint}/json/list`)).json();
  let page = pages.find((item) => item.type === "page");
  if (!page) {
    await fetch(`${cdpEndpoint}/json/new`, { method: "PUT" });
    pages = await (await fetch(`${cdpEndpoint}/json/list`)).json();
    page = pages.find((item) => item.type === "page");
  }
  assert.ok(page?.webSocketDebuggerUrl, "missing page websocket");
  return page.webSocketDebuggerUrl;
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
  }

  static async connect(url) {
    const client = new CDP(new WebSocket(url));
    await new Promise((resolveOpen, rejectOpen) => {
      client.ws.onopen = resolveOpen;
      client.ws.onerror = rejectOpen;
    });
    client.ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id && client.pending.has(message.id)) {
        const item = client.pending.get(message.id);
        client.pending.delete(message.id);
        message.error ? item.reject(new Error(JSON.stringify(message.error))) : item.resolve(message.result);
        return;
      }
      if (message.method === "Runtime.exceptionThrown" || message.method === "Log.entryAdded") {
        client.events.push(message);
      }
    };
    return client;
  }

  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolveSend, rejectSend) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectSend(new Error(`CDP command timed out: ${method}`));
      }, 15_000);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolveSend(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          rejectSend(error);
        }
      });
    });
  }

  async eval(expression) {
    const result = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }

  close() {
    this.ws.close();
  }
}

async function waitFor(client, expression, timeoutMs = 20_000) {
  const started = Date.now();
  let lastValue;
  while (Date.now() - started < timeoutMs) {
    lastValue = await client.eval(expression);
    if (lastValue) return lastValue;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${expression}\nlast=${JSON.stringify(lastValue)}`);
}

async function withTimeout(promise, timeoutMs, message) {
  let timer = 0;
  try {
    return await Promise.race([
      promise,
      new Promise((_, rejectTimeout) => {
        timer = setTimeout(() => rejectTimeout(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function sessionFor(gallery, index = 0) {
  return { gallery, index, selectedCategory: "" };
}

async function loadSession(client, session) {
  const encoded = JSON.stringify(JSON.stringify(session));
  await client.eval(`localStorage.clear(); localStorage.setItem('ortlinde.viewer.session.v1', ${encoded}); location.reload(); true`);
  await waitFor(client, "document.readyState === 'complete' && !!document.querySelector('#mainImage')", 10_000);
}

async function snapshot(client, name) {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const shot = await client.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  writeFileSync(join(RESULTS_DIR, name), Buffer.from(shot.data, "base64"));
}

function runtimeIssues(client) {
  return client.events
    .map((event) => event.params)
    .filter((params) => (params.entry ? params.entry.level === "error" : true));
}

async function runSmoke() {
  const client = await CDP.connect(await getPageWs());
  await client.send("Page.enable");
  await client.send("Runtime.enable");
  await client.send("Log.enable");
  await client.send("Network.enable");
  await client.send("Network.setCacheDisabled", { cacheDisabled: true });
  await client.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `(() => {
      localStorage.setItem('ortlinde.viewer.recent-tags.v1', JSON.stringify(['Alpha']));
      window.__apiCalls = [];
      window.__randomCallCount = 0;
      const originalFetch = window.fetch.bind(window);
      window.fetch = (input, init) => {
        const url = typeof input === 'string' ? input : input.url;
        window.__apiCalls.push(url);
        if (url.includes('/api/categories')) {
          return Promise.resolve(new Response(JSON.stringify({ items: [{ name: 'China', gallery_count: 1 }] }), { status: 200, headers: { 'content-type': 'application/json' } }));
        }
        if (url.includes('/api/featured-tags')) {
          return Promise.resolve(new Response(JSON.stringify({ items: [{ id: 1, name: 'Alpha' }, { id: 2, name: 'Beta' }] }), { status: 200, headers: { 'content-type': 'application/json' } }));
        }
        if (url.includes('/api/tags')) {
          return Promise.resolve(new Response(JSON.stringify({ items: [{ id: 10, name: 'Gamma' }, { id: 11, name: 'Delta' }], total: 2, offset: 0, limit: 200 }), { status: 200, headers: { 'content-type': 'application/json' } }));
        }
        if (url.includes('/api/gallery/random?tag=Beta')) {
          return Promise.resolve(new Response(JSON.stringify({ message: 'mock tag gallery not found' }), { status: 404, headers: { 'content-type': 'application/json' } }));
        }
        if (url.includes('/api/tag/Beta/preview')) {
          return Promise.resolve(new Response(JSON.stringify({ image_ids: [0, 949956, 949956, -7, 999999999] }), { status: 200, headers: { 'content-type': 'application/json' } }));
        }
        if (url.includes('/api/gallery/random')) {
          window.__randomCallCount += 1;
          if (window.__randomCallCount === 1) {
            return Promise.resolve(new Response(JSON.stringify({ message: 'mock not found' }), { status: 404, headers: { 'content-type': 'application/json' } }));
          }
          return Promise.resolve(new Response(JSON.stringify({ message: 'mock cooldown', retryAfterMs: 60_000 }), { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '60' } }));
        }
        return originalFetch(input, init);
      };
    })();`
  });

  const valid = sessionFor({
    id: 949956,
    title: "Browser Smoke",
    category: "China",
    image_count: 2,
    tags: ["Alpha"],
    images: [
      { id: 949956, width: 1200, height: 1800 },
      { id: 949956, width: 1200, height: 1800 }
    ]
  });

  await client.send("Emulation.setDeviceMetricsOverride", { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false });
  await client.send("Page.navigate", { url: appUrl });
  await waitFor(client, "document.readyState === 'complete' && !!document.querySelector('#app')", 10_000);
  const metadata = await waitFor(client, `(() => {
    const chips = [...document.querySelectorAll('#featuredTags .chip')].map((node) => node.textContent);
    const categoryButtons = [...document.querySelectorAll('#categoryChips [data-category]')].map((node) => node.textContent);
    if (!chips.includes('Beta') || !categoryButtons.includes('China')) return false;
    return {
      chips,
      uniqueChipCount: new Set(chips.map((value) => value.toLowerCase())).size,
      categoryButtons,
      apiCalls: window.__apiCalls
    };
  })()`, 10_000);
  assert.deepEqual(metadata.chips, ["Alpha", "Beta"]);
  assert.equal(metadata.uniqueChipCount, 2);
  assert.ok(metadata.categoryButtons.includes("China"));
  assert.deepEqual(metadata.apiCalls.filter((url) => url.includes("/api/")), ["/api/categories", "/api/featured-tags"]);
  const emptyLink = await client.eval(`(() => {
    const link = document.querySelector('#openImageLink');
    return {
      disabled: link.getAttribute('aria-disabled'),
      href: link.getAttribute('href'),
      tabIndex: link.tabIndex,
      loaderHidden: document.querySelector('#imageLoader').hidden
    };
  })()`);
  assert.deepEqual(emptyLink, { disabled: "true", href: null, tabIndex: -1, loaderHidden: true });

  await client.eval("document.querySelector('#loadTagsBtn').click(); true");
  const tagsComplete = await waitFor(client, `(() => {
    const button = document.querySelector('#loadTagsBtn');
    const rows = [...document.querySelectorAll('#tagResults .tag-row')].map((node) => node.textContent.trim());
    const tagCalls = window.__apiCalls.filter((url) => url.includes('/api/tags'));
    if (tagCalls.length !== 1 || rows.length !== 2 || !button.disabled) return false;
    return {
      rows,
      tagCalls,
      buttonText: button.textContent,
      buttonDisabled: button.disabled
    };
  })()`, 10_000);
  await client.eval("document.querySelector('#loadTagsBtn').click(); true");
  await sleep(250);
  const tagCallsAfterSecondClick = await client.eval("window.__apiCalls.filter((url) => url.includes('/api/tags'))");
  assert.deepEqual(tagsComplete.rows, ["Gamma", "Delta"]);
  assert.deepEqual(tagsComplete.tagCalls, ["/api/tags?limit=200&offset=0"]);
  assert.equal(tagsComplete.buttonText, "标签已加载");
  assert.equal(tagsComplete.buttonDisabled, true);
  assert.deepEqual(tagCallsAfterSecondClick, ["/api/tags?limit=200&offset=0"]);

  await client.eval("document.querySelector('#featuredTags [data-tag=\"Beta\"]').click(); true");
  const tagPreview = await waitFor(client, `(() => {
    const img = document.querySelector('#mainImage');
    if (!img?.naturalWidth || !img.classList.contains('loaded')) return false;
    const session = JSON.parse(localStorage.getItem('ortlinde.viewer.session.v1') || '{}');
    return {
      title: document.querySelector('#galleryTitle').textContent,
      meta: document.querySelector('#galleryMeta').textContent,
      infoMeta: document.querySelector('#infoMeta').textContent,
      sessionGallery: session.gallery,
      apiCalls: window.__apiCalls.filter((url) => url.includes('/api/gallery/random?tag=Beta') || url.includes('/api/tag/Beta/preview'))
    };
  })()`, 15_000);
  assert.equal(tagPreview.title, "标签预览（仅 6 张）：Beta");
  assert.match(tagPreview.meta, /1\/2/);
  assert.match(tagPreview.meta, /仅 6 张样本/);
  assert.match(tagPreview.infoMeta, /不代表标签全部结果/);
  assert.equal(tagPreview.sessionGallery, null);
  assert.deepEqual(tagPreview.apiCalls, ["/api/gallery/random?tag=Beta", "/api/tag/Beta/preview"]);

  await client.eval("document.querySelector('#randomBtn').click(); true");
  const plainError = await waitFor(client, `(() => {
    const status = document.querySelector('#statusPill');
    if (status?.textContent !== '没有可用内容') return false;
    document.querySelector('#mainImage').dispatchEvent(new Event('load'));
    return {
      textAfterImageLoad: status.textContent,
      kindAfterImageLoad: status.dataset.kind || '',
      randomCalls: window.__apiCalls.filter((url) => url === '/api/gallery/random')
    };
  })()`, 10_000);
  assert.equal(plainError.textAfterImageLoad, "没有可用内容");
  assert.equal(plainError.kindAfterImageLoad, "error");
  assert.deepEqual(plainError.randomCalls, ["/api/gallery/random"]);

  await client.eval("document.querySelector('#randomBtn').click(); true");
  const cooldown = await waitFor(client, `(() => {
    const status = document.querySelector('#statusPill');
    if (!status?.textContent.startsWith('冷却')) return false;
    document.querySelector('#mainImage').dispatchEvent(new Event('load'));
    const activeCategoryBefore = document.querySelector('#categoryChips .active')?.textContent || '';
    document.querySelector('#categoryChips [data-category="China"]')?.click();
    const activeCategoryAfter = document.querySelector('#categoryChips .active')?.textContent || '';
    return {
      textAfterImageLoad: status.textContent,
      kindAfterImageLoad: status.dataset.kind || '',
      requestButtonsDisabled: [
        document.querySelector('#categoryChips [data-category="China"]')?.disabled,
        document.querySelector('#featuredTags [data-tag="Alpha"]')?.disabled,
        document.querySelector('#tagResults [data-tag="Gamma"]')?.disabled
      ],
      categoryStayed: activeCategoryBefore === activeCategoryAfter,
      randomCalls: window.__apiCalls.filter((url) => url === '/api/gallery/random')
    };
  })()`, 10_000);
  assert.match(cooldown.textAfterImageLoad, /^冷却/);
  assert.equal(cooldown.kindAfterImageLoad, "warn");
  assert.deepEqual(cooldown.requestButtonsDisabled, [true, true, true]);
  assert.equal(cooldown.categoryStayed, true);
  assert.deepEqual(cooldown.randomCalls, ["/api/gallery/random", "/api/gallery/random"]);


  await loadSession(client, valid);
  const desktop = await waitFor(client, `(() => {
    const img = document.querySelector('#mainImage');
    if (!img?.naturalWidth || !img.classList.contains('loaded')) return false;
    const before = img.naturalWidth;
    const favoritePressedBefore = document.querySelector('#favoriteBtn').getAttribute('aria-pressed');
    document.querySelector('#favoriteBtn').click();
    const afterFavorite = img.naturalWidth;
    const favoritePressedAfter = document.querySelector('#favoriteBtn').getAttribute('aria-pressed');
    const favoriteRowBeforeOpen = document.querySelector('#favoriteList [data-image-id="949956"]');
    if (!favoriteRowBeforeOpen) return false;
    const infoExpandedBefore = document.querySelector('#infoBtn').getAttribute('aria-expanded');
    document.querySelector('#infoBtn').click();
    const infoOpened = document.querySelector('#infoSheet').classList.contains('open');
    const infoExpandedOpen = document.querySelector('#infoBtn').getAttribute('aria-expanded');
    const infoHasTag = [...document.querySelectorAll('#infoTags .chip')].some((node) => node.textContent === 'Alpha');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    const infoClosed = !document.querySelector('#infoSheet').classList.contains('open');
    const infoExpandedClosed = document.querySelector('#infoBtn').getAttribute('aria-expanded');
    document.querySelector('#tagSearch').focus();
    const beforeKey = document.querySelector('#galleryMeta').textContent;
    document.querySelector('#tagSearch').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    const afterInputKey = document.querySelector('#galleryMeta').textContent;
    document.querySelector('#tagSearch').blur();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    const afterDocKey = document.querySelector('#galleryMeta').textContent;
    favoriteRowBeforeOpen.click();
    const favoriteOpened = document.querySelector('#galleryMeta').textContent.includes('Favorite · 1/1');
    const favoriteImageLoaded = img.classList.contains('loaded') && document.querySelector('#imageLoader').hidden && img.naturalWidth === before;
    const top = document.querySelector('.topbar').getBoundingClientRect();
    const stage = document.querySelector('#imageStage').getBoundingClientRect();
    const bottom = document.querySelector('.bottom-bar').getBoundingClientRect();
    return {
      before,
      afterFavorite,
      favoriteActive: document.querySelector('#favoriteBtn').classList.contains('active'),
      favoritePressedBefore,
      favoritePressedAfter,
      favoriteRowExists: !!favoriteRowBeforeOpen,
      favoriteOpened,
      favoriteImageLoaded,
      infoOpened,
      infoExpandedBefore,
      infoExpandedOpen,
      infoExpandedClosed,
      infoHasTag,
      infoClosed,
      inputKeyStayed: beforeKey === afterInputKey,
      documentKeyMoved: afterDocKey.includes('2/2'),
      objectFit: getComputedStyle(img).objectFit,
      noTopOverlap: stage.top >= top.bottom - 1,
      noBottomOverlap: bottom.top >= stage.bottom - 1
    };
  })()`, 25_000);

  assert.equal(desktop.before, 1200);
  assert.equal(desktop.afterFavorite, 1200);
  assert.equal(desktop.favoriteActive, true);
  assert.equal(desktop.favoritePressedBefore, "false");
  assert.equal(desktop.favoritePressedAfter, "true");
  assert.equal(desktop.favoriteRowExists, true);
  assert.equal(desktop.favoriteOpened, true);
  assert.equal(desktop.favoriteImageLoaded, true);
  assert.equal(desktop.infoOpened, true);
  assert.equal(desktop.infoExpandedBefore, "false");
  assert.equal(desktop.infoExpandedOpen, "true");
  assert.equal(desktop.infoExpandedClosed, "false");
  assert.equal(desktop.infoHasTag, true);
  assert.equal(desktop.infoClosed, true);
  assert.equal(desktop.inputKeyStayed, true);
  assert.equal(desktop.documentKeyMoved, true);
  assert.equal(desktop.objectFit, "contain");
  assert.equal(desktop.noTopOverlap, true);
  assert.equal(desktop.noBottomOverlap, true);
  await snapshot(client, "browser-smoke-desktop.png");

  await client.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await loadSession(client, valid);
  const mobile = await waitFor(client, `(() => {
    const img = document.querySelector('#mainImage');
    if (!img?.naturalWidth || !img.classList.contains('loaded')) return false;
    const top = document.querySelector('.topbar').getBoundingClientRect();
    const stage = document.querySelector('#imageStage').getBoundingClientRect();
    const bottom = document.querySelector('.bottom-bar').getBoundingClientRect();
    const expandedBefore = document.querySelector('#openSidebar').getAttribute('aria-expanded');
    document.querySelector('#openSidebar').click();
    const opened = document.querySelector('#sidebar').classList.contains('open');
    const expandedOpen = document.querySelector('#openSidebar').getAttribute('aria-expanded');
    document.querySelector('#closeSidebar').click();
    const expandedClosed = document.querySelector('#openSidebar').getAttribute('aria-expanded');
    return {
      viewport: { width: innerWidth, height: innerHeight },
      noTopOverlap: stage.top >= top.bottom - 1,
      noBottomOverlap: bottom.top >= stage.bottom - 1,
      sidebarOpened: opened,
      sidebarClosed: !document.querySelector('#sidebar').classList.contains('open'),
      sidebarExpandedBefore: expandedBefore,
      sidebarExpandedOpen: expandedOpen,
      sidebarExpandedClosed: expandedClosed,
      naturalWidth: img.naturalWidth
    };
  })()`, 25_000);

  assert.equal(mobile.viewport.width, 390);
  assert.equal(mobile.noTopOverlap, true);
  assert.equal(mobile.noBottomOverlap, true);
  assert.equal(mobile.sidebarOpened, true);
  assert.equal(mobile.sidebarClosed, true);
  assert.equal(mobile.sidebarExpandedBefore, "false");
  assert.equal(mobile.sidebarExpandedOpen, "true");
  assert.equal(mobile.sidebarExpandedClosed, "false");
  assert.equal(mobile.naturalWidth, 1200);
  await snapshot(client, "browser-smoke-mobile.png");

  await client.send("Emulation.setDeviceMetricsOverride", { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false });
  await loadSession(client, valid);
  const failedWhileInfoOpen = await waitFor(client, `(() => {
    const img = document.querySelector('#mainImage');
    if (!img?.naturalWidth || !img.classList.contains('loaded')) return false;
    document.querySelector('#infoBtn').click();
    const openBefore = document.querySelector('#infoSheet').classList.contains('open');
    img.dispatchEvent(new Event('error'));
    return {
      openBefore,
      openAfter: document.querySelector('#infoSheet').classList.contains('open'),
      expandedAfter: document.querySelector('#infoBtn').getAttribute('aria-expanded'),
      infoDisabled: document.querySelector('#infoBtn').disabled,
      emptyHidden: document.querySelector('#emptyState').hidden,
      status: document.querySelector('#statusPill').textContent
    };
  })()`, 25_000);
  assert.equal(failedWhileInfoOpen.openBefore, true);
  assert.equal(failedWhileInfoOpen.openAfter, false);
  assert.equal(failedWhileInfoOpen.expandedAfter, "false");
  assert.equal(failedWhileInfoOpen.infoDisabled, true);
  assert.equal(failedWhileInfoOpen.emptyHidden, false);
  assert.equal(failedWhileInfoOpen.status, "图片加载失败");

  const corruptSession = sessionFor({
    id: 1001,
    title: "Corrupt Stored Gallery",
    category: "Test",
    image_count: 4,
    tags: [],
    images: [
      { id: -1, width: 1200, height: 1800 },
      { id: 0, width: 1200, height: 1800 },
      { id: 949956, width: -1200, height: 1800 },
      { id: 1.5, width: 1200, height: 1800 }
    ]
  });
  const corruptFavorites = [
    { id: -1, title: "Invalid Negative" },
    { id: 0, title: "Invalid Zero" },
    { id: 949956, title: "Valid Favorite", width: -1200, height: 1800 },
    { id: 1.5, title: "Invalid Fraction" }
  ];
  await client.eval(`
    localStorage.clear();
    localStorage.setItem('ortlinde.viewer.session.v1', ${JSON.stringify(JSON.stringify(corruptSession))});
    localStorage.setItem('ortlinde.viewer.favorites.v1', ${JSON.stringify(JSON.stringify(corruptFavorites))});
    location.reload();
    true
  `);
  const sanitizedStoredState = await waitFor(client, `(() => {
    const img = document.querySelector('#mainImage');
    if (!img?.naturalWidth || !img.classList.contains('loaded')) return false;
    return {
      src: img.getAttribute('src') || '',
      meta: document.querySelector('#galleryMeta').textContent,
      favoriteRows: [...document.querySelectorAll('#favoriteList [data-image-id]')].map((node) => node.dataset.imageId)
    };
  })()`, 25_000);
  assert.match(sanitizedStoredState.src, /\/949956$/);
  assert.equal(sanitizedStoredState.meta, "Test · 1/1");
  assert.deepEqual(sanitizedStoredState.favoriteRows, ["949956"]);

  await loadSession(client, sessionFor({
    id: 999999999,
    title: "Broken Single",
    category: "Test",
    image_count: 1,
    tags: ["broken"],
    images: [{ id: 999999999, width: 1200, height: 1800 }]
  }));
  const broken = await waitFor(client, `(() => {
    const status = document.querySelector('#statusPill');
    const empty = document.querySelector('#emptyState');
    const link = document.querySelector('#openImageLink');
    return status?.textContent === '图片加载失败' && empty?.hidden === false
      ? {
        status: status.textContent,
        emptyHidden: empty.hidden,
        imgSrc: document.querySelector('#mainImage').getAttribute('src') || '',
        linkDisabled: link.getAttribute('aria-disabled'),
        linkHref: link.getAttribute('href'),
        linkTabIndex: link.tabIndex,
        loaderHidden: document.querySelector('#imageLoader').hidden
      }
      : false;
  })()`, 15_000);

  assert.equal(broken.status, "图片加载失败");
  assert.equal(broken.emptyHidden, false);
  assert.equal(broken.imgSrc, "");
  assert.equal(broken.linkDisabled, "true");
  assert.equal(broken.linkHref, null);
  assert.equal(broken.linkTabIndex, -1);
  assert.equal(broken.loaderHidden, true);

  const issues = runtimeIssues(client);
  assert.deepEqual(issues, []);
  client.close();

  return { desktop, mobile, broken };
}

async function main() {
  profileDir = mkdtempSync(join(tmpdir(), "ortlinde-browser-smoke-"));
  let appServer = null;
  if (!appUrl) {
    const appPort = await findFreePort();
    process.env.PORT = String(appPort);
    const { startServer } = await import("../server.mjs");
    appServer = await startServer({ silent: true });
    appUrl = `http://127.0.0.1:${appPort}`;
  }

  const cdpPort = await findFreePort();
  cdpEndpoint = `http://127.0.0.1:${cdpPort}`;
  const chrome = spawn(findChrome(), [
    "--headless=new",
    `--remote-debugging-port=${cdpPort}`,
    "--remote-allow-origins=*",
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--disable-gpu",
    "--window-size=1366,900",
    "about:blank"
  ], { stdio: "ignore", windowsHide: true });

  try {
    await waitForCdp();
    const result = await withTimeout(runSmoke(), 90_000, "browser smoke timed out");
    console.log(JSON.stringify(result, null, 2));
    console.log("browser smoke passed");
  } finally {
    await stopProcess(chrome);
    if (profileDir) await removePathWithRetry(profileDir);
    if (appServer) {
      await new Promise((resolveClose, rejectClose) => {
        appServer.close((error) => (error ? rejectClose(error) : resolveClose()));
      });
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
