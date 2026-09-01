# Ortlinde Viewer

移动端优先的 Ortlinde 图集查看器。前端使用 Vite + 原生 TypeScript/CSS，后端是一个小型 Node 代理和静态文件服务。

## 功能

- 最新图集封面墙，支持分页加载。
- 点击封面进入完整图集，纵向连续阅读，图片原生懒加载。
- 超过 100 张的图集可继续分页加载后续图片。
- 标签与分类点击后随机打开一个匹配的完整图集；不再把 6 张标签预览伪装成图集结果。
- 标签目录每批最多加载 20,000 条，搜索结果只渲染前 80 条，避免手机卡顿。
- 桌面固定侧栏，移动端两列封面墙和侧滑菜单。
- PWA manifest 和 service worker，缓存静态资源，不缓存 API 和 HTML。

## 本地开发

```bash
npm install
npm run dev
```

开发服务默认运行在：

```text
http://localhost:5173
```

本地需要预览生产构建时可运行：

```bash
npm run build
npm start
```

可通过环境变量指定端口：

```bash
PORT=8080 npm start
```

Windows PowerShell 示例：

```powershell
$env:PORT = "8080"
npm.cmd start
```

## Docker Compose + Caddy 部署

推荐用 Docker Compose 运行应用容器，并把容器端口只绑定到服务器本机 `127.0.0.1:5173`。Caddy 继续处理公网 HTTPS 和多域名反代。

服务器依赖：

- Docker Engine。
- Docker Compose v2，也就是 `docker compose` 命令。
- 已运行的 Caddy，并且 80/443 已开放。

示例部署目录：

```bash
sudo mkdir -p /opt/ortlinde-viewer
sudo chown -R "$USER:$USER" /opt/ortlinde-viewer
```

从 GitHub 拉取源码到服务器：

```bash
git clone https://github.com/YOUR_USER/YOUR_REPO.git /opt/ortlinde-viewer
cd /opt/ortlinde-viewer
```

如果目录已经存在，更新源码：

```bash
cd /opt/ortlinde-viewer
git pull --ff-only
```

启动或更新容器：

```bash
docker compose up -d --build
```

Compose 会读取项目根目录的 `.env`。默认值如下：

```dotenv
HOST_BIND=127.0.0.1
HOST_PORT=5173
PORT=5173
IMAGE_NAME=ortlinde-viewer
```

通常只需要改 `HOST_PORT`，例如服务器上 `5173` 已被占用时改成 `5183`，Caddy 也同步反代到 `127.0.0.1:5183`。

Compose 会在镜像构建阶段执行 `npm ci` 和 `npm run build`，运行阶段只保留 `server.mjs`、`dist/` 和 `curl`。容器对外不会暴露公网端口，只监听服务器本机：

```yaml
ports:
  - "${HOST_BIND:-127.0.0.1}:${HOST_PORT:-5173}:${PORT:-5173}"
```

本机验证：

```bash
curl http://127.0.0.1:5173/
curl http://127.0.0.1:5173/api/categories
```

Caddy 反代示例见 `deploy/Caddyfile.viewer.example`。如果你的 Caddyfile 已经使用 `import /etc/caddy/sites-enabled/*.caddy` 这类结构，可以复制成独立站点文件；否则把站点块追加到现有 `/etc/caddy/Caddyfile`：

```caddyfile
viewer.example.com {
	encode zstd gzip

	reverse_proxy 127.0.0.1:5173 {
		header_up Host {host}
		header_up X-Real-IP {remote_host}
	}
}
```

替换域名后验证并重载 Caddy：

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

查看容器状态和日志：

```bash
docker compose ps
docker compose logs -f viewer
```

更新应用：

```bash
cd /opt/ortlinde-viewer
docker compose up -d --build
docker image prune -f
```

部署建议：

- 不要把 `5173` 暴露到公网，只开放 80/443。
- 不要复制 Windows 的 `node_modules` 到 Linux，Docker 构建会在 Linux 镜像里重新安装依赖。
- 不要把 Caddy 放进这个 Compose；Caddy 继续由宿主机现有配置管理。
- 当前图片默认直接从 `https://veil.ortlinde.com/v1/image/{id}` 加载，不经过你的服务器；如果国内实测主要卡在图片，再考虑新增图片代理或 CDN 方案。
- 少量用户访问优先保持这个架构；中国大陆 CDN 或大陆节点通常会引入 ICP 备案要求。

## 测试

完整测试：

```bash
npm test
```

单项测试：

```bash
npm run test:routes
npm run test:static
npm run test:dev-server
npm run test:browser
```

说明：

- `test:routes` 验证代理路由、编码和参数清洗。
- `test:static` 验证生产静态服务、PWA 文件、缓存头和错误响应。
- `test:dev-server` 验证 dev server 能启动并关闭 Vite watcher。
- `test:browser` 构建后运行浏览器冒烟测试，覆盖桌面/移动布局、收藏、信息面板、错误状态和本地状态清洗。

浏览器测试会写入 `test-results/` 截图；该目录仅用于本地检查。

## 代理接口

前端只访问同源 `/api/*`，由 `server.mjs` 转发到 `https://veil.ortlinde.com`。

当前代理支持：

- `/api/site-config`
- `/api/categories`
- `/api/featured-tags`
- `/api/tags?limit=&offset=`
- `/api/galleries?limit=&offset=`
- `/api/gallery/random`
- `/api/gallery/random?category=...`
- `/api/gallery/random?tag=...`
- `/api/gallery/:id?image_limit=&image_offset=`
- `/api/image/:id/meta`
- `/api/tag/:name/preview`

图片文件默认不经过代理，直接使用：

```text
https://veil.ortlinde.com/v1/image/{id}
```

这样浏览器和上游 CDN 可以直接缓存图片。

## 限流和封禁保护

代理层做了保守限流：

- 全局上游请求：每 300 秒最多 55 次。
- 标签预览：每 300 秒最多 28 次。
- 收到上游 `429` 后进入指数退避。
- 收到上游 `403` 后当前代理会话暂停上游请求 30 分钟。

缓存策略：

- 分类、精选标签、标签列表等元数据缓存约 10 分钟。
- 图集详情缓存约 5 分钟。
- 标签预览缓存约 45 秒。
- 随机图集不缓存。
- 代理内存缓存最多 180 项。

使用建议：

- 以个人或少量用户使用为目标。
- 不做批量下载或瀑布流全量预览。
- 避免公开多人共用同一个代理出口 IP。

## 本地数据

浏览器本地保存：

- 最近会话图集。
- 历史图集。
- 收藏图片 ID。
- 已加载标签缓存。
- 最近使用标签。

不会保存图片文件。异常本地数据会在恢复时清洗，例如无效图片 ID、无效收藏项和标签预览会话。

## PWA 行为

生产模式会注册 `sw.js`：

- 缓存 manifest、图标和静态资源。
- 不缓存 HTML 文档。
- 不拦截 `/api/*`。
- 不拦截 `/sw.js`。
- 缓存失败不会阻断页面网络请求。

开发模式会注销旧 service worker，并删除 `ortlinde-viewer-*` 缓存，避免调试时使用旧资源。

## 目录

```text
server.mjs                 Node 代理和静态文件服务
Dockerfile                 生产镜像构建
docker-compose.yml         Docker Compose 部署配置
.env                       Compose 默认端口和镜像名
src/main.ts                前端应用逻辑
src/styles.css             前端样式
public/manifest.webmanifest
public/sw.js               PWA service worker
scripts/build.mjs          带构建锁的构建脚本
scripts/route-tests.mjs
scripts/static-tests.mjs
scripts/dev-server-tests.mjs
scripts/browser-smoke.mjs
deploy/Caddyfile.viewer.example
```

## 开发注意事项

- 手动编辑文件时优先保持依赖少、逻辑直接。
- 改 `server.mjs` 后需要重启 `npm run dev`。
- 改前端文件时 Vite 会热更新。
- `npm` 关于 Electron mirror 的警告来自用户级 npm 配置，不属于本项目依赖问题。
- 当前项目没有 git 仓库；如需版本管理，先初始化 git 再提交。
