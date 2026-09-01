import "./styles.css";

const IMAGE_BASE = "https://veil.ortlinde.com/v1/image";
const TAG_BATCH = 20_000;
const GALLERY_BATCH = 24;

type GalleryImage = { id: number; sort_order?: number; width?: number | null; height?: number | null };
type GallerySummary = { id: number; title: string; category?: string | null; image_count: number; cover?: { image_id?: number | null } | null; cover_image_id?: number | null };
type Gallery = GallerySummary & { tags: string[]; images: GalleryImage[]; images_pagination?: { total: number; offset: number; limit: number; has_next: boolean } };
type TagItem = { id: number; name: string; gallery_count?: number };
type CategoryItem = { name: string; gallery_count?: number };

class ApiError extends Error {
  constructor(public status: number, message: string, public retryAfterMs = 0) { super(message); }
}

const state = {
  galleries: [] as GallerySummary[], galleryTotal: 0, galleryOffset: 0,
  current: null as Gallery | null,
  tags: [] as TagItem[], tagTotal: 0, tagOffset: 0,
  categories: [] as CategoryItem[], featuredTags: [] as TagItem[],
  loading: false, loadingImages: false
};

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("App root missing");
app.innerHTML = `
<div class="app-shell">
  <div class="drawer-scrim" id="drawerScrim"></div>
  <aside class="sidebar" id="sidebar">
    <header class="sidebar-head"><div><strong>Veil 图集</strong><small>完整图集浏览器</small></div><button class="icon-button" id="closeSidebar">×</button></header>
    <section class="side-section"><h2>分类随机</h2><p class="hint">官方接口暂不支持分类列表筛选，点击后随机打开一个完整图集。</p><div class="category-list" id="categoryList"></div></section>
    <section class="side-section"><h2>标签随机</h2><p class="hint">数字是匹配图集数；点击会随机打开其中一个完整图集，不是只看 6 张预览。</p>
      <input id="tagSearch" class="search" type="search" placeholder="搜索已加载标签" autocomplete="off">
      <div class="featured-tags" id="featuredTags"></div><div class="tag-list" id="tagList"></div>
      <button class="secondary-button wide" id="loadTags">加载 20,000 个标签</button><div class="load-note" id="tagProgress">尚未加载标签目录</div>
    </section>
  </aside>
  <main class="main">
    <header class="topbar" id="topbar"><button class="icon-button" id="openSidebar">☰</button><div class="heading"><strong id="pageTitle">最新图集</strong><small id="pageMeta">正在连接 Veil</small></div><button class="accent-button" id="randomGallery">随机图集</button></header>
    <section class="catalog" id="catalog"><div class="gallery-grid" id="galleryGrid"></div><button class="secondary-button load-more" id="loadMore">加载更多图集</button></section>
    <section class="reader" id="reader" hidden>
      <div class="reader-head"><button class="icon-button" id="backToCatalog">←</button><div class="reader-title"><strong id="readerTitle"></strong><small id="readerMeta"></small></div><button class="icon-button" id="readerInfo">i</button></div>
      <div class="reader-info" id="readerInfoPanel" hidden></div><div class="image-stream" id="imageStream"></div>
      <div class="reader-loading" id="readerLoading" hidden>正在加载后续图片…</div><button class="secondary-button reader-more" id="readerMore" hidden>加载后续图片</button>
    </section>
  </main><div class="toast" id="toast" hidden></div>
</div>`;

function byId<T extends HTMLElement>(id: string) { const node = document.getElementById(id); if (!node) throw new Error(`Missing #${id}`); return node as T; }
const els = {
  sidebar: byId<HTMLElement>("sidebar"), drawerScrim: byId<HTMLElement>("drawerScrim"), openSidebar: byId<HTMLButtonElement>("openSidebar"), closeSidebar: byId<HTMLButtonElement>("closeSidebar"),
  categoryList: byId<HTMLElement>("categoryList"), featuredTags: byId<HTMLElement>("featuredTags"), tagList: byId<HTMLElement>("tagList"), tagSearch: byId<HTMLInputElement>("tagSearch"), loadTags: byId<HTMLButtonElement>("loadTags"), tagProgress: byId<HTMLElement>("tagProgress"),
  topbar: byId<HTMLElement>("topbar"), pageMeta: byId<HTMLElement>("pageMeta"), randomGallery: byId<HTMLButtonElement>("randomGallery"), catalog: byId<HTMLElement>("catalog"), galleryGrid: byId<HTMLElement>("galleryGrid"), loadMore: byId<HTMLButtonElement>("loadMore"),
  reader: byId<HTMLElement>("reader"), backToCatalog: byId<HTMLButtonElement>("backToCatalog"), readerTitle: byId<HTMLElement>("readerTitle"), readerMeta: byId<HTMLElement>("readerMeta"), readerInfo: byId<HTMLButtonElement>("readerInfo"), readerInfoPanel: byId<HTMLElement>("readerInfoPanel"), imageStream: byId<HTMLElement>("imageStream"), readerLoading: byId<HTMLElement>("readerLoading"), readerMore: byId<HTMLButtonElement>("readerMore"), toast: byId<HTMLElement>("toast")
};

function imageUrl(id: number) { return `${IMAGE_BASE}/${id}`; }
function escapeHtml(value: unknown) { return String(value ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] || c); }
function positive(value: unknown) { const n = Number(value); return Number.isSafeInteger(n) && n > 0 ? n : 0; }
async function requestJson<T>(path: string): Promise<T> { const response = await fetch(path, { headers: { accept: "application/json" }, cache: "no-store" }); const body = await response.json().catch(() => ({})); if (!response.ok) throw new ApiError(response.status, body.message || `HTTP ${response.status}`, Number(body.retryAfterMs) || 0); return body as T; }

let toastTimer = 0;
function toast(message: string, kind: "normal" | "warn" = "normal") { window.clearTimeout(toastTimer); els.toast.textContent = message; els.toast.dataset.kind = kind; els.toast.hidden = false; toastTimer = window.setTimeout(() => { els.toast.hidden = true; }, 3200); }
function explainError(error: unknown) { if (error instanceof ApiError && error.status === 404) return "没有找到匹配的完整图集"; if (error instanceof ApiError && error.status === 429) return "请求过快，请稍后再试"; if (error instanceof ApiError && error.status === 403) return "上游暂时拒绝访问"; return error instanceof Error ? error.message : "加载失败"; }
function setBusy(busy: boolean) { state.loading = busy; els.randomGallery.disabled = busy; els.loadMore.disabled = busy; els.loadTags.disabled = busy; }
function openDrawer() { els.sidebar.classList.add("open"); els.drawerScrim.classList.add("open"); }
function closeDrawer() { els.sidebar.classList.remove("open"); els.drawerScrim.classList.remove("open"); }

function sanitizeSummary(value: unknown): GallerySummary | null {
  if (!value || typeof value !== "object") return null; const item = value as Record<string, unknown>; const id = positive(item.id); if (!id) return null;
  const cover = item.cover && typeof item.cover === "object" ? item.cover as { image_id?: number | null } : null;
  return { id, title: typeof item.title === "string" && item.title ? item.title : `Gallery ${id}`, category: typeof item.category === "string" ? item.category : null, image_count: positive(item.image_count), cover, cover_image_id: positive(item.cover_image_id) || null };
}
function sanitizeGallery(value: unknown): Gallery | null {
  const summary = sanitizeSummary(value); if (!summary || !value || typeof value !== "object") return null; const item = value as Record<string, unknown>;
  const images: GalleryImage[] = [];
  if (Array.isArray(item.images)) {
    for (const raw of item.images) {
      if (!raw || typeof raw !== "object") continue;
      const record = raw as Record<string, unknown>;
      const id = positive(record.id);
      if (!id) continue;
      images.push({ id, sort_order: positive(record.sort_order), width: positive(record.width) || null, height: positive(record.height) || null });
    }
  }
  const pagination = item.images_pagination && typeof item.images_pagination === "object" ? item.images_pagination as Gallery["images_pagination"] : undefined;
  return { ...summary, tags: Array.isArray(item.tags) ? item.tags.filter((tag): tag is string => typeof tag === "string") : [], images, images_pagination: pagination };
}

async function loadGalleries(reset = false) {
  if (state.loading) return; setBusy(true);
  try { const offset = reset ? 0 : state.galleryOffset; const data = await requestJson<{ items?: unknown[]; total?: number }>(`/api/galleries?limit=${GALLERY_BATCH}&offset=${offset}`); const items = (data.items || []).map(sanitizeSummary).filter((item): item is GallerySummary => item !== null); state.galleries = reset ? items : [...state.galleries, ...items]; state.galleryOffset = offset + items.length; state.galleryTotal = positive(data.total); renderGalleryGrid(); }
  catch (error) { toast(explainError(error), "warn"); } finally { setBusy(false); }
}
function renderGalleryGrid() {
  els.galleryGrid.innerHTML = state.galleries.map(gallery => { const coverId = positive(gallery.cover?.image_id) || positive(gallery.cover_image_id); return `<button class="gallery-card" data-gallery-id="${gallery.id}"><span class="cover-wrap">${coverId ? `<img src="${imageUrl(coverId)}" alt="" loading="lazy" decoding="async">` : `<span class="cover-empty">暂无封面</span>`}</span><span class="card-copy"><strong>${escapeHtml(gallery.title)}</strong><small>${escapeHtml(gallery.category || "未分类")} · ${gallery.image_count || "?"} 张</small></span></button>`; }).join("");
  els.pageMeta.textContent = `已显示 ${state.galleries.length.toLocaleString()} / ${state.galleryTotal.toLocaleString()} 个图集`; els.loadMore.hidden = state.galleryTotal > 0 && state.galleries.length >= state.galleryTotal;
}

async function openGallery(id: number) {
  if (!id || state.loading) return; setBusy(true);
  try { const gallery = sanitizeGallery(await requestJson(`/api/gallery/${id}?image_limit=100&image_offset=0`)); if (!gallery?.images.length) throw new Error("图集没有可用图片"); state.current = gallery; renderReader(true); closeDrawer(); history.replaceState({ galleryId: id }, "", `#gallery-${id}`); }
  catch (error) { toast(explainError(error), "warn"); } finally { setBusy(false); }
}
async function openRandom(params = new URLSearchParams()) {
  if (state.loading) return; setBusy(true);
  try { const random = sanitizeGallery(await requestJson(`/api/gallery/random${params.size ? `?${params}` : ""}`)); if (!random) throw new Error("随机接口返回了无效图集"); setBusy(false); await openGallery(random.id); }
  catch (error) { toast(explainError(error), "warn"); setBusy(false); }
}
function renderReader(scrollTop = false) {
  const gallery = state.current; if (!gallery) return; els.topbar.hidden = true; els.catalog.hidden = true; els.reader.hidden = false; els.readerTitle.textContent = gallery.title; els.readerMeta.textContent = `${gallery.category || "未分类"} · ${gallery.image_count || gallery.images.length} 张`;
  els.readerInfoPanel.innerHTML = `<strong>${escapeHtml(gallery.title)}</strong><span>ID ${gallery.id} · 已加载 ${gallery.images.length}/${gallery.image_count || gallery.images.length} 张</span><div>${gallery.tags.map(tag => `<button data-tag="${escapeHtml(tag)}">${escapeHtml(tag)}</button>`).join("") || "暂无标签"}</div>`;
  els.imageStream.innerHTML = gallery.images.map((image, index) => `<figure class="reader-image"><img src="${imageUrl(image.id)}" alt="${escapeHtml(gallery.title)} 第 ${index + 1} 张" loading="lazy" decoding="async"><figcaption>${index + 1} / ${gallery.image_count || gallery.images.length}</figcaption></figure>`).join(""); updateReaderMore(); if (scrollTop) requestAnimationFrame(() => window.scrollTo(0, 0));
}
function updateReaderMore() { els.readerMore.hidden = !state.current?.images_pagination?.has_next; els.readerLoading.hidden = !state.loadingImages; }
async function loadMoreImages() {
  const gallery = state.current; const pagination = gallery?.images_pagination; if (!gallery || !pagination?.has_next || state.loadingImages) return; state.loadingImages = true; updateReaderMore();
  try { const next = sanitizeGallery(await requestJson(`/api/gallery/${gallery.id}?image_limit=100&image_offset=${gallery.images.length}`)); if (!next) throw new Error("后续图片数据无效"); const known = new Set(gallery.images.map(image => image.id)); gallery.images.push(...next.images.filter(image => !known.has(image.id))); gallery.images_pagination = next.images_pagination; renderReader(false); }
  catch (error) { toast(explainError(error), "warn"); } finally { state.loadingImages = false; updateReaderMore(); }
}
function showCatalog() { state.current = null; els.reader.hidden = true; els.topbar.hidden = false; els.catalog.hidden = false; els.readerInfoPanel.hidden = true; history.replaceState({}, "", location.pathname); window.scrollTo(0, 0); }

function renderCategories() { els.categoryList.innerHTML = state.categories.map(item => `<button class="side-row" data-category="${escapeHtml(item.name)}"><span>${escapeHtml(item.name)}</span><small>${item.gallery_count?.toLocaleString() || ""} 图集</small></button>`).join(""); }
function renderFeaturedTags() { els.featuredTags.innerHTML = state.featuredTags.map(tag => `<button data-tag="${escapeHtml(tag.name)}">${escapeHtml(tag.name)}</button>`).join(""); }
function renderTags() { const query = els.tagSearch.value.trim().toLocaleLowerCase(); const matches = state.tags.filter(tag => !query || tag.name.toLocaleLowerCase().includes(query)).slice(0, 80); els.tagList.innerHTML = matches.map(tag => `<button class="side-row" data-tag="${escapeHtml(tag.name)}"><span>${escapeHtml(tag.name)}</span><small>${tag.gallery_count?.toLocaleString() || ""} 图集</small></button>`).join(""); els.tagProgress.textContent = state.tagTotal ? `已加载 ${state.tags.length.toLocaleString()} / ${state.tagTotal.toLocaleString()} 个标签${matches.length === 80 ? " · 仅显示前 80 条匹配" : ""}` : "尚未加载标签目录"; els.loadTags.hidden = state.tagTotal > 0 && state.tagOffset >= state.tagTotal; }
async function loadTags() { if (state.loading) return; setBusy(true); try { const data = await requestJson<{ items?: TagItem[]; total?: number }>(`/api/tags?limit=${TAG_BATCH}&offset=${state.tagOffset}`); const seen = new Set(state.tags.map(tag => tag.id)); const items = (data.items || []).filter(tag => positive(tag.id) && typeof tag.name === "string" && !seen.has(tag.id)); state.tags.push(...items); state.tagOffset += items.length; state.tagTotal = positive(data.total) || state.tags.length; renderTags(); } catch (error) { toast(explainError(error), "warn"); } finally { setBusy(false); } }
async function loadNavigation() { const [categories, featured] = await Promise.allSettled([requestJson<{ items?: CategoryItem[] }>("/api/categories"), requestJson<{ items?: TagItem[] }>("/api/featured-tags")]); if (categories.status === "fulfilled") state.categories = categories.value.items || []; if (featured.status === "fulfilled") state.featuredTags = featured.value.items || []; renderCategories(); renderFeaturedTags(); }
function runTag(tag: string) { toast(`正在随机抽取“${tag}”的完整图集`); openRandom(new URLSearchParams({ tag })); }

els.openSidebar.addEventListener("click", openDrawer); els.closeSidebar.addEventListener("click", closeDrawer); els.drawerScrim.addEventListener("click", closeDrawer); els.loadMore.addEventListener("click", () => loadGalleries()); els.loadTags.addEventListener("click", loadTags); els.tagSearch.addEventListener("input", renderTags); els.randomGallery.addEventListener("click", () => openRandom()); els.backToCatalog.addEventListener("click", showCatalog); els.readerMore.addEventListener("click", loadMoreImages); els.readerInfo.addEventListener("click", () => { els.readerInfoPanel.hidden = !els.readerInfoPanel.hidden; });
els.galleryGrid.addEventListener("click", event => { const button = (event.target as HTMLElement).closest<HTMLElement>("[data-gallery-id]"); if (button) openGallery(positive(button.dataset.galleryId)); });
for (const container of [els.categoryList, els.featuredTags, els.tagList, els.readerInfoPanel]) container.addEventListener("click", event => { const target = (event.target as HTMLElement).closest<HTMLElement>("[data-tag],[data-category]"); if (target?.dataset.tag) runTag(target.dataset.tag); if (target?.dataset.category) openRandom(new URLSearchParams({ category: target.dataset.category })); });
window.addEventListener("popstate", () => { if (state.current) showCatalog(); });
Promise.all([loadGalleries(true), loadNavigation()]).catch(error => toast(explainError(error), "warn"));
if ("serviceWorker" in navigator && import.meta.env.PROD) window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => undefined));
