# Control Room

A local dashboard for the sites we run: Cloudflare cache purging, Netlify deploy
state, open pull requests with their CI jobs, and Plausible analytics — one view
per site, plus an overview across all of them.

It runs entirely on your machine and is **not meant to be hosted**. Both
instances bind to `127.0.0.1` only, because this process holds API tokens for
four services.

## Requirements

Docker. That's it — **there is no Node.js requirement on the host**; everything
including `npm install` happens inside the container.

## Running it (no source needed)

The published image is all you need. Make a folder, drop in one file, start it:

```sh
mkdir control-room && cd control-room
curl -O https://raw.githubusercontent.com/mrdarrengriffin/control-room/main/deploy/docker-compose.yml
docker compose up -d
```

Then open **http://127.0.0.1:4331** and set a password on first run.

**To update**, when a new release is out:

```sh
docker compose pull && docker compose up -d
```

Your `data/` folder — password, tokens, site registry, saved runs — is a bind
mount, so it survives updates untouched. Back that folder up and you have backed
up everything.

Images are published to `ghcr.io/mrdarrengriffin/control-room`. `:latest` moves
only when a GitHub Release is cut, so an update is a deliberate act; `:main`
tracks every push to main if you want the bleeding edge. It is amd64 only — see
the workflow for why.

Everything below is about working *on* Control Room — see **Setup** and
**Running from source**. If you only want to use it, the three commands above are
the whole story.

## Look and feel

The chrome follows the **shadcn/ui** design language — neutral zinc surfaces,
hairline borders, `rounded-lg` cards with a whisper of shadow, 36px controls, a
near-black primary, focus-visible rings — implemented as **plain CSS custom
properties**. No Tailwind and no React: nearly all of this UI is server-rendered
markup, and Radix only earns its keep for widgets this app doesn't have
(command palette, combobox, complex dialogs). Everything lives in
`src/styles/app.css`.

Two deliberate departures from shadcn's defaults:

- **The page sits below the cards.** Previously page and card were about 1%
  apart in lightness, which is why the UI read as one flat field. Cards are now
  white on `#fafafa`.
- **Dark mode lifts the card above the background** (`#18181b` on `#09090b`).
  shadcn's default has `card == background`, which would reproduce the same
  flatness in dark mode.

**Data colours are a separate system and are not shadcn's.** The series blue,
the ordinal ramp and the four status colours come from the validated data-viz
palette. Chrome uses the neutral primary precisely so that blue always means
"this is data" rather than "this is a button".

Changing the surfaces means the chart palette has to be re-checked, not assumed:
run `validate_palette.js` against the new surface before shipping a theme
change. On this one the ordinal ramp cleared its light end at **2.11:1 on white**
and **3.28:1 on the dark card**. Note the validator's categorical checks do not
apply to the status palette — it is fixed by design, and its two sub-3:1 colours
are mitigated by the icon + label pairing every status pill carries.

## Authentication

On first run every page redirects to **`/setup`** to set a single admin
password. It is stored as an scrypt hash — never in plaintext — in
`data/auth.json`, alongside a per-install session secret. **There is no reset:
delete that file to start over.**

Sessions are stateless signed cookies (httpOnly, SameSite=Lax, 30 days), so
restarts don't sign you out, and changing the password rotates the secret and
ends every session at once.

`/ws` is gated too. Astro's middleware only sees HTTP routes — an upgrade
request never reaches it — so the WebSocket server verifies the same cookie
itself and closes unauthenticated upgrades with a 401. Both sides share one
implementation in `server/session.mjs` rather than keeping two copies of
security-critical code in step.

`/api/health` is deliberately open (a healthcheck has no session) and reports
only liveness and whether setup is pending. API routes answer **401** rather
than redirecting, because a redirect would return the login page's HTML with a
200 and the auto-refresh would splice that into the page instead of noticing it
had been signed out.

## Reaching it from other machines

The port still binds to loopback by default. To run it like any other self-hosted
app — on a NAS or a small always-on box — set `CONTROL_ROOM_BIND=0.0.0.0` in
`.env` and reach it at `http://that-host:4331`.

Worth being clear about the trade: **over plain HTTP the password crosses the
network in the clear.** Put it behind TLS via a reverse proxy, or on a private
network such as Tailscale. That matters more here than for a typical self-hosted
app — this one shells out to `gh`, drives a browser, and has a one-click cache
purge.

## Setup

Start it (see **Running from source** below), then use the UI:

1. **Settings** → paste a token per service and hit **Test connection**. Values are
   saved to `data/secrets.json` (gitignored) and take effect immediately — no
   restart. The page shows *which source* each value comes from, because there are
   three and the precedence would otherwise be guesswork.
2. **+ Add a site** → give a URL. Connected services are searched for a matching
   Cloudflare zone, Netlify site, Plausible property and GitHub repo; you confirm
   what it found before it's written to `data/sites.json`.

Prefer files? Both still work:

```sh
cp .env.example .env                          # tokens
cp data/sites.example.json data/sites.json    # sites
```

Both files are gitignored. Every token is optional: a panel with no token renders
as "not configured" rather than breaking the page, so you can fill them in one at
a time.

| Token | Used for | Where to create it |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | Cache purging | Cloudflare > My Profile > API Tokens. Needs **Zone > Cache Purge > Purge** |
| `NETLIFY_AUTH_TOKEN` | Deploy history and state | Netlify > User settings > Applications > Personal access tokens |
| `GITHUB_TOKEN` | PRs and CI status | GitHub > Settings > Developer settings > PATs. Needs `repo` read (`read:org` for private org repos) |
| `PLAUSIBLE_API_KEY` | Analytics | Plausible > Site settings > API keys. Set `PLAUSIBLE_BASE_URL` too if you self-host |

Per-site identifiers (Cloudflare zone ID, Netlify site ID, `owner/repo`,
Plausible domain) go in `data/sites.json`, not in `.env`.

## Running from source

Two instances on two ports, so the dashboard you use stays up while you edit it.
(To just *run* Control Room without a checkout, see the top of this file.)

**The one you use:**

```sh
docker compose up -d --build      # http://127.0.0.1:4331
```

**Hot-reload instance, for working on it:**

```sh
docker compose -f docker-compose.dev.yml up -d    # http://127.0.0.1:4332
```

Or open the folder in VS Code and *Reopen in Container* — the devcontainer uses
that same dev compose service, and the dev server starts automatically.

Ports are overridable via `CONTROL_ROOM_PORT` / `CONTROL_ROOM_DEV_PORT`. They
default to 4331/4332 rather than Astro's usual 4321 because VS Code was found to
be holding 4321 on this machine.

## Adding a site by URL

`src/lib/discover.ts` takes a URL and asks each connected service what it knows,
**cheapest and most authoritative first**:

1. **Cloudflare** — match the hostname against the zone list. Longest match wins,
   so a subdomain prefers its own zone over the parent's.
2. **Netlify** — look the site up by domain (with the `www` toggle). Crucially this
   also returns `build_settings.repo_url`, so **Netlify usually tells you the
   GitHub repo** — a far better answer than searching by name.
3. **Plausible** — probe the domain against the default instance *and every other
   instance already in use*, so a site on a second Plausible install is found
   without being told about it.
4. **GitHub** — only as a fallback when Netlify didn't say. Results are filtered to
   owners you belong to: searching "home-assistant.io" otherwise returns a pile of
   unrelated community projects.

Anything guessed is **labelled as a guess** and shown for confirmation before it's
saved — the repo field in particular, since a name match is not proof.

## Editing a site

**Edit site** on any site page opens `/sites/<slug>/edit`: name, URL, description,
tags, every integration id, and both page lists.

- **Look up missing details** re-runs discovery and fills only the fields that are
  currently empty — the answer to "I forgot to add the GitHub repo".
- **The slug is immutable.** Saved runs live in `data/runs/<slug>/` and artifacts
  in `data/artifacts/<slug>/`, so renaming would orphan a site's whole history.
- Keys added to `sites.json` by hand are preserved across a save from the UI.
- **Remove site** deletes the registry entry only; runs and artifacts stay on disk.

## Sidebar

Pinned to the viewport with its own scroll, so a long site list never pushes
Settings out of reach. Each site shows its **favicon**, fetched and cached
locally under `data/favicons/` (7-day TTL).

Those are fetched **by this server, not by a third-party favicon service**.
Google's and DuckDuckGo's endpoints would work, but they would send the full list
of sites you monitor to someone else on every page load — the wrong trade for a
local-first dashboard, and for an org self-hosting analytics precisely to avoid
that. The page's `<link rel="icon">` tags are preferred (scalable and
apple-touch-icon score highest) with `/favicon.ico` as the fallback, and a
lettered square if nothing can be had, so a broken image never appears.

## Sidebar labels

Configured `name` values drift — some hand-written, some derived from a domain —
so the sidebar labels each site by its **own page title** by default, read once
and cached to `data/site-meta.json` for 7 days. **Settings → Display** switches
the whole sidebar to **domains** instead.

Raw titles are mostly marketing copy ("BTHome: Open standard for broadcasting
sensor data over Bluetooth"), so the tagline is trimmed at the first `:`, `|`,
`–` or `—`. A plain hyphen is deliberately *not* a separator: it occurs inside
real names, and one site here titles its page "Sign In - OHF Employee Handbook"
(the handbook is behind auth), where splitting would leave the useless "Sign In".
Sites whose title can't be read fall back to their configured name.

## Auto-refreshing regions

Anything marked `data-live-region` re-renders itself every 30 seconds:
`src/components/AutoRefresh.astro` re-fetches the current URL and swaps just
those elements. Re-fetching the page rather than adding JSON endpoints keeps one
copy of the rendering logic, and with the SWR cache a refresh costs ~150ms.

Three details that stop it being annoying: identical markup is not swapped (so
open `<details>` don't collapse for nothing), a region containing the focused
element is skipped, and disclosure state is restored after a swap. One-shot query
params (`flash`, `message`, `sitemap`, `discover`) are stripped from the refresh
URL so messages don't reappear and expensive lookups don't re-run.

## Live visitor counts

The sidebar shows how many people are on each site right now, with a total beside
"All sites". Sites with nobody on them show no number, so the nav stays quiet.

This uses Plausible's **v1** `/api/v1/stats/realtime/visitors` endpoint on purpose,
not by oversight: the v2 query API has no realtime equivalent — both
`date_range: "realtime"` and `"30m"` are rejected with 400 "Invalid date range".
v1 returns a bare integer.

Counts are cached for 20 seconds inside the provider. The sidebar renders on every
page, so without that each navigation would fire one request per site. Any failure
yields no number at all — an analytics problem must never put an error in the
navigation.

**They refresh themselves** every 20 seconds from `/api/live`, and a badge whose
number changed gets a brief wash so movement is noticeable without being
distracting (suppressed under `prefers-reduced-motion`). Polling pauses while the
tab is hidden and catches up on return.

This one is polled rather than pushed over `/ws`, even though the socket already
exists: the WebSocket server is plain Node *outside* Astro's bundle and cannot
reach the Plausible provider, and the server-side 20s cache already bounds
upstream requests no matter how many tabs are open. Badges are always in the DOM
(hidden at zero) so the poller can reveal one that rises above zero.

## Choosing test pages

Each site page has a **Test pages** card with two lists — `testPages` (audited and
captured by default) and `interactivePages` (scroll-driven sections, where the
scroll-performance test aims). Both are editable in place; full URLs are accepted
and reduced to paths.

Rather than typing them, two sources suggest pages, filtered to ones you don't
already have:

- **Your most-visited pages**, from Plausible's top-pages breakdown — already
  fetched for the analytics panel, and the best proxy for "worth auditing".
- **The sitemap** — loaded on request (it is an outbound fetch that may pull child
  sitemaps, so it does not run on every page view). Handles sitemap indexes.
  `home-assistant.io` yields 4,040 URLs this way.

Gotcha worth knowing: host filtering ignores `www.`. Without that,
`home-assistant.io`'s sitemap looks **empty** — the site redirects to `www.`, so
every `<loc>` carries the www host while the configured url does not, and a strict
comparison discards all 4,040 URLs while reporting a valid sitemap as containing
none.

Only entries in the `sites` array can be edited. A site that came from the
`domains` shorthand has no object to update, and saving says so rather than
quietly creating a duplicate.

## Performance

Upstream reads go through a stale-while-revalidate cache
(`src/lib/cache.ts`). Measured before and after, in the container:

| | before | after (warm) |
|---|---|---|
| `GET /` | 1,256ms | **~150ms** |
| `GET /sites/<slug>` | 623ms | **~140ms** |
| stale entries | — | ~100ms, refreshed in the background |

The reasoning: nothing was cached, so every render waited on Plausible (six
calls per site page), Netlify and GitHub — while **freshness finer than about a
minute is illusory for these sources**. Plausible's realtime figure is a
5-minute window, its stats are aggregated with delay, and deploys and pull
requests move on the order of minutes. Holding results briefly costs almost no
accuracy.

TTLs live together in `TTL` in that file: analytics and activity 60s, realtime
20s, Cloudflare zones 1h, Netlify site resolution effectively permanent for a
session. A stale entry is returned **immediately** and refreshed out of band, so
only the very first call for a key ever blocks.

Three deliberate details:

- **`unconfigured` results are never cached.** They involve no network call, and
  caching one would keep reporting "not configured" for a minute after you add
  the token.
- **Errors are cached for 15s only** — long enough not to hammer a broken
  upstream, short enough to recover quickly.
- **Saving a token calls `invalidateAll()`**, so a cached auth failure can't
  outlive the fix.

Measured upstream costs, for reference: Plausible query 151ms, Cloudflare zone
list 531ms, Netlify site lookup 707ms (the slowest, and resolution may try two),
`gh pr list` 893ms of which only ~100ms is the subprocess.

One assumption worth recording as **wrong**: batching GitHub into a single
GraphQL request measured *slower* (3,244ms for three repos) than the existing
per-repo `gh` calls run in parallel (893ms each). The subprocess is not the
bottleneck; GitHub is. Don't "optimise" that without measuring again.

## Configuration precedence

Three layers, highest first: **`data/secrets.json`** (written by Settings) →
**`process.env`** (Docker) → **the `.env` file**. The settings page reports which
one is in effect per field, and only ever shows a secret's *length*, never any part
of its value.

## How it works

- **Astro 7** with `@astrojs/node` in **middleware** mode, `output: 'server'`.
  Every page reads live data, so nothing is prerendered. `server/index.mjs` owns
  the HTTP server — see the WebSocket note below for why — which also means it
  serves `dist/client` itself, because middleware mode does not.
- **No database.** State is flatfile JSON under `data/`, which is bind-mounted so
  it survives rebuilds. `src/lib/store.ts` writes through a temp file and renames,
  so an interrupted write can't leave truncated JSON.
- **Providers** (`src/lib/providers/`) each return a `PanelResult` — `ok`,
  `unconfigured`, or `error` — instead of throwing. That's what lets one missing
  token degrade a single panel rather than the whole page.
- **GitHub goes through the `gh` CLI**, not REST. `gh pr list --json
  statusCheckRollup` returns every PR *and* the status of all its CI jobs in one
  call; the REST equivalent is one request per PR.
- **Cloudflare, Netlify and Plausible go through REST.** `wrangler` has no
  cache-purge command, and a purge is a single POST.
- **Charts** are server-rendered inline SVG using a single sequential hue, with
  the fixed status palette (icon + label, never colour alone) for CI and deploy
  state. Every chart has a table view, so no value is reachable only by hovering.

## Things worth knowing

- **Nothing is cached — and Plausible's relative ranges exclude today.** Pages
  are rendered on demand with no cache layer and no cache headers, so every
  refresh re-queries the APIs. But Plausible's presets (`7d`, `28d`, …) return a
  window ending *yesterday*: on 2026-08-04, `7d` meant 07-28 → 08-03. That made
  the dashboard look frozen, because today's traffic was invisible and the
  headline only moved at midnight. `toApiDateRange()` in
  `src/lib/providers/plausible.ts` therefore sends an explicit `[start, today]`
  pair for every finite range. On the day it was found this was the difference
  between 540 and 1,670 visitors. Windows are computed in **UTC**, matching the
  timezone the Plausible instance echoes back; a site configured in another
  timezone could be off by one boundary day.
- **WebSockets forced middleware mode, and the bus lives on `globalThis`.** The
  standalone adapter owns its HTTP server and never exposes it, so there is
  nowhere to handle the upgrade — hence `server/index.mjs`. Two consequences that
  look odd until you know why:
  - `server/websocket.mjs` is plain Node, outside Astro's bundle, so importing
    `src/lib/live.ts` there would hand it a *second, unconnected copy* of the
    registry. The bus hangs off `globalThis` so both module graphs share one
    instance. Keep the shape in those two files in step.
  - The `upgrade` handler **must `return` without destroying the socket** for any
    path that isn't `/ws`. In dev, Vite's HMR client upgrades on that same event,
    and destroying the socket silently kills hot reload.
- **The Playwright image tag and the npm package must match exactly.** The base
  image in `docker/Dockerfile` is `mcr.microsoft.com/playwright:v1.62.1-noble`
  and `playwright` in package.json is pinned to `1.62.1` — no caret. A caret range
  would eventually resolve to a version expecting a browser build that isn't in
  the image. Bump both together or neither. Chromium also needs `shm_size: "1gb"`
  in both compose files; it crashes on Docker's default 64MB `/dev/shm`.
- **Editing `.env` no longer needs a container recreate.** Docker only reads
  `env_file` when a container is *created*, so a long-running dev container keeps
  the environment it started with and every panel insists the token is missing.
  That trap cost real time three separate times, so `src/lib/env.ts` now falls
  back to parsing the `.env` **file** (bind-mounted, re-read on mtime change) when
  a variable is absent from `process.env`. Real environment variables still win.
  The dev instance therefore picks up new tokens immediately; for the prod
  instance, `docker compose up -d --force-recreate` is still the tidy way to
  apply them.
- **Netlify site ids resolve automatically — and don't trust `GET /sites`.** That
  endpoint returns an **empty array** for this token even though the sites exist
  and are readable individually (they live under "Home Assistant" and "ESPHome"
  accounts the token cannot enumerate). Taking that empty list at face value led
  to the wrong conclusion that Netlify wasn't in use at all.

  `candidatesFor()` in `src/lib/providers/netlify.ts` therefore resolves by
  **domain**: Netlify accepts a hostname in place of a UUID, so no ids need
  pasting in. It also tries the `www` variant, which is load-bearing —
  `handbook.openhomefoundation.org` resolves directly, but the bare
  `openhomefoundation.org` 404s because Netlify knows that site as
  `www.openhomefoundation.org`.

  A *derived* id that 404s is reported as "not on Netlify" (neutral) rather than
  an error, because a site simply not being hosted there is not a fault. Only an
  explicitly configured `netlify.siteId` that 404s is a real misconfiguration.

  **A resolved site is then verified to actually serve the domain**, and this is
  not paranoia. Looking up one of our domains returned a site in an unrelated
  third party's account, serving a completely different domain and last deployed
  years ago — Netlify's identifier lookup matches more loosely than
  "this domain belongs to this site". Without the check, the dashboard showed a
  stranger's deploy history as ours, and it looked entirely plausible apart from
  the dates. `serves()` compares the hostname against `custom_domain`,
  `domain_aliases`, the `*.netlify.app` name and the site urls, ignoring `www.`;
  a site that fails is skipped and named in the message.

  Set `netlify.enabled: false` (or untick "Deployed on Netlify" when editing a
  site) for anything not hosted there, so the panel stays quiet.
- **Subdomains share their parent's Cloudflare zone.** `handbook.` and `sotoh.`
  sit inside the `openhomefoundation.org` zone, so they legitimately share a zone
  id — which means **purge-everything on one clears all three**. The site page
  detects shared zones and says so before you press the button; purge-by-URL stays
  correctly scoped.
- **Netlify build logs link out rather than render inline.** Netlify publishes no
  documented API for build log text. Deploy state, timing, commit and
  `error_message` all come from the API; the "Build log" button deep-links into
  Netlify's UI. Scraping an undocumented route would break without warning.
- **The dev server needs file-watch polling.** Docker Desktop on Windows doesn't
  forward inotify events across a bind mount, so edits reach the container but
  Vite never notices. `astro.config.mjs` sets `vite.server.watch.usePolling`.
  Without it, hot reload silently stops working.
- **Never start the dev server with `astro dev --force`.** Astro 7 records its PID
  in `.astro/dev.json`, which lives in the bind mount and outlives the container.
  `--force` SIGTERMs whatever PID is in that file — and in a fresh container's PID
  namespace that low PID has been reassigned to the new node process, so Astro
  kills itself and the container exits 143. The compose command deletes the stale
  lock instead.
- **POSTs are origin-checked.** Astro rejects form posts whose `Origin` doesn't
  match with a 403. Browsers always send it; command-line clients need it added
  explicitly. This is intentional CSRF protection — leave it on.
- **Purge everything asks for confirmation.** It's recoverable (the origin refills
  the cache) but it does cause a brief spike in origin load.

## Site tests

Four runners, on each site's page. All of them drive the Chromium that ships in
the Playwright base image.

| Test | What it does |
|---|---|
| **Lighthouse audit** | Performance / accessibility / best-practices / SEO, each selectable. Desktop or mobile form factor. Scores, core metrics, and a per-run **deep dive** (see below) |
| **Screenshots** | Full-page PNGs at desktop (1440×900) and mobile (390×844, 3× DPR), for one page or all of them |
| **Scroll-through video** | WebM of one page scrolled top to bottom, in small increments so scroll-driven effects actually fire |
| **Scroll performance** | Frame timing and main-thread blocking during scroll, aimed at the image-sequence sections |

**Runs are serialised.** Each launches a browser, and several at once is the
quickest way to exhaust memory. A run started while another is in flight sits in
`queued`.

### Watching a run live

Progress streams over a WebSocket at `/ws`, same origin and port in both dev and
production. While a run executes you get a timestamped log (which page is
loading, which category scored what) and, optionally, **a live view of the
browser** via a CDP screencast.

The runs table also refreshes itself over the socket the moment any run finishes
— including a run started in another tab — by re-fetching the page and swapping
in just that section, so there is no second copy of the run list in client JS and
no polling.

**"Watch live" is off by default for audits.** Streaming frames is real work for
the browser and can move performance timings, so for Lighthouse the log is the
signal and the video is opt-in. It is on by default for screenshots and video,
where the browser view is the point.

Completed runs keep their log on the saved record, under a `Log` disclosure in
the runs table.

Results and artifacts persist under `data/runs/<slug>/` and
`data/artifacts/<slug>/<run-id>/`, both gitignored, and are served through
`/api/artifacts/...` — which resolves every path inside the artifacts root and
refuses anything escaping it.

### The audit deep dive

Every audit run gets its own page — the **Deep dive** button in the runs table,
at `/sites/<slug>/runs/<run-id>`. It answers "why did this fail, and which
element?":

- **An LCP panel**: the total, a stacked breakdown of the four phases (time to
  first byte / resource load delay / load duration / element render delay) so you
  can see *where* the time went, the LCP element itself as a cropped screenshot
  with the selector and HTML, and the request-discovery checklist
  (`fetchpriority=high` applied? discoverable in the initial document? not
  lazy-loaded?).
- **Findings grouped by category**, each with Lighthouse's own explanation, the
  metric savings it attributes to fixing it, a table of affected items, and **a
  cropped screenshot of every offending element with a highlight box** plus its
  selector, HTML snippet and element-specific reason — e.g. *"insufficient
  colour contrast of 2.62 (foreground #03a9f4, background #ffffff). Expected
  4.5:1"*.

Two implementation notes that are easy to get wrong:

- **Lighthouse 13 renamed these audits to "insights".**
  `largest-contentful-paint-element`, `prioritize-lcp-image` and
  `lcp-lazy-loaded` no longer exist; the real ids are `lcp-breakdown-insight` and
  `lcp-discovery-insight`. Using the old names yields an empty panel, silently.
- **Element crops use `fullPageScreenshot.nodes`, not the item's
  `boundingRect`.** They are different coordinate spaces. Measured on one
  element: `boundingRect` said `top:334,left:8` while the screenshot rect said
  `top:256,left:90` — same size, different origin. Cropping with `boundingRect`
  shows the wrong part of the page and looks plausible while being wrong.

Cropping is pure CSS — the full-page screenshot is offset inside a clipping box —
so there is no native image dependency in the container.

### Reading the scroll-performance numbers

**Frame rate from headless Chromium is indicative, not a device measurement.**
There is no real compositor or display refresh, so it reports a suspiciously
tidy ~60fps unless something blocks the main thread. Treat it as a
run-to-run comparison for the same page, never as "what users get".

The number to trust is **blocking** (long tasks during scroll), which reproduces
reliably in headless and is what actually makes an image-sequence scroller feel
bad. The `Images` column is the companion signal: it counts image requests that
completed *during* the scroll, so a high count on a sequence page means frames
are arriving late.

Budgets are heuristics, set in `src/lib/tests/interaction.ts`: p95 frame ≤ 50ms
and ≤ 1,500ms total blocking. Argue with them freely.

## Not built yet

**Type checking.** `@astrojs/check` is at 0.9.x and peer-deps on TypeScript 5,
while current TypeScript is 7.x, so it was left out to keep the install clean.
Worth revisiting.
