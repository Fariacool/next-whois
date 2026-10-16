<div align="center">

<img src="/public/icons/icon-512x512.png" alt="Next Whois" width="64" height="64">

# Next Whois

快速、现代的 WHOIS/RDAP 查询工具，基于 Next.js 构建。

[English](/README.md) · [简体中文](/docs/README_CN.md) · [繁體中文](/docs/README_TW.md) · [Русский](/docs/README_RU.md) · [日本語](/docs/README_JP.md) · [Deutsch](/docs/README_DE.md) · [Français](/docs/README_FR.md) · [한국어](/docs/README_KR.md)

[![Deploy to Vercel](https://vercel.com/button)](https://vercel.com/import/project?template=https://github.com/zmh-program/next-whois-ui)
[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/zmh-program/next-whois-ui)

</div>

![Banner](/public/banner.png)

## 特性

- **WHOIS & RDAP** - 支持域名、IPv4、IPv6、ASN、CIDR 查询，优先使用 RDAP，自动回退到 WHOIS
- **动态 OG 图片** - 基于 Satori 的 Open Graph 图片生成，通过 `/api/og` 访问
- **响应式界面** - Shadcn UI + Tailwind CSS，适配手机、平板和桌面端，支持 PWA
- **深色 / 浅色主题** - 自动检测系统主题，支持手动切换
- **历史记录与快捷键** - 本地历史记录，支持搜索、筛选和键盘快捷键
- **EPP 状态码** - 可读的状态描述，附带 ICANN 参考链接
- **注册商与 NS 品牌识别** - 自动识别主要注册商和域名服务器提供商的图标
- **域名指标** - 可选集成 Moz DA/PA/Spam Score
- **Redis 缓存** - 服务端结果缓存，支持 `Cache-Control` 响应头
- **开放 API** - `/api/lookup` 提供编程访问，`/api/og` 生成动态图片
- **国际化** - 支持英语、简体中文、繁体中文、德语、俄语、日语、法语、韩语
- **API 文档** - 内置 `/docs` 页面，提供交互式示例

## 社区二开

这些优秀开发者基于本项目做出了很棒的二次开发：

- [w.is](https://w.is) (by [HiFrey](https://x.com/@HiFrey))
- [yisi.yun](https://yisi.yun) ([14.cx](https://14.cx), by [人皇](https://www.dalao.net/user-4842.htm))

## 部署

### 云平台（推荐）

[Vercel](https://vercel.com/import/project?template=https://github.com/zmh-program/next-whois-ui) / [Netlify](https://app.netlify.com/start/deploy?repository=https://github.com/zmh-program/next-whois-ui) / [Zeabur](https://zeabur.com/templates/UHCCCT)

### Docker

每次向 `main` 推送提交，都会先执行一次类型检查和测试，再分别使用原生 `ubuntu-24.04`、`ubuntu-24.04-arm` runner 并行构建 `linux/amd64` 和 `linux/arm64` 镜像。每个镜像通过容器冒烟测试后，最后一个 job 使用内置的 `GITHUB_TOKEN` 合并并发布 GHCR manifest。不需要 `ENABLE_DOCKER_PUBLISH` 变量，也不需要 DockerHub 账号或密钥。也可以在 **Actions → Build and Push Docker Image → Run workflow** 中选择 `main` 手动构建。

Docker 层缓存和 Next.js 编译缓存按架构隔离。Next.js 缓存挂载会显式恢复、保存到 Actions 缓存，源码变化后可在全新的 runner 上继续复用；pnpm store 放在缓存挂载中，不写入镜像层。PR 仍运行完整生产构建，`main` 则由两个 Docker 构建完成生产编译，避免 CI 重复执行。

镜像地址为 `ghcr.io/fariacool/next-whois`，自动发布 `latest`、`main` 和 `sha-<完整 commit SHA>` 标签。其他 fork 会按自己的仓库所有者/仓库名生成小写镜像地址，服务器上的 `IMAGE_NAME` 需相应修改。

```bash
docker run -d --name next-whois --restart unless-stopped \
  -p 3000:3000 ghcr.io/fariacool/next-whois:latest
```

#### Docker Compose

服务器需要 Docker Engine 和 Docker Compose v2，直接运行已发布的镜像，无需安装 Node.js 或 pnpm。

```bash
git clone https://github.com/Fariacool/next-whois.git
cd next-whois
./compose init
# 检查 .env；如需对两个 API 启用 key 访问控制，设置 API_KEY。
./compose up

# GitHub 已发布新镜像后更新：
./compose upgrade
```

`./compose init` 会在 `.env` 不存在时从 `.env.example` 创建。默认开放 `3000` 端口、允许公开访问 API，不依赖 Redis。使用宿主机反向代理时，可将 `HOST_BIND_ADDRESS` 改为 `127.0.0.1`；`HOST_PORT` 可修改对外端口。可选的 `REDIS_*` 和 Moz 配置见 `.env.example`；若 Redis 在宿主机运行，可设置 `REDIS_HOST=host.docker.internal`，并确保其监听地址允许 Docker 容器访问。应用本身无需持久化数据卷。

其他命令：`./compose logs [service]`、`ps`、`down`、`restart [service]`、`pull`、`redeploy`、`validate` 和 `help`。`upgrade` 拉取镜像并应用更新，`redeploy` 使用本地镜像强制重建容器。修改 `.env` 后运行 `./compose up` 以应用新配置，单独 `restart` 不会更新环境变量。如需回滚，将 `.env` 中的 `IMAGE_NAME` 改为 `ghcr.io/fariacool/next-whois:sha-<完整 commit SHA>`，再运行 `./compose upgrade`。

预构建镜像使用默认的站点/浏览器配置。`API_KEY`、Redis 和 Moz 在容器启动时配置；自定义 `NEXT_PUBLIC_*` 站点/浏览器配置需要自行构建镜像。本地 `.env*` 文件不会进入 Docker 构建上下文。

### 源码部署

```bash
git clone https://github.com/zmh-program/next-whois-ui
cd next-whois-ui
pnpm install
pnpm dev
```

## 环境变量

| 变量 | 描述 | 默认值 |
|------|------|--------|
| `NEXT_PUBLIC_SITE_TITLE` | 站点标题 | Next Whois |
| `NEXT_PUBLIC_SITE_DESCRIPTION` | 站点描述 | — |
| `NEXT_PUBLIC_SITE_KEYWORDS` | 站点关键词 | — |
| `NEXT_PUBLIC_HISTORY_LIMIT` | 最大历史记录数（-1 = 无限制） | -1 |
| `NEXT_PUBLIC_MAX_WHOIS_FOLLOW` | 最大域名 WHOIS 跟随深度 | 0 |
| `API_KEY` | 可选访问 key，配置后两个 API 均需要 Bearer 认证 | — |
| `MOZ_ACCESS_ID` | Moz API Access ID | — |
| `MOZ_SECRET_KEY` | Moz API Secret Key | — |
| `REDIS_HOST` | Redis 主机（留空则禁用缓存） | — |
| `REDIS_PORT` | Redis 端口 | 6379 |
| `REDIS_PASSWORD` | Redis 密码 | — |
| `REDIS_DB` | Redis 数据库索引 | 0 |
| `REDIS_CACHE_TTL` | 缓存 TTL（秒） | 3600 |

## API

查看内置的 [API 文档](https://who.zmh.me/docs) 页面，或：

**`GET /api/lookup?query=google.com`** — WHOIS/RDAP 查询

**`GET /api/og?query=google.com`** — 动态 OG 图片生成

### API key 访问控制

在部署平台设置服务端环境变量 `API_KEY`，然后重新部署。Netlify 中需使其同时适用于 Builds 和 Functions，让 Node.js 查询 API 与 Edge OG 路由使用相同的值。不要使用 `NEXT_PUBLIC_` 前缀。未配置或值为空时保持公开访问。

通过顶部导航栏的 **API key** 入口填写，key 保存在当前浏览器的 `localStorage` 中，同一弹窗可替换或清除。查询、图片预览和下载请求携带 `Authorization: Bearer <key>`；缺少或错误的 key 返回 HTTP `401` 和 `Error 401`。认证不使用 Cookie，不增加登录页。

直接打开 `/example.com` 等链接只预填搜索内容，点击查询后才由服务端执行检索。直接调用 API 或访问 OG 图片同样需要 Bearer 请求头，分享链接不会包含 key。

```bash
curl 'https://your-domain.com/api/lookup?query=example.com' \
  -H "Authorization: Bearer $API_KEY"

curl 'https://your-domain.com/api/og?query=example.com' \
  -H "Authorization: Bearer $API_KEY" -o whois.png
```

开启认证后，API 响应禁用浏览器和 CDN 缓存；通过认证的查询仍可使用服务端 Redis 缓存。

## 技术栈

- Next.js 14 (Pages Router, Edge Runtime for OG)
- [Whoiser](https://www.npmjs.com/package/whoiser) + RDAP client
- Satori (via `next/og`) for image generation
