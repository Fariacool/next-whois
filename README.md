<div align="center">

<img src="/public/icons/icon-512x512.png" alt="Next Whois" width="64" height="64">

# Next Whois

A fast, modern WHOIS/RDAP lookup tool built with Next.js.

[English](/README.md) · [简体中文](/docs/README_CN.md) · [繁體中文](/docs/README_TW.md) · [Русский](/docs/README_RU.md) · [日本語](/docs/README_JP.md) · [Deutsch](/docs/README_DE.md) · [Français](/docs/README_FR.md) · [한국어](/docs/README_KR.md)

[![Deploy to Vercel](https://vercel.com/button)](https://vercel.com/import/project?template=https://github.com/zmh-program/next-whois-ui)
[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/zmh-program/next-whois-ui)

</div>

![Banner](/public/banner.png)

## Features

- **WHOIS & RDAP** - Domain, IPv4, IPv6, ASN, CIDR lookup with RDAP-first, WHOIS fallback
- **Dynamic OG Images** - Satori-based Open Graph image generation via `/api/og`
- **Responsive UI** - Shadcn UI + Tailwind CSS, works across mobile, tablet, and desktop. PWA support.
- **Dark / Light Theme** - System detection with manual toggle
- **History & Shortcuts** - Local history with search, filter, and keyboard shortcuts
- **EPP Status Codes** - Human-readable status descriptions with ICANN references
- **Registrar & NS Branding** - Auto-detected icons for major registrars and nameserver providers
- **Domain Metrics** - Moz DA/PA/Spam Score integration (optional)
- **Redis Caching** - Server-side result caching with `Cache-Control` headers
- **Open API** - `/api/lookup` for programmatic access, `/api/og` for image generation
- **i18n** - English, Chinese (Simplified/Traditional), German, Russian, Japanese, French, Korean
- **API Documentation** - Built-in `/docs` page with interactive examples

## Community Forks

See great work from brilliant builders extending this project:

- [w.is](https://w.is) (by [HiFrey](https://x.com/@HiFrey))
- [14.cx](https://14.cx) ([yisi.yun](https://yisi.yun), by [人皇](https://www.dalao.net/user-4842.htm))

## Deploy

### Platforms (Recommended)

[Vercel](https://vercel.com/import/project?template=https://github.com/zmh-program/next-whois-ui) / [Netlify](https://app.netlify.com/start/deploy?repository=https://github.com/zmh-program/next-whois-ui) / [Zeabur](https://zeabur.com/templates/UHCCCT)

### Docker

Every push to `main` runs CI, then builds `linux/amd64` and `linux/arm64` images and publishes them to GHCR using the built-in `GITHUB_TOKEN`. No `ENABLE_DOCKER_PUBLISH` variable or DockerHub credentials are needed. The workflow also supports **Actions → Build and Push Docker Image → Run workflow** on `main`.

The image is `ghcr.io/fariacool/next-whois`, with `latest`, `main`, and `sha-<full commit SHA>` tags. In another fork, the workflow uses that repository's lowercase owner/name; update `IMAGE_NAME` on the server accordingly.

```bash
docker run -d --name next-whois --restart unless-stopped \
  -p 3000:3000 ghcr.io/fariacool/next-whois:latest
```

#### Docker Compose

Requires Docker Engine and Docker Compose v2. The server runs the published image; it does not need Node.js or pnpm.

```bash
git clone https://github.com/Fariacool/next-whois.git
cd next-whois
./compose init
# Review .env; set API_KEY if you want to require a key for both APIs.
./compose up

# After a newer image has been published:
./compose upgrade
```

`./compose init` creates `.env` from `.env.example` when missing. Defaults expose port `3000` with public API access and no Redis dependency. Set `HOST_BIND_ADDRESS=127.0.0.1` when a reverse proxy on the host should be the only entry point, or change `HOST_PORT` to use another port. Optional `REDIS_*` and Moz settings are included in `.env.example`; use `REDIS_HOST=host.docker.internal` for an existing Redis instance listening on a host interface reachable from Docker. The app requires no persistent volume.

Other commands: `./compose logs [service]`, `ps`, `down`, `restart [service]`, `pull`, `redeploy`, `validate`, and `help`. `upgrade` pulls and applies the newest configured image; `redeploy` force-recreates containers using the local image. After editing `.env`, run `./compose up` to recreate containers with the new environment; `restart` alone does not apply configuration changes. To roll back, set `IMAGE_NAME=ghcr.io/fariacool/next-whois:sha-<full commit SHA>` in `.env` and run `./compose upgrade`.

The published image uses the default site/browser settings. Configure `API_KEY`, Redis, and Moz at container runtime; custom `NEXT_PUBLIC_*` site/browser settings require a custom build. Local `.env*` files are excluded from the Docker build context.

### Source Code

```bash
git clone https://github.com/zmh-program/next-whois-ui
cd next-whois-ui
pnpm install
pnpm dev
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `NEXT_PUBLIC_SITE_TITLE` | Site title | Next Whois |
| `NEXT_PUBLIC_SITE_DESCRIPTION` | Site description | — |
| `NEXT_PUBLIC_SITE_KEYWORDS` | Site keywords | — |
| `NEXT_PUBLIC_HISTORY_LIMIT` | Max history items (-1 = unlimited) | -1 |
| `NEXT_PUBLIC_MAX_WHOIS_FOLLOW` | Max domain WHOIS follow depth | 0 |
| `API_KEY` | Optional Bearer key required by both APIs | — |
| `MOZ_ACCESS_ID` | Moz API Access ID | — |
| `MOZ_SECRET_KEY` | Moz API Secret Key | — |
| `REDIS_HOST` | Redis host (empty = cache disabled) | — |
| `REDIS_PORT` | Redis port | 6379 |
| `REDIS_PASSWORD` | Redis password | — |
| `REDIS_DB` | Redis database index | 0 |
| `REDIS_CACHE_TTL` | Cache TTL in seconds | 3600 |

## API

See the built-in [API Documentation](https://who.zmh.me/docs) page, or:

**`GET /api/lookup?query=google.com`** — WHOIS/RDAP lookup (parallel, merged results, includes raw responses)

**`GET /api/og?query=google.com`** — Dynamic OG image generation

Lifecycle dates are normalized to UTC ISO timestamps; unavailable or invalid
dates remain `Unknown`. A successful lookup can contain registrar/status data
without registration dates. See [lifecycle parsing and regression testing](docs/whois-lifecycle.md)
for namespace-specific behavior, policy sources and optional handoff regression.

### API key protection

Set `API_KEY` in your hosting provider's server-side environment variables and redeploy. On Netlify, make it available to both Builds and Functions so the Node.js API and Edge OG route use the same value. Do not use a `NEXT_PUBLIC_` prefix. Leaving `API_KEY` unset or empty keeps public access.

Use **API key** in the top navigation to save the key in this browser's `localStorage`. The same dialog lets you replace or clear it. Queries and image previews/downloads send `Authorization: Bearer <key>`; missing or incorrect keys return HTTP `401` with `Error 401`. No authentication cookies or login page are used.

Opening a query URL such as `/example.com` only pre-fills the search field. Click Search to execute the lookup on the server. A key must also accompany direct API or OG image requests; it is never added to shared URLs.

```bash
curl 'https://your-domain.com/api/lookup?query=example.com' \
  -H "Authorization: Bearer $API_KEY"

curl 'https://your-domain.com/api/og?query=example.com' \
  -H "Authorization: Bearer $API_KEY" -o whois.png
```

Protected API responses disable browser and CDN caching. Server-side Redis caching remains available after authentication.

## Tech Stack

- Next.js 14 (Pages Router, Edge Runtime for OG)
- [Whoiser](https://www.npmjs.com/package/whoiser) + RDAP client
- Satori (via `next/og`) for image generation
