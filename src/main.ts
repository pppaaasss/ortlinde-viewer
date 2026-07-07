import "./styles.css";

const API_BASE = "";
const IMAGE_BASE = "https://veil.ortlinde.com/v1/image";
const STORAGE_KEYS = {
  session: "ortlinde.viewer.session.v1",
  favorites: "ortlinde.viewer.favorites.v1",
  history: "ortlinde.viewer.history.v1",
  tags: "ortlinde.viewer.tags.v1"
};

type GalleryImage = {
  id: number;
  sort_order?: number;
  width?: number | null;
  height?: number | null;
  url?: string;
};

type Gallery = {
  id: number;
  title: string;
  category?: string | null;
  content_class?: string | null;
  is_nsfw?: boolean;
  image_count?: number;
  tags?: string[];
  images: GalleryImage[];
};

type TagItem = {
  id: number;
  name: string;
  normalized_name?: string;
  gallery_count?: number;
};

type CategoryItem = {
  name: string;
  gallery_count?: number;
};

type FavoriteItem = {
  id: number;
  galleryId?: number;
  title?: string;
  width?: number | null;
  height?: number | null;
};

type StoredSession = {
  gallery: Gallery | null;
  index: number;
  selectedCategory: string;
};

class ApiError extends Error {
  status: number;
  retryAfterMs: number;

  constructor(status: number, message: string, retryAfterMs = 0) {
    super(message);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

const state = {
  gallery: null as Gallery | null,
  index: 0,
  selectedCategory: "",
  favorites: new Map<number, FavoriteItem>(),
  history: [] as Gallery[],
  tags: [] as TagItem[],
  tagTotal: 0,
  tagOffset: 0,
  tagLimit: 200,
  tagsLoaded: false,
  tagQuery: "",
  categories: [] as CategoryItem[],
  featuredTags: [] as TagItem[],
  loading: false,
  cooldownUntil: 0,
  blocked: false,
  drawerOpen: false,
  infoOpen: false
};
const failedImageIds = new Set<number>();
let toastTimer = 0;

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("App root missing");

app.innerHTML = `
  <div class="app-shell">
    <aside class="sidebar" id="sidebar" aria-label="控制栏">
      <div class="brand-row">
        <div>
          <div class="brand-name">Ortlinde</div>
          <div class="brand-subtitle">Gallery Viewer</div>
        </div>
        <button class="icon-btn sidebar-close" id="closeSidebar" type="button" aria-label="关闭菜单" aria-controls="sidebar" title="关闭菜单">×</button>
      </div>

      <section class="control-group">
        <div class="control-title">浏览</div>
        <button class="primary-btn" id="randomBtn" type="button">随机图集</button>
        <div class="segmented" id="categoryChips" aria-label="分类"></div>
      </section>

      <section class="control-group">
        <div class="control-title">标签</div>
        <input class="search-input" id="tagSearch" type="search" placeholder="搜索已加载标签" autocomplete="off" />
        <div class="chip-list" id="featuredTags"></div>
        <div class="tag-results" id="tagResults"></div>
        <button class="ghost-btn" id="loadTagsBtn" type="button">加载标签</button>
      </section>

      <section class="control-group">
        <div class="control-title">历史</div>
        <div class="compact-list" id="historyList"></div>
      </section>

      <section class="control-group">
        <div class="control-title">收藏</div>
        <div class="compact-list" id="favoriteList"></div>
      </section>
    </aside>

    <main class="viewer">
      <header class="topbar">
        <button class="icon-btn mobile-menu" id="openSidebar" type="button" aria-label="打开菜单" aria-controls="sidebar" title="打开菜单">☰</button>
        <div class="gallery-heading">
          <div class="gallery-title" id="galleryTitle">未加载图集</div>
          <div class="gallery-meta" id="galleryMeta">选择一个入口开始</div>
        </div>
        <div class="status-pill" id="statusPill">就绪</div>
      </header>

      <section class="image-stage" id="imageStage" aria-live="polite">
        <div class="empty-state" id="emptyState">
          <button class="primary-btn large" id="startBtn" type="button">加载图集</button>
        </div>
        <img class="main-image" id="mainImage" alt="" decoding="async" />
        <div class="image-loader" id="imageLoader" hidden>加载中</div>
        <div class="toast" id="toast" hidden></div>
      </section>

      <section class="info-sheet" id="infoSheet">
        <div class="sheet-grip"></div>
        <div class="info-title" id="infoTitle">图集信息</div>
        <div class="info-meta" id="infoMeta"></div>
        <div class="chip-list" id="infoTags"></div>
      </section>

      <nav class="bottom-bar" aria-label="图片操作">
        <button class="tool-btn" id="prevBtn" type="button" aria-label="上一张" title="上一张">‹</button>
        <button class="tool-btn" id="nextBtn" type="button" aria-label="下一张" title="下一张">›</button>
        <button class="tool-btn" id="favoriteBtn" type="button" aria-label="收藏" title="收藏">☆</button>
        <button class="tool-btn" id="infoBtn" type="button" aria-label="图集信息" aria-controls="infoSheet" title="图集信息">i</button>
        <a class="tool-btn link-tool" id="openImageLink" aria-label="打开图片" title="打开图片" target="_blank" rel="noreferrer">↗</a>
      </nav>
    </main>
  </div>
`;

const els = {
  sidebar: byId<HTMLDivElement>("sidebar"),
  openSidebar: byId<HTMLButtonElement>("openSidebar"),
  closeSidebar: byId<HTMLButtonElement>("closeSidebar"),
  randomBtn: byId<HTMLButtonElement>("randomBtn"),
  startBtn: byId<HTMLButtonElement>("startBtn"),
  prevBtn: byId<HTMLButtonElement>("prevBtn"),
  nextBtn: byId<HTMLButtonElement>("nextBtn"),
  favoriteBtn: byId<HTMLButtonElement>("favoriteBtn"),
  infoBtn: byId<HTMLButtonElement>("infoBtn"),
  openImageLink: byId<HTMLAnchorElement>("openImageLink"),
  galleryTitle: byId<HTMLDivElement>("galleryTitle"),
  galleryMeta: byId<HTMLDivElement>("galleryMeta"),
  statusPill: byId<HTMLDivElement>("statusPill"),
  imageStage: byId<HTMLElement>("imageStage"),
  mainImage: byId<HTMLImageElement>("mainImage"),
  emptyState: byId<HTMLDivElement>("emptyState"),
  imageLoader: byId<HTMLDivElement>("imageLoader"),
  toast: byId<HTMLDivElement>("toast"),
  categoryChips: byId<HTMLDivElement>("categoryChips"),
  featuredTags: byId<HTMLDivElement>("featuredTags"),
  tagSearch: byId<HTMLInputElement>("tagSearch"),
  tagResults: byId<HTMLDivElement>("tagResults"),
  loadTagsBtn: byId<HTMLButtonElement>("loadTagsBtn"),
  historyList: byId<HTMLDivElement>("historyList"),
  favoriteList: byId<HTMLDivElement>("favoriteList"),
  infoSheet: byId<HTMLDivElement>("infoSheet"),
  infoTitle: byId<HTMLDivElement>("infoTitle"),
  infoMeta: byId<HTMLDivElement>("infoMeta"),
  infoTags: byId<HTMLDivElement>("infoTags")
};

function byId<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
}

function imageUrl(id: number) {
  return `${IMAGE_BASE}/${id}`;
}

function safeJsonParse<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function safeGetItem(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isPositiveInteger(value: number) {
  return Number.isSafeInteger(value) && value > 0;
}

function optionalPositiveNumber(value: unknown): number | null {
  const number = optionalNumber(value);
  return number && number > 0 ? number : null;
}

function clampIndex(value: unknown, length: number) {
  if (length <= 0) return 0;
  const index = Math.trunc(asNumber(value, 0));
  return Math.min(Math.max(index, 0), length - 1);
}

function safeSetItem(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    showToast("本地存储不可写，当前会话不会持久保存。", "warn");
  }
}

function sanitizeImage(value: unknown): GalleryImage | null {
  const record = asRecord(value);
  if (!record) return null;
  const id = asNumber(record.id, Number.NaN);
  if (!isPositiveInteger(id)) return null;
  return {
    id,
    sort_order: optionalNumber(record.sort_order) ?? undefined,
    width: optionalPositiveNumber(record.width),
    height: optionalPositiveNumber(record.height),
    url: asString(record.url) || undefined
  };
}

function sanitizeGallery(value: unknown): Gallery | null {
  const record = asRecord(value);
  if (!record) return null;
  const id = asNumber(record.id, Number.NaN);
  const rawImages = Array.isArray(record.images) ? record.images : [];
  const images = rawImages.map(sanitizeImage).filter((image): image is GalleryImage => image !== null);
  if (!Number.isFinite(id) || images.length === 0) return null;
  const rawTags = Array.isArray(record.tags) ? record.tags : [];
  return {
    id,
    title: asString(record.title, `Gallery ${id}`),
    category: asString(record.category) || null,
    content_class: asString(record.content_class) || null,
    is_nsfw: typeof record.is_nsfw === "boolean" ? record.is_nsfw : undefined,
    image_count: asNumber(record.image_count, images.length),
    tags: rawTags.filter((tag): tag is string => typeof tag === "string"),
    images
  };
}

function isPreviewGallery(gallery: Gallery | null) {
  if (!gallery) return false;
  return gallery.category === "Tag Preview" || gallery.category === "标签预览" || gallery.title.startsWith("标签预览");
}

function sanitizeFavorite(value: unknown): FavoriteItem | null {
  const record = asRecord(value);
  if (!record) return null;
  const id = asNumber(record.id, Number.NaN);
  if (!isPositiveInteger(id)) return null;
  return {
    id,
    galleryId: optionalNumber(record.galleryId) ?? undefined,
    title: asString(record.title) || undefined,
    width: optionalPositiveNumber(record.width),
    height: optionalPositiveNumber(record.height)
  };
}

function sanitizeTag(value: unknown): TagItem | null {
  const record = asRecord(value);
  if (!record) return null;
  const id = asNumber(record.id, Number.NaN);
  const name = asString(record.name);
  if (!Number.isFinite(id) || !name) return null;
  return {
    id,
    name,
    normalized_name: asString(record.normalized_name) || undefined,
    gallery_count: optionalNumber(record.gallery_count) ?? undefined
  };
}

function sanitizeCategory(value: unknown): CategoryItem | null {
  const record = asRecord(value);
  if (!record) return null;
  const name = asString(record.name);
  if (!name) return null;
  return {
    name,
    gallery_count: optionalNumber(record.gallery_count) ?? undefined
  };
}

function loadLocalState() {
  const session = safeJsonParse<unknown>(safeGetItem(STORAGE_KEYS.session), null);
  const favorites = safeJsonParse<unknown>(safeGetItem(STORAGE_KEYS.favorites), []);
  const history = safeJsonParse<unknown>(safeGetItem(STORAGE_KEYS.history), []);
  const tagCache = safeJsonParse<unknown>(
    safeGetItem(STORAGE_KEYS.tags),
    null
  );
  const sessionRecord = asRecord(session);
  const gallery = sanitizeGallery(sessionRecord?.gallery);

  state.gallery = isPreviewGallery(gallery) ? null : gallery;
  state.index = state.gallery ? clampIndex(sessionRecord?.index, state.gallery.images.length) : 0;
  state.selectedCategory = asString(sessionRecord?.selectedCategory);
  state.history = Array.isArray(history)
    ? history.map(sanitizeGallery).filter((item): item is Gallery => item !== null && !isPreviewGallery(item)).slice(0, 12)
    : [];
  if (Array.isArray(favorites)) {
    favorites
      .map(sanitizeFavorite)
      .filter((item): item is FavoriteItem => item !== null)
      .forEach((item) => state.favorites.set(item.id, item));
  }

  const tagRecord = asRecord(tagCache);
  const tagItems = Array.isArray(tagRecord?.items)
    ? tagRecord.items.map(sanitizeTag).filter((item): item is TagItem => item !== null)
    : [];
  if (tagItems.length) {
    state.tags = tagItems;
    state.tagTotal = asNumber(tagRecord?.total, tagItems.length);
    state.tagOffset = Math.min(asNumber(tagRecord?.offset, tagItems.length), tagItems.length);
    state.tagsLoaded = true;
  }
}

function persistSession() {
  const session: StoredSession = {
    gallery: isPreviewGallery(state.gallery) ? null : state.gallery,
    index: state.index,
    selectedCategory: state.selectedCategory
  };
  safeSetItem(STORAGE_KEYS.session, session);
}

function persistLists() {
  safeSetItem(STORAGE_KEYS.history, state.history.slice(0, 12));
  safeSetItem(STORAGE_KEYS.favorites, [...state.favorites.values()].slice(0, 100));
}

function persistTags() {
  const storedItems = state.tags.slice(0, 1200);
  safeSetItem(
    STORAGE_KEYS.tags,
    {
      items: storedItems,
      total: state.tagTotal,
      offset: Math.min(state.tagOffset, storedItems.length)
    }
  );
}

async function requestJson<T>(path: string): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { accept: "application/json" },
    cache: "no-store"
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const retryAfterMs = parseRetryAfterMs(payload.retryAfterMs, response.headers.get("retry-after"));
    throw new ApiError(response.status, payload.message || `HTTP ${response.status}`, retryAfterMs);
  }
  return payload as T;
}

function parseRetryAfterMs(bodyValue: unknown, headerValue: string | null) {
  const bodyMs = Number(bodyValue);
  if (Number.isFinite(bodyMs) && bodyMs > 0) return bodyMs;
  if (!headerValue) return 0;

  const seconds = Number(headerValue);
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;

  const dateMs = Date.parse(headerValue);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : 0;
}

function setStatus(text: string, kind: "ready" | "busy" | "warn" | "error" = "ready") {
  els.statusPill.textContent = text;
  els.statusPill.dataset.kind = kind;
}

function setReadyStatusIfIdle(force = false) {
  if (state.loading || state.blocked || Date.now() < state.cooldownUntil) return;
  const currentKind = els.statusPill.dataset.kind;
  if (!force && (currentKind === "warn" || currentKind === "error")) return;
  setStatus("就绪", "ready");
}

function showToast(text: string, kind: "warn" | "error" | "ready" = "ready") {
  window.clearTimeout(toastTimer);
  els.toast.textContent = text;
  els.toast.dataset.kind = kind;
  els.toast.hidden = false;
  toastTimer = window.setTimeout(() => {
    els.toast.hidden = true;
  }, 2800);
}

function describeError(error: unknown) {
  if (error instanceof ApiError) {
    if (error.status === 429) return "请求冷却中";
    if (error.status === 403) return "上游已封禁";
    if (error.status === 404) return "没有可用内容";
    if (error.status === 503) return "接口已关闭";
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

function applyRequestError(error: unknown) {
  const text = describeError(error);
  if (error instanceof ApiError) {
    if (error.status === 403) {
      state.blocked = true;
      setControlsDisabled(true);
      setStatus("403 封禁", "error");
      showToast("上游返回 403，已停止自动请求。", "error");
      return;
    }
    if (error.status === 429) {
      const delay = Math.max(error.retryAfterMs || 30_000, 10_000);
      state.cooldownUntil = Date.now() + delay;
      startCooldownCountdown();
      showToast("请求过快，已进入冷却。", "warn");
      return;
    }
  }
  setStatus(text, "error");
  showToast(text, "error");
}

let cooldownTimer = 0;
function startCooldownCountdown() {
  window.clearInterval(cooldownTimer);
  const tick = () => {
    const left = Math.max(0, state.cooldownUntil - Date.now());
    if (left <= 0) {
      window.clearInterval(cooldownTimer);
      setControlsDisabled(false);
      setReadyStatusIfIdle(true);
      return;
    }
    setControlsDisabled(true);
    setStatus(`冷却 ${Math.ceil(left / 1000)}s`, "warn");
  };
  tick();
  cooldownTimer = window.setInterval(tick, 1000);
}

function setControlsDisabled(disabled: boolean) {
  const blocked = state.blocked || disabled || Date.now() < state.cooldownUntil;
  els.randomBtn.disabled = blocked || state.loading;
  els.startBtn.disabled = blocked || state.loading;
  els.loadTagsBtn.disabled = blocked || state.loading || !hasMoreTags();
  setContainerButtonsDisabled(els.categoryChips, blocked || state.loading);
  setContainerButtonsDisabled(els.featuredTags, blocked || state.loading);
  setContainerButtonsDisabled(els.tagResults, blocked || state.loading);
  setContainerButtonsDisabled(els.infoTags, blocked || state.loading);
}

function setContainerButtonsDisabled(container: HTMLElement, disabled: boolean) {
  container.querySelectorAll<HTMLButtonElement>("button").forEach((button) => {
    button.disabled = disabled;
  });
}

function hasMoreTags() {
  return state.tagOffset < state.tagTotal || !state.tagsLoaded;
}

function normalizeGallery(gallery: unknown): Gallery {
  return sanitizeGallery(gallery) || {
    id: 0,
    title: "无效图集",
    images: []
  };
}

async function loadRandomGallery(category = state.selectedCategory) {
  if (state.loading || state.blocked || Date.now() < state.cooldownUntil) return;
  state.loading = true;
  setControlsDisabled(true);
  setStatus("请求中", "busy");

  try {
    const params = new URLSearchParams();
    if (category) params.set("category", category);
    const gallery = normalizeGallery(await requestJson<unknown>(`/api/gallery/random${params.size ? `?${params}` : ""}`));
    if (!gallery.images.length) throw new ApiError(404, "图集没有可用图片");
    setGallery(gallery, 0, true);
    setStatus("就绪", "ready");
  } catch (error) {
    applyRequestError(error);
  } finally {
    state.loading = false;
    setControlsDisabled(false);
  }
}

async function loadTaggedGallery(tagName: string) {
  if (state.loading || state.blocked || Date.now() < state.cooldownUntil) return;
  state.loading = true;
  setControlsDisabled(true);
  setStatus("标签中", "busy");

  try {
    const gallery = normalizeGallery(await requestJson<unknown>(`/api/gallery/random?tag=${encodeURIComponent(tagName)}`));
    if (!gallery.images.length) throw new ApiError(404, "该标签暂无可用图集");
    rememberTag(tagName);
    setGallery(gallery, 0, true);
    setStatus("就绪", "ready");
    closeDrawer();
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      try {
        await loadTagPreviewFallback(tagName);
      } catch (fallbackError) {
        applyRequestError(fallbackError);
      }
    } else {
      applyRequestError(error);
    }
  } finally {
    state.loading = false;
    setControlsDisabled(false);
  }
}

async function loadTagPreviewFallback(tagName: string) {
  const data = await requestJson<{ image_ids?: number[] }>(`/api/tag/${encodeURIComponent(tagName)}/preview`);
  const ids = [...new Set((data.image_ids || []).filter(isPositiveInteger))];
  if (!ids.length) throw new ApiError(404, "该标签暂无预览图片");
  const gallery: Gallery = {
    id: -Date.now(),
    title: `标签预览（仅 6 张）：${tagName}`,
    category: "标签预览",
    tags: [tagName],
    image_count: ids.length,
    images: ids.map((id, index) => ({ id, sort_order: index + 1 }))
  };
  rememberTag(tagName);
  setGallery(gallery, 0, false);
  setStatus("就绪", "ready");
  showToast("该标签随机图集暂不可用，已显示 6 张预览样本。", "warn");
  closeDrawer();
}

function setGallery(gallery: Gallery, index = 0, remember = false) {
  state.gallery = normalizeGallery(gallery);
  state.index = clampIndex(index, state.gallery.images.length);
  failedImageIds.clear();

  if (remember) {
    state.history = [state.gallery, ...state.history.filter((item) => item.id !== state.gallery?.id)].slice(0, 12);
  }

  persistSession();
  persistLists();
  renderAll();
}

function currentImage() {
  return state.gallery?.images[state.index] || null;
}

function findAvailableImageIndex(fromIndex: number, direction: -1 | 1) {
  const gallery = state.gallery;
  if (!gallery?.images.length) return -1;

  for (let index = fromIndex + direction; index >= 0 && index < gallery.images.length; index += direction) {
    if (!failedImageIds.has(gallery.images[index].id)) return index;
  }

  return -1;
}

function moveImage(delta: number) {
  if (!state.gallery?.images.length) return;
  const direction = delta < 0 ? -1 : 1;
  const next = findAvailableImageIndex(state.index, direction);
  if (next < 0) return;
  state.index = next;
  persistSession();
  renderViewer();
}

function showImageFailureState() {
  setInfoOpen(false);
  els.imageLoader.hidden = true;
  els.mainImage.removeAttribute("src");
  els.mainImage.classList.remove("loaded");
  els.emptyState.hidden = false;
  setImageLink(null);
  els.prevBtn.disabled = true;
  els.nextBtn.disabled = true;
  els.infoBtn.disabled = true;
  renderFavoriteButton(null);
  setStatus("图片加载失败", "error");
}

function handleImageError() {
  if (!els.mainImage.getAttribute("src")) return;

  const image = currentImage();
  if (image) failedImageIds.add(image.id);

  const next = findAvailableImageIndex(state.index, 1);
  const previous = findAvailableImageIndex(state.index, -1);
  const fallbackIndex = next >= 0 ? next : previous;

  if (fallbackIndex >= 0) {
    els.imageLoader.hidden = true;
    showToast("图片加载失败，已跳过。", "warn");
    state.index = fallbackIndex;
    persistSession();
    renderViewer();
    return;
  }

  showToast("当前图集图片均加载失败。", "warn");
  showImageFailureState();
}

function toggleFavorite() {
  const image = currentImage();
  if (!image) return;
  if (state.favorites.has(image.id)) {
    state.favorites.delete(image.id);
  } else {
    state.favorites.set(image.id, {
      id: image.id,
      galleryId: state.gallery?.id,
      title: state.gallery?.title,
      width: image.width,
      height: image.height
    });
  }
  persistLists();
  renderFavorites();
  renderFavoriteButton(image);
}

function renderFavoriteButton(image = currentImage()) {
  const active = image ? state.favorites.has(image.id) : false;
  els.favoriteBtn.disabled = !image;
  els.favoriteBtn.textContent = active ? "★" : "☆";
  els.favoriteBtn.setAttribute("aria-pressed", active ? "true" : "false");
  els.favoriteBtn.classList.toggle("active", active);
}

function renderAll() {
  renderDrawerState();
  setInfoOpen(state.infoOpen);
  renderCategories();
  renderFeaturedTags();
  renderTagResults();
  renderHistory();
  renderFavorites();
  renderViewer();
}

function renderViewer() {
  const gallery = state.gallery;
  const image = currentImage();

  if (!gallery || !image) {
    setInfoOpen(false);
    els.emptyState.hidden = false;
    els.imageLoader.hidden = true;
    els.mainImage.removeAttribute("src");
    els.mainImage.classList.remove("loaded");
    els.galleryTitle.textContent = "未加载图集";
    els.galleryMeta.textContent = "选择一个入口开始";
    els.infoTitle.textContent = "图集信息";
    els.infoMeta.textContent = "";
    els.infoTags.innerHTML = "";
    els.prevBtn.disabled = true;
    els.nextBtn.disabled = true;
    renderFavoriteButton(null);
    els.infoBtn.disabled = true;
    setImageLink(null);
    return;
  }

  const src = imageUrl(image.id);
  const sameSrc = els.mainImage.src === src;
  const alreadyLoaded =
    sameSrc && (els.mainImage.classList.contains("loaded") || (els.mainImage.complete && els.mainImage.naturalWidth > 0));
  els.emptyState.hidden = true;
  els.imageLoader.hidden = alreadyLoaded;
  els.mainImage.classList.toggle("loaded", alreadyLoaded);
  if (!sameSrc) els.mainImage.src = src;
  els.mainImage.alt = gallery.title;
  setImageLink(src);

  const total = gallery.images.length;
  const isPreview = isPreviewGallery(gallery);
  const category = isPreview ? "标签预览" : gallery.category || "未分类";
  const dims = image.width && image.height ? ` · ${image.width}×${image.height}` : "";
  els.galleryTitle.textContent = gallery.title;
  els.galleryMeta.textContent = isPreview
    ? `${category} · ${state.index + 1}/${total} · 仅 6 张样本${dims}`
    : `${category} · ${state.index + 1}/${total}${dims}`;
  els.infoTitle.textContent = gallery.title;
  els.infoMeta.textContent = isPreview
    ? `${category} · 预览 ${total} 张，不代表标签全部结果 · ID ${image.id}`
    : `${category} · ${gallery.image_count || total} 张 · ID ${image.id}`;
  const requestDisabled = requestsPaused() ? " disabled" : "";
  els.infoTags.innerHTML = (gallery.tags || [])
    .slice(0, 18)
    .map((tag) => `<button class="chip" type="button" data-tag="${escapeAttr(tag)}"${requestDisabled}>${escapeHtml(tag)}</button>`)
    .join("");

  els.prevBtn.disabled = findAvailableImageIndex(state.index, -1) < 0;
  els.nextBtn.disabled = findAvailableImageIndex(state.index, 1) < 0;
  els.infoBtn.disabled = false;
  renderFavoriteButton(image);
  settleLoadedImage(src);

  const next = gallery.images[state.index + 1];
  if (next) {
    const preload = new Image();
    preload.src = imageUrl(next.id);
  }
}

function settleLoadedImage(src: string) {
  if (!els.mainImage.complete || !els.mainImage.naturalWidth || els.mainImage.currentSrc !== src) return;
  els.imageLoader.hidden = true;
  els.mainImage.classList.add("loaded");
}

function setImageLink(src: string | null) {
  if (src) {
    els.openImageLink.href = src;
    els.openImageLink.setAttribute("aria-disabled", "false");
    els.openImageLink.tabIndex = 0;
    return;
  }

  els.openImageLink.removeAttribute("href");
  els.openImageLink.setAttribute("aria-disabled", "true");
  els.openImageLink.tabIndex = -1;
}

function renderCategories() {
  const chips = [{ name: "", gallery_count: 0 }, ...state.categories];
  const disabled = requestsPaused() ? " disabled" : "";
  els.categoryChips.innerHTML = chips
    .map((category) => {
      const label = category.name || "全部";
      const active = category.name === state.selectedCategory ? " active" : "";
      return `<button class="segment${active}" type="button" data-category="${escapeAttr(category.name)}"${disabled}>${escapeHtml(label)}</button>`;
    })
    .join("");
}

function renderFeaturedTags() {
  const recentTags = getRecentTags();
  const seen = new Set<string>();
  const tags = [...recentTags.map((name) => ({ id: -name.length, name })), ...state.featuredTags]
    .filter((tag) => {
      const key = tag.name.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 18);
  const disabled = requestsPaused() ? " disabled" : "";
  els.featuredTags.innerHTML = tags
    .map((tag) => `<button class="chip" type="button" data-tag="${escapeAttr(tag.name)}"${disabled}>${escapeHtml(tag.name)}</button>`)
    .join("");
}

function renderTagResults() {
  const query = state.tagQuery.trim().toLowerCase();
  const source = query
    ? state.tags.filter((tag) => `${tag.name} ${tag.normalized_name || ""}`.toLowerCase().includes(query))
    : state.tags.slice(0, 20);

  els.tagResults.innerHTML = source
    .slice(0, 80)
    .map((tag) => {
      const count = tag.gallery_count ? `<span class="tag-count">${tag.gallery_count} 图集</span>` : "";
      const disabled = requestsPaused() ? " disabled" : "";
      return `<button class="tag-row" type="button" data-tag="${escapeAttr(tag.name)}"${disabled}><span>${escapeHtml(tag.name)}</span>${count}</button>`;
    })
    .join("");

  const hasMore = hasMoreTags();
  els.loadTagsBtn.textContent = hasMore ? `加载标签 ${state.tags.length}/${state.tagTotal || "?"}` : "标签已加载";
  els.loadTagsBtn.disabled = !hasMore || state.blocked || state.loading;
}

function requestsPaused() {
  return state.blocked || state.loading || Date.now() < state.cooldownUntil;
}

function renderHistory() {
  els.historyList.innerHTML =
    state.history
      .slice(0, 10)
      .map(
        (gallery) =>
          `<button class="list-row" type="button" data-gallery-id="${gallery.id}"><span>${escapeHtml(gallery.title)}</span><small>${escapeHtml(gallery.category || "")}</small></button>`
      )
      .join("") || `<div class="muted-row">暂无历史</div>`;
}

function renderFavorites() {
  els.favoriteList.innerHTML =
    [...state.favorites.values()]
      .slice(-20)
      .reverse()
      .map(
        (item) =>
          `<button class="list-row" type="button" data-image-id="${item.id}"><span>#${item.id}</span><small>${escapeHtml(item.title || "单张图片")}</small></button>`
      )
      .join("") || `<div class="muted-row">暂无收藏</div>`;
}

async function loadMetadata() {
  try {
    const [categories, featured] = await Promise.all([
      requestJson<unknown>("/api/categories"),
      requestJson<unknown>("/api/featured-tags")
    ]);
    const categoryItems = asRecord(categories)?.items;
    const featuredItems = asRecord(featured)?.items;
    state.categories = Array.isArray(categoryItems)
      ? categoryItems.map(sanitizeCategory).filter((item): item is CategoryItem => item !== null)
      : [];
    state.featuredTags = Array.isArray(featuredItems)
      ? featuredItems.map(sanitizeTag).filter((item): item is TagItem => item !== null)
      : [];
    renderCategories();
    renderFeaturedTags();
  } catch (error) {
    applyRequestError(error);
  }
}

async function loadMoreTags() {
  if (state.loading || state.blocked || Date.now() < state.cooldownUntil || !hasMoreTags()) return;
  state.loading = true;
  setControlsDisabled(true);
  try {
    const data = await requestJson<unknown>(
      `/api/tags?limit=${state.tagLimit}&offset=${state.tagOffset}`
    );
    const dataRecord = asRecord(data);
    if (!dataRecord || ("items" in dataRecord && !Array.isArray(dataRecord.items))) {
      throw new ApiError(502, "标签列表格式异常");
    }
    const rawItems = Array.isArray(dataRecord?.items) ? dataRecord.items : [];
    const items = rawItems
      .map(sanitizeTag)
      .filter((item): item is TagItem => item !== null);
    const existing = new Set(state.tags.map((tag) => tag.id));
    for (const tag of items) {
      if (existing.has(tag.id)) continue;
      state.tags.push(tag);
      existing.add(tag.id);
    }
    state.tagTotal = asNumber(dataRecord?.total, state.tagTotal);
    state.tagOffset = asNumber(dataRecord?.offset, state.tagOffset) + (rawItems.length || asNumber(dataRecord?.limit, state.tagLimit));
    state.tagsLoaded = true;
    persistTags();
    renderTagResults();
  } catch (error) {
    applyRequestError(error);
  } finally {
    state.loading = false;
    setControlsDisabled(false);
  }
}

function rememberTag(tagName: string) {
  const tags = [tagName, ...getRecentTags().filter((tag) => tag !== tagName)].slice(0, 8);
  safeSetItem("ortlinde.viewer.recent-tags.v1", tags);
  renderFeaturedTags();
}

function getRecentTags() {
  const tags = safeJsonParse<unknown>(safeGetItem("ortlinde.viewer.recent-tags.v1"), []);
  return Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === "string") : [];
}

function openDrawer() {
  state.drawerOpen = true;
  renderDrawerState();
}

function closeDrawer() {
  state.drawerOpen = false;
  renderDrawerState();
}

function toggleInfoSheet() {
  setInfoOpen(!state.infoOpen);
}

function setInfoOpen(open: boolean) {
  state.infoOpen = open;
  els.infoSheet.classList.toggle("open", state.infoOpen);
  els.infoBtn.setAttribute("aria-expanded", state.infoOpen ? "true" : "false");
}

function renderDrawerState() {
  els.sidebar.classList.toggle("open", state.drawerOpen);
  els.openSidebar.setAttribute("aria-expanded", state.drawerOpen ? "true" : "false");
  els.closeSidebar.setAttribute("aria-expanded", state.drawerOpen ? "true" : "false");
}

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(value: unknown) {
  return escapeHtml(value).replace(/'/g, "&#39;");
}

function isTypingTarget(target: EventTarget | null) {
  const element = target instanceof HTMLElement ? target : null;
  if (!element) return false;
  return element.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName);
}

function bindEvents() {
  els.randomBtn.addEventListener("click", () => loadRandomGallery());
  els.startBtn.addEventListener("click", () => loadRandomGallery());
  els.prevBtn.addEventListener("click", () => moveImage(-1));
  els.nextBtn.addEventListener("click", () => moveImage(1));
  els.favoriteBtn.addEventListener("click", toggleFavorite);
  els.infoBtn.addEventListener("click", toggleInfoSheet);
  els.openSidebar.addEventListener("click", openDrawer);
  els.closeSidebar.addEventListener("click", closeDrawer);
  els.loadTagsBtn.addEventListener("click", loadMoreTags);

  els.categoryChips.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-category]");
    if (!button || button.disabled || requestsPaused()) return;
    state.selectedCategory = button.dataset.category || "";
    persistSession();
    renderCategories();
    loadRandomGallery();
  });

  els.featuredTags.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-tag]");
    if (button?.dataset.tag && !button.disabled && !requestsPaused()) loadTaggedGallery(button.dataset.tag);
  });

  els.infoTags.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-tag]");
    if (button?.dataset.tag && !button.disabled && !requestsPaused()) loadTaggedGallery(button.dataset.tag);
  });

  els.tagResults.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-tag]");
    if (button?.dataset.tag && !button.disabled && !requestsPaused()) loadTaggedGallery(button.dataset.tag);
  });

  els.historyList.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-gallery-id]");
    const id = Number(button?.dataset.galleryId);
    const gallery = state.history.find((item) => item.id === id);
    if (gallery) {
      setGallery(gallery, 0, false);
      closeDrawer();
    }
  });

  els.favoriteList.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-image-id]");
    const id = Number(button?.dataset.imageId);
    if (!id) return;
    const fav = state.favorites.get(id);
    const gallery: Gallery = {
      id: -id,
      title: fav?.title || `图片 #${id}`,
      category: "Favorite",
      images: [{ id, width: fav?.width, height: fav?.height }],
      image_count: 1
    };
    setGallery(gallery, 0, false);
    closeDrawer();
  });

  let searchTimer = 0;
  els.tagSearch.addEventListener("focus", () => {
    if (!state.tagsLoaded) loadMoreTags();
  });
  els.tagSearch.addEventListener("input", () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      state.tagQuery = els.tagSearch.value;
      renderTagResults();
    }, 120);
  });

  els.mainImage.addEventListener("load", () => {
    els.imageLoader.hidden = true;
    els.mainImage.classList.add("loaded");
    const image = currentImage();
    if (image) failedImageIds.delete(image.id);
    setReadyStatusIfIdle();
  });
  els.mainImage.addEventListener("error", handleImageError);

  document.addEventListener("keydown", (event) => {
    if (isTypingTarget(event.target)) return;
    if (event.key === "ArrowLeft") moveImage(-1);
    if (event.key === "ArrowRight") moveImage(1);
    if (event.key === "Escape") {
      closeDrawer();
      setInfoOpen(false);
    }
  });

  let startX = 0;
  let startY = 0;
  els.imageStage.addEventListener("pointerdown", (event) => {
    startX = event.clientX;
    startY = event.clientY;
  });
  els.imageStage.addEventListener("pointerup", (event) => {
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;
    if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy)) moveImage(dx < 0 ? 1 : -1);
    if (dy < -64 && Math.abs(dy) > Math.abs(dx)) {
      setInfoOpen(true);
    }
  });
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  if (import.meta.env.DEV) {
    navigator.serviceWorker.getRegistrations().then((registrations) => {
      registrations.forEach((registration) => registration.unregister());
    }).catch(() => undefined);
    caches.keys().then((keys) => {
      keys.filter((key) => key.startsWith("ortlinde-viewer-")).forEach((key) => caches.delete(key));
    }).catch(() => undefined);
    return;
  }
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  });
}

loadLocalState();
bindEvents();
renderAll();
loadMetadata();
registerServiceWorker();
