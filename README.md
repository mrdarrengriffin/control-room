<div align="center">

# 🎛️ Control Room

**One dashboard for every site we run.**

Purge caches, watch deploys, review pull requests, read analytics and audit
performance — without opening five tabs and remembering four logins.

[![Publish image](https://github.com/mrdarrengriffin/control-room/actions/workflows/publish.yml/badge.svg)](https://github.com/mrdarrengriffin/control-room/actions/workflows/publish.yml)
[![Container](https://img.shields.io/badge/ghcr.io-control--room-2496ED?logo=docker&logoColor=white)](https://github.com/mrdarrengriffin/control-room/pkgs/container/control-room)
[![Built with Astro](https://img.shields.io/badge/built%20with-Astro-BC52EE?logo=astro&logoColor=white)](https://astro.build)
[![Self-hosted](https://img.shields.io/badge/self--hosted-local%20first-16a34a)](#-privacy)
[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue)](LICENSE)

</div>

---

## ✨ What it does

|  | Feature | |
|:--:|---|---|
| 📊 | **Analytics** | Visitors, pageviews, sources, countries, devices and goals from Plausible — per site and across all of them. Live visitor counts tick in the sidebar. |
| 🚀 | **Deploys** | Netlify's latest published deploy with its status, commit, linked PR and age. |
| 🔀 | **Pull requests** | Your open PRs with every CI job's status, pulled in one call per repo. |
| 🧹 | **Cache purging** | One-click Cloudflare purge — everything, or specific URLs. |
| 🔦 | **Lighthouse audits** | Performance, accessibility, best practices and SEO, with a deep dive that shows you *which element* failed and why. |
| 📸 | **Screenshots** | Full-page desktop and mobile captures of one page or all of them. |
| 🎬 | **Scroll video** | A WebM of a page scrolled top to bottom, so scroll-driven effects actually fire. |
| 📉 | **Scroll performance** | Frame timing and main-thread blocking, aimed at image-sequence scrollers. |

Everything runs on your machine. No account, no SaaS, no telemetry.

---

## 🚀 Quick start

You need **Docker**. That's the entire list — there's no Node.js to install,
no browser to set up, nothing else to configure.

```sh
mkdir control-room && cd control-room
curl -O https://raw.githubusercontent.com/mrdarrengriffin/control-room/main/deploy/docker-compose.yml
docker compose up -d
```

Open **<http://127.0.0.1:4331>** and you're in.

> [!TIP]
> First launch pulls a large image (it bundles a full Chromium), so give it a
> few minutes. After that, startup is seconds.

### First run, in three steps

**1. Set a password.** Every page redirects to `/setup` until you do. It's
stored as an scrypt hash — there's no reset, so use a password manager.

**2. Connect your services.** Go to **Settings**, paste a token, hit **Test
connection**. Every token is optional and they take effect immediately.

**3. Add a site.** Click **+ Add a site** and give it a URL. Control Room
searches your connected services for a matching Cloudflare zone, Netlify site,
Plausible property and GitHub repo, then shows you what it found before saving
anything.

Until you add your first site, you'll see example data with a banner saying so.
Nothing shown there is yours.

---

## 🔑 Connecting services

| Service | Unlocks | Where to get a token |
|---|---|---|
| **Plausible** | Analytics, live visitors | Site settings → API keys |
| **Cloudflare** | Cache purging | My Profile → API Tokens → needs `Zone · Cache Purge · Purge` |
| **Netlify** | Deploy history and status | User settings → Applications → Personal access tokens |
| **GitHub** | Pull requests and CI status | Settings → Developer settings → PATs → needs `repo` read (`read:org` for private org repos) |

> [!NOTE]
> **Panels degrade individually.** A service with no token renders as "not
> configured" instead of breaking the page, so you can connect them one at a
> time and the dashboard stays useful throughout.

<details>
<summary><b>Self-hosting Plausible, or using more than one instance?</b></summary>

<br>

Set `PLAUSIBLE_BASE_URL` to your instance. If some sites live on a *different*
Plausible install, give those sites their own `baseUrl` and `keyEnv` in
`data/sites.json`:

```json
{
  "slug": "example",
  "url": "https://other.example.com",
  "plausible": {
    "domain": "other.example.com",
    "baseUrl": "https://analytics.other.example.com",
    "keyEnv": "PLAUSIBLE_API_KEY_OTHER"
  }
}
```

Discovery probes every instance already in use, so a site on the second install
is found without being told about it.

</details>

<details>
<summary><b>Prefer config files to the settings page?</b></summary>

<br>

Both work, and files are read live:

```sh
cp .env.example .env                          # tokens
cp data/sites.example.json data/sites.json    # sites
```

Values resolve in three layers, highest first: `data/secrets.json` (written by
Settings) → environment variables → the `.env` file. The settings page tells you
which layer each value is coming from.

</details>

---

## 🔄 Updating

```sh
docker compose pull && docker compose up -d
```

Your `data/` folder — password, tokens, sites, saved runs and screenshots — is a
bind mount next to the compose file. It survives updates untouched, and backing
up that one folder backs up everything.

Images are published to
[`ghcr.io/mrdarrengriffin/control-room`](https://github.com/mrdarrengriffin/control-room/pkgs/container/control-room):

| Tag | Moves when | Use it if |
|---|---|---|
| `latest` | A release is published | You want stable updates on purpose *(default)* |
| `main` | Every push to `main` | You want changes as they land |
| `1.2.3` / `1.2` | A release is published | You want to pin a version |

To follow `main` instead of releases, set `CONTROL_ROOM_TAG=main` in a `.env`
file beside your compose file.

Images are multi-arch — **linux/amd64** and **linux/arm64** — so Apple Silicon,
Intel Macs, PCs and ARM boards like a Raspberry Pi 5 all pull the right one
automatically.

---

## 🔒 Privacy

This app holds API tokens for four services, shells out to `gh`, drives a
browser and has a one-click cache purge. It is built to stay on your machine:

- **Binds to `127.0.0.1` by default.** Nothing is reachable from your network
  unless you change that.
- **Secrets never leave the box.** They live in `data/secrets.json` or `.env`,
  both gitignored, and the settings page only ever displays a secret's *length*.
- **Favicons are fetched by this server**, not by Google's or DuckDuckGo's
  favicon service — those would send the full list of sites you monitor to a
  third party on every page load.
- **No analytics, no crash reporting, no phoning home.**

### Running it on your network or a NAS

Set `CONTROL_ROOM_BIND=0.0.0.0` in your `.env` and reach it at
`http://that-host:4331`.

> [!WARNING]
> **Over plain HTTP your password crosses the network in clear text.** Put it
> behind TLS with a reverse proxy, or on a private network like Tailscale,
> before exposing it. That matters more here than for a typical self-hosted app,
> given what this one can reach.

---

## 🧪 Running tests on a site

Open any site and use the runners at the bottom of the page.

- Pick pages from **your most-visited pages** (straight from Plausible) or
  **your sitemap** — no typing URLs by hand.
- Watch a run happen live: a timestamped log, and optionally a **live view of
  the browser** as it works.
- The runs table updates itself the moment anything finishes, even a run you
  started in another tab.
- Every audit gets a **deep dive** page: what failed, the LCP element as a
  cropped screenshot, and a highlighted crop of every offending element with its
  selector and the specific reason it failed.

> [!CAUTION]
> Frame rates from headless Chromium are **indicative, not a device
> measurement** — there's no real display refresh. Compare runs of the same page
> against each other; don't read them as "what users get". The *blocking* number
> is the trustworthy one.

---

## 🛠️ Development

Two instances on two ports, so the dashboard you use stays up while you edit it.

```sh
git clone git@github.com:mrdarrengriffin/control-room.git
cd control-room

docker compose up -d --build                      # you use this    :4331
docker compose -f docker-compose.dev.yml up -d    # you edit this   :4332
```

Or open the folder in VS Code and **Reopen in Container** — the devcontainer
uses that same dev service and starts the dev server for you.

Ports are overridable with `CONTROL_ROOM_PORT` and `CONTROL_ROOM_DEV_PORT`. They
default to 4331/4332 rather than Astro's usual 4321, which VS Code tends to hold.

**Releasing:** push to `main` to publish `:main`, or
[cut a release](https://github.com/mrdarrengriffin/control-room/releases/new)
tagged `v1.2.3` to publish `:1.2.3`, `:1.2` and move `:latest`.

> 📐 **[Architecture & implementation notes →](docs/ARCHITECTURE.md)**
>
> How it's built, why the odd decisions are the way they are, and a long list of
> things that were surprising or wrong the first time. Read this before changing
> providers, caching or the container.

---

## 🧰 Troubleshooting

<details>
<summary><b>A panel says "not configured" after I added the token</b></summary>

<br>

If you added it in **Settings**, it should apply instantly. If you edited
`.env` for the **prod** instance, recreate the container — Docker only reads
`env_file` when a container is created:

```sh
docker compose up -d --force-recreate
```

The dev instance picks up `.env` changes without this.

</details>

<details>
<summary><b>Hot reload stopped working</b></summary>

<br>

Restart the dev container. Do **not** reach for `astro dev --force` — it reads a
stale PID out of `.astro/dev.json` and makes the container kill itself. The
compose command already clears that lock on start.

</details>

<details>
<summary><b>Deploys look wrong, or show a site I don't recognise</b></summary>

<br>

Control Room verifies that a resolved Netlify site actually serves your domain
and skips it if not, so this should be rare. If a site isn't on Netlify at all,
untick **Deployed on Netlify** when editing it and the panel goes quiet.

</details>

<details>
<summary><b>"Purge everything" cleared more sites than I expected</b></summary>

<br>

Subdomains usually share their parent's Cloudflare zone, and purging is
zone-wide. The site page warns you when a zone is shared. Use **purge by URL**
when you need to be precise.

</details>

<details>
<summary><b>I forgot my password</b></summary>

<br>

There's no reset by design. Delete `data/auth.json` and restart — you'll be sent
back to `/setup`. Your sites and tokens are untouched.

</details>

---

<div align="center">
<sub>Built for the <a href="https://openhomefoundation.org">Open Home Foundation</a> · <a href="LICENSE">Apache 2.0</a><br>
Runs on your machine, answers to nobody else.</sub>
</div>
