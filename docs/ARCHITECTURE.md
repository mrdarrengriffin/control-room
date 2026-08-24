# Architecture & implementation notes

Everything about *how* Control Room works and *why* it works that way. If you
only want to run it, the [README](../README.md) is the whole story.

Much of this file is a record of things that were surprising, wrong at first, or
easy to get wrong again. Where a decision looks odd, the reason is written down
next to it.

## Contents

- [The stack](#the-stack)
- [Design system](#design-system)
- [Authentication](#authentication)
- [Configuration precedence](#configuration-precedence)
- [Site discovery](#site-discovery)
- [The sidebar](#the-sidebar)
- [Auto-refreshing regions](#auto-refreshing-regions)
- [Live visitor counts](#live-visitor-counts)
- [Caching & performance](#caching--performance)
- [Test pages and sitemaps](#test-pages-and-sitemaps)
- [Test runners](#test-runners)
- [The audit deep dive](#the-audit-deep-dive)
- [Reading the scroll-performance numbers](#reading-the-scroll-performance-numbers)
- [Provider gotchas](#provider-gotchas)
- [Container gotchas](#container-gotchas)
- [Self-update](#self-update)
- [No example data, ever](#no-example-data-ever)
  - [The `sites.json` format](#the-sitesjson-format)
- [Not built yet](#not-built-yet)

## The stack

- **Astro 7** with `@astrojs/node` in **middleware** mode, `output: 'server'`.
  Every page reads live data, so nothing is prerendered. `server/index.mjs` owns
  the HTTP server — see [WebSockets](#websockets-forced-middleware-mode) for why
  — which also means it serves `dist/client` itself, because middleware mode
  does not.
- **No database.** State is flatfile JSON under `data/`, bind-mounted so it
  survives rebuilds. `src/lib/store.ts` writes through a temp file and renames,
  so an interrupted write can't leave truncated JSON.
- **Providers** (`src/lib/providers/`) each return a `PanelResult` — `ok`,
  `unconfigured` or `error` — instead of throwing. That is what lets one missing
  token degrade a single panel rather than the whole page.
- **GitHub goes through the `gh` CLI**, not REST. `gh pr list --json
  statusCheckRollup` returns every PR *and* the status of all its CI jobs in one
  call; the REST equivalent is one request per PR.
- **Cloudflare, Netlify and Plausible go through REST.** `wrangler` has no
  cache-purge command, and a purge is a single POST.
- **Charts** are server-rendered inline SVG. Every chart has a table view, so no
  value is reachable only by hovering.

### Layout

```
server/          Plain Node: HTTP server, static files, WebSocket, session verify
src/lib/         Providers, caching, auth, storage, discovery
src/lib/tests/   Lighthouse, Playwright capture, screencast, scroll timing
src/components/  Server-rendered Astro components (no client framework)
src/pages/       Routes and API endpoints
data/            Runtime state — gitignored, bind-mounted
docker/          Dockerfile and entrypoint
deploy/          The compose file end users download
```

## Design system

The chrome follows the **shadcn/ui** design language — neutral zinc surfaces,
hairline borders, `rounded-lg` cards with a whisper of shadow, 36px controls, a
near-black primary, focus-visible rings — implemented as **plain CSS custom
properties** in `src/styles/app.css`. No Tailwind and no React: nearly all of
this UI is server-rendered markup, and Radix only earns its keep for widgets
this app doesn't have (command palette, combobox, complex dialogs).

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

> [!IMPORTANT]
> Changing the surfaces means the chart palette has to be re-checked, not
> assumed. Run `validate_palette.js` against the new surface before shipping a
> theme change. On the current one the ordinal ramp cleared its light end at
> **2.11:1 on white** and **3.28:1 on the dark card**.

The validator's categorical checks do not apply to the status palette — it is
fixed by design, and its two sub-3:1 colours are mitigated by the icon + label
pairing every status pill carries.

## Authentication

On first run every page redirects to `/setup` to set a single admin password,
stored as an scrypt hash (`{N:16384, r:8, p:1}`, 64-byte key) in
`data/auth.json` alongside a per-install session secret. **There is no reset**;
delete the file to start over.

Sessions are stateless signed cookies (httpOnly, SameSite=Lax, 30 days), so
restarts don't sign you out, and changing the password rotates the secret and
ends every session at once.

Three details that matter:

- **`/ws` is gated separately.** Astro's middleware only sees HTTP routes — an
  upgrade request never reaches it — so the WebSocket server verifies the same
  cookie itself and closes unauthenticated upgrades with a 401. Both sides share
  one implementation in `server/session.mjs` rather than keeping two copies of
  security-critical code in step.
- **API routes answer `401`, they don't redirect.** A redirect would return the
  login page's HTML with a 200, and the auto-refresh would splice that into the
  page instead of noticing it had been signed out.
- **`/api/health` is deliberately open** — a healthcheck has no session — and
  reports only liveness and whether setup is pending.

POSTs are origin-checked: Astro rejects form posts whose `Origin` doesn't match
with a 403. Browsers always send it; command-line clients need it added
explicitly. This is intentional CSRF protection — leave it on.

## Configuration precedence

Three layers, highest first:

| Layer | Source | Set by |
|---|---|---|
| 1 | `data/secrets.json` | The Settings page |
| 2 | `process.env` | Docker / compose |
| 3 | `.env` file | Hand-edited, re-read on mtime change |

The settings page reports which layer is in effect per field, and only ever
shows a secret's *length* — never any part of its value.

> [!NOTE]
> **Layer 3 exists because of a real trap.** Docker only reads `env_file` when a
> container is *created*, so a long-running dev container keeps the environment
> it started with and every panel insists the token is missing. That cost real
> time three separate times, so `src/lib/env.ts` falls back to parsing the
> `.env` **file** when a variable is absent from `process.env`. Real environment
> variables still win. The dev instance therefore picks up new tokens
> immediately; for prod, `docker compose up -d --force-recreate` is the tidy way.

## Site discovery

`src/lib/discover.ts` takes a URL and asks each connected service what it knows,
**cheapest and most authoritative first**:

1. **Cloudflare** — match the hostname against the zone list. Longest match
   wins, so a subdomain prefers its own zone over the parent's.
2. **Netlify** — look the site up by domain (with the `www` toggle). Crucially
   this also returns `build_settings.repo_url`, so **Netlify usually tells you
   the GitHub repo** — a far better answer than searching by name.
3. **Plausible** — probe the domain against the default instance *and every
   other instance already in use*, so a site on a second Plausible install is
   found without being told about it.
4. **GitHub** — only as a fallback when Netlify didn't say. Results are filtered
   to owners you belong to: searching "home-assistant.io" otherwise returns a
   pile of unrelated community projects.

Anything guessed is **labelled as a guess** and shown for confirmation before
it's saved — the repo field in particular, since a name match is not proof.

### Editing

`/sites/<slug>/edit` exposes name, URL, description, tags, every integration id
and both page lists.

- **Look up missing details** re-runs discovery and fills only the fields that
  are currently empty — the answer to "I forgot to add the GitHub repo".
- **The slug is immutable.** Saved runs live in `data/runs/<slug>/` and
  artifacts in `data/artifacts/<slug>/`, so renaming would orphan a site's whole
  history.
- Keys added to `sites.json` by hand are preserved across a save from the UI.
- **Remove site** deletes the registry entry only; runs and artifacts stay.
- Only entries in the `sites` array can be edited. A site that came from the
  `domains` shorthand has no object to update, and saving says so rather than
  quietly creating a duplicate.

## The sidebar

Pinned to the viewport with its own scroll, so a long site list never pushes
Settings out of reach. Each site shows its **favicon**, cached under
`data/favicons/` for 7 days.

> [!NOTE]
> Favicons are fetched **by this server, not by a third-party favicon service**.
> Google's and DuckDuckGo's endpoints would work, but they would send the full
> list of sites you monitor to someone else on every page load — the wrong trade
> for a local-first dashboard, and for an org self-hosting analytics precisely
> to avoid that.

The page's `<link rel="icon">` tags are preferred (scalable and
apple-touch-icon score highest) with `/favicon.ico` as the fallback, and a
lettered square if nothing can be had, so a broken image never appears.

### Labels

Configured `name` values drift — some hand-written, some derived from a domain —
so the sidebar labels each site by its **own page title** by default, read once
and cached to `data/site-meta.json` for 7 days. **Settings → Display** switches
the whole sidebar to domains instead.

Raw titles are mostly marketing copy ("BTHome: Open standard for broadcasting
sensor data over Bluetooth"), so the tagline is trimmed at the first `:`, `|`,
`–` or `—`.

> [!WARNING]
> A plain hyphen is deliberately **not** a separator. It occurs inside real
> names, and one site here titles its page "Sign In - OHF Employee Handbook"
> (the handbook is behind auth), where splitting would leave the useless
> "Sign In".

## Auto-refreshing regions

Anything marked `data-live-region` re-renders every 30 seconds:
`src/components/AutoRefresh.astro` re-fetches the current URL and swaps just
those elements. Re-fetching the page rather than adding JSON endpoints keeps one
copy of the rendering logic, and with the SWR cache a refresh costs ~150ms.

Three details that stop it being annoying:

- Identical markup is not swapped, so open `<details>` don't collapse for
  nothing.
- A region containing the focused element is skipped.
- Disclosure state is restored after a swap.

One-shot query params (`flash`, `message`, `sitemap`, `discover`) are stripped
from the refresh URL so messages don't reappear and expensive lookups don't
re-run.

## Live visitor counts

The sidebar shows how many people are on each site right now, with a total
beside "All sites". Sites with no analytics show no number at all, so the nav
stays quiet — but a site *with* Plausible shows `0`, because "nobody on right
now" and "not measured" are different facts and shouldn't look identical.

> [!NOTE]
> This uses Plausible's **v1** `/api/v1/stats/realtime/visitors` endpoint on
> purpose, not by oversight. The v2 query API has no realtime equivalent — both
> `date_range: "realtime"` and `"30m"` are rejected with 400 "Invalid date
> range". v1 returns a bare integer.

Counts are cached for 20 seconds inside the provider. The sidebar renders on
every page, so without that each navigation would fire one request per site. Any
failure yields no number — an analytics problem must never put an error in the
navigation.

Badges refresh every 20 seconds from `/api/live`, and one whose number changed
gets a brief colour wash so movement is noticeable without being distracting
(suppressed under `prefers-reduced-motion`; the badge's size and shape never
change). Polling pauses while the tab is hidden and catches up on return.

This one is **polled rather than pushed** over `/ws`, even though the socket
already exists: the WebSocket server is plain Node *outside* Astro's bundle and
cannot reach the Plausible provider, and the server-side 20s cache already
bounds upstream requests no matter how many tabs are open.

## Caching & performance

Upstream reads go through a stale-while-revalidate cache (`src/lib/cache.ts`).
Measured before and after, in the container:

| | before | after (warm) |
|---|---|---|
| `GET /` | 1,256ms | **~150ms** |
| `GET /sites/<slug>` | 623ms | **~140ms** |
| stale entries | — | ~100ms, refreshed in the background |

The reasoning: nothing was cached, so every render waited on Plausible (six
calls per site page), Netlify and GitHub — while **freshness finer than about a
minute is illusory for these sources.** Plausible's realtime figure is a
5-minute window, its stats are aggregated with delay, and deploys and pull
requests move on the order of minutes.

TTLs live together in `TTL`: analytics and activity 60s, realtime 20s,
Cloudflare zones 1h, Netlify and Plausible site resolution effectively permanent
for a session. A stale entry is returned **immediately** and refreshed out of band, so
only the very first call for a key ever blocks.

Four deliberate details:

- **`unconfigured` results are never cached.** They involve no network call, and
  caching one would keep reporting "not configured" for a minute after you add
  the token.
- **Errors are cached for 15s only** — long enough not to hammer a broken
  upstream, short enough to recover quickly.
- **Saving a token calls `invalidateAll()`**, so a cached auth failure can't
  outlive the fix.
- **Concurrent callers of a cold key share one request.** The stale path always
  had this via `refreshing`; the cold path did not, and a fanned-out page is
  where it bites. A site page asks for seven Plausible panels *and* the site-id
  resolution at once, all eight needing the same resolution — eight round trips
  to learn one fact, and a measured **4.3s** first render. With the in-flight map
  it is one request and **~470ms**, of which most is Vite compiling the route:
  cold data on an already-compiled route is ~120ms.

Measured upstream costs, for reference: Plausible query 151ms, Cloudflare zone
list 531ms, Netlify site lookup 707ms (the slowest, and resolution may try two),
`gh pr list` 893ms of which only ~100ms is the subprocess.

> [!WARNING]
> One assumption worth recording as **wrong**: batching GitHub into a single
> GraphQL request measured *slower* (3,244ms for three repos) than the existing
> per-repo `gh` calls run in parallel (893ms each). The subprocess is not the
> bottleneck; GitHub is. Don't "optimise" that without measuring again.

## Test pages and sitemaps

Each site page has a **Test pages** card with two lists — `testPages` (audited
and captured by default) and `interactivePages` (scroll-driven sections, where
the scroll-performance test aims). Both are editable in place; full URLs are
accepted and reduced to paths.

Two sources suggest pages, filtered to ones you don't already have:

- **Your most-visited pages**, from Plausible's top-pages breakdown — already
  fetched for the analytics panel, and the best proxy for "worth auditing".
- **The sitemap** — loaded on request, since it is an outbound fetch that may
  pull child sitemaps. Handles sitemap indexes; `home-assistant.io` yields 4,040
  URLs.

> [!WARNING]
> Host filtering ignores `www.`, and that is load-bearing. Without it,
> `home-assistant.io`'s sitemap looks **empty**: the site redirects to `www.`, so
> every `<loc>` carries the www host while the configured url does not, and a
> strict comparison discards all 4,040 URLs while reporting a valid sitemap as
> containing none.

## Test runners

Four runners, all driving the Chromium that ships in the Playwright base image.

**Runs are serialised.** Each launches a browser, and several at once is the
quickest way to exhaust memory. A run started while another is in flight sits in
`queued`.

Progress streams over a WebSocket at `/ws`, same origin and port in dev and
production. While a run executes you get a timestamped log and, optionally, a
live view of the browser via a CDP screencast.

> [!NOTE]
> **"Watch live" is off by default for audits.** Streaming frames is real work
> for the browser and can move performance timings, so for Lighthouse the log is
> the signal and the video is opt-in. It is on by default for screenshots and
> video, where the browser view is the point.

The runs table also refreshes over the socket the moment any run finishes —
including a run started in another tab — by re-fetching the page and swapping in
just that section. No second copy of the run list in client JS, no polling.

Results and artifacts persist under `data/runs/<slug>/` and
`data/artifacts/<slug>/<run-id>/`, served through `/api/artifacts/...`, which
resolves every path inside the artifacts root and refuses anything escaping it.

## The audit deep dive

Every audit run gets a page at `/sites/<slug>/runs/<run-id>` answering "why did
this fail, and which element?":

- **An LCP panel** — the total, a stacked breakdown of the four phases (time to
  first byte / resource load delay / load duration / element render delay) so
  you can see *where* the time went, the LCP element as a cropped screenshot
  with its selector and HTML, and the request-discovery checklist
  (`fetchpriority=high` applied? discoverable in the initial document? not
  lazy-loaded?).
- **Findings grouped by category**, each with Lighthouse's own explanation, the
  metric savings it attributes to fixing it, a table of affected items, and **a
  cropped screenshot of every offending element with a highlight box** plus its
  selector, HTML snippet and element-specific reason — e.g. *"insufficient
  colour contrast of 2.62 (foreground #03a9f4, background #ffffff). Expected
  4.5:1"*.

Two implementation notes that are easy to get wrong:

> [!WARNING]
> **Lighthouse 13 renamed these audits to "insights".**
> `largest-contentful-paint-element`, `prioritize-lcp-image` and
> `lcp-lazy-loaded` no longer exist; the real ids are `lcp-breakdown-insight`
> and `lcp-discovery-insight`. Using the old names yields an empty panel,
> **silently**.

> [!WARNING]
> **Element crops use `fullPageScreenshot.nodes`, not the item's
> `boundingRect`.** They are different coordinate spaces. Measured on one
> element: `boundingRect` said `top:334,left:8` while the screenshot rect said
> `top:256,left:90` — same size, different origin. Cropping with `boundingRect`
> shows the wrong part of the page and looks plausible while being wrong.

Cropping is pure CSS — the full-page screenshot is offset inside a clipping box
— so there is no native image dependency in the container.

## Reading the scroll-performance numbers

> [!CAUTION]
> **Frame rate from headless Chromium is indicative, not a device measurement.**
> There is no real compositor or display refresh, so it reports a suspiciously
> tidy ~60fps unless something blocks the main thread. Treat it as a
> run-to-run comparison for the same page, never as "what users get".

The number to trust is **blocking** (long tasks during scroll), which reproduces
reliably in headless and is what actually makes an image-sequence scroller feel
bad. The `Images` column is the companion signal: it counts image requests that
completed *during* the scroll, so a high count on a sequence page means frames
are arriving late.

Budgets are heuristics, set in `src/lib/tests/interaction.ts`: p95 frame ≤ 50ms
and ≤ 1,500ms total blocking. Argue with them freely.

## Provider gotchas

### Plausible's relative ranges exclude today

Plausible's presets (`7d`, `28d`, …) return a window ending *yesterday*: on
2026-08-04, `7d` meant 07-28 → 08-03. That made the dashboard look frozen,
because today's traffic was invisible and the headline only moved at midnight.

`toApiDateRange()` therefore sends an explicit `[start, today]` pair for every
finite range. On the day it was found this was the difference between **540 and
1,670 visitors**. Windows are computed in **UTC**, matching the timezone the
Plausible instance echoes back; a site configured in another timezone could be
off by one boundary day.

### Plausible's 401 covers two very different causes

`401 Invalid API key or site ID` is returned both for a bad key **and** for a
site id the key cannot see. One message, two causes — and it has sent debugging
down the wrong path twice.

The first time, five fictional example sites were being queried, so the settings
page reported a **valid key as invalid** (see
[No example data, ever](#no-example-data-ever)). The second time, the registry
loader filled in a missing `plausible.domain` with `?? parsedUrl.hostname`. That
reads as obviously correct — a Plausible site id *is* a domain — but it commits
to one spelling: `https://www.openhomefoundation.org` became the site id
`www.openhomefoundation.org`, while the install knows that site as
`openhomefoundation.org`. Every panel 401'd, the Debug log filled with what
looked exactly like an auth failure, and the key, the instance and the account
were all perfect. The edit form then offered the wrong value pre-filled, ready to
be saved.

Two things follow, and the second is the one that matters:

- **`plausible.domain` is optional and never invented.** When the registry
  doesn't name one, `resolveSiteId()` tries the site's hostname *and* its `www`
  counterpart and caches which one the install answered to for 24h — the same
  toggling the Netlify provider already does, for the same reason. A site added
  before the Plausible key was configured therefore starts working on its own,
  instead of sitting blank until someone re-runs discovery.
- **Deriving a value is fine; presenting a derived value as a declared one is
  not.** The registry loader now leaves `plausible` undefined rather than
  guessing, so "what you told us" and "what we worked out" stay distinguishable.
  The Debug page's site-id table shows which of the two each site is using, and
  says so when the resolved id differs from what `sites.json` claims.

Once the spelling has been resolved, a 401 really is the key or the account, so
that is what the message now says. A 401 for *both* spellings names both, rather
than blaming the key alone.

### Netlify: don't trust `GET /sites`

That endpoint returns an **empty array** for our token even though the sites
exist and are readable individually — they live under accounts the token cannot
enumerate. Taking that empty list at face value led to the wrong conclusion that
Netlify wasn't in use at all.

`candidatesFor()` therefore resolves by **domain**: Netlify accepts a hostname
in place of a UUID, so no ids need pasting in. It also tries the `www` variant,
which is load-bearing — `handbook.openhomefoundation.org` resolves directly, but
the bare `openhomefoundation.org` 404s because Netlify knows that site as
`www.openhomefoundation.org`.

A *derived* id that 404s is reported as "not on Netlify" (neutral) rather than
an error, because a site simply not being hosted there is not a fault. Only an
explicitly configured `netlify.siteId` that 404s is a real misconfiguration.

> [!CAUTION]
> **A resolved site is then verified to actually serve the domain, and this is
> not paranoia.** Looking up one of our domains returned a site in an unrelated
> third party's account, serving a completely different domain and last deployed
> years ago — Netlify's identifier lookup matches more loosely than "this domain
> belongs to this site". Without the check, the dashboard showed a stranger's
> deploy history as ours, and it looked entirely plausible apart from the dates.

`serves()` compares the hostname against `custom_domain`, `domain_aliases`, the
`*.netlify.app` name and the site urls, ignoring `www.`; a site that fails is
skipped and named in the message. Set `netlify.enabled: false` (or untick
"Deployed on Netlify" when editing a site) for anything not hosted there.

### Netlify build logs link out rather than render inline

Netlify publishes no documented API for build log text. Deploy state, timing,
commit and `error_message` all come from the API; the "Build log" button
deep-links into Netlify's UI. Scraping an undocumented route would break without
warning.

### Subdomains share their parent's Cloudflare zone

`handbook.` and `sotoh.` sit inside the `openhomefoundation.org` zone, so they
legitimately share a zone id — which means **purge-everything on one clears all
three**. The site page detects shared zones and says so before you press the
button; purge-by-URL stays correctly scoped.

## Container gotchas

### WebSockets forced middleware mode

The standalone adapter owns its HTTP server and never exposes it, so there is
nowhere to handle the upgrade — hence `server/index.mjs`. Two consequences that
look odd until you know why:

- `server/websocket.mjs` is plain Node, outside Astro's bundle, so importing
  `src/lib/live.ts` there would hand it a *second, unconnected copy* of the
  registry. The bus hangs off `globalThis` so both module graphs share one
  instance. **Keep the shape in those two files in step.**
- The `upgrade` handler **must `return` without destroying the socket** for any
  path that isn't `/ws`. In dev, Vite's HMR client upgrades on that same event,
  and destroying the socket silently kills hot reload.

### The Playwright image tag and the npm package must match exactly

The base image is `mcr.microsoft.com/playwright:v1.62.1-noble` and `playwright`
in `package.json` is pinned to `1.62.1` — no caret. A caret range would
eventually resolve to a version expecting a browser build that isn't in the
image. **Bump both together or neither.**

Chromium also needs `shm_size: "1gb"` in every compose file; it crashes on
Docker's default 64MB `/dev/shm`.

### The dev server needs file-watch polling

Docker Desktop on Windows doesn't forward inotify events across a bind mount, so
edits reach the container but Vite never notices. `astro.config.mjs` sets
`vite.server.watch.usePolling`. Without it, hot reload silently stops working.

### Never start the dev server with `astro dev --force`

Astro 7 records its PID in `.astro/dev.json`, which lives in the bind mount and
outlives the container. `--force` SIGTERMs whatever PID is in that file — and in
a fresh container's PID namespace that low PID has been reassigned to the new
node process, so **Astro kills itself and the container exits 143**. The compose
command deletes the stale lock instead.

### Multi-arch images are built on native runners, not emulated

`.github/workflows/publish.yml` builds `linux/amd64` on `ubuntu-24.04` and
`linux/arm64` on `ubuntu-24.04-arm`, each pushing **by digest with no tag**, and
a final job stitches the digests into one tagged manifest list.

The obvious alternative — one job with `platforms: linux/amd64,linux/arm64` —
means QEMU for the second architecture, and emulating an `npm install` plus an
Astro build on top of a ~2.8GB Playwright base is slow enough to risk timing the
job out. ARM runners are free for public repositories, so there is no reason to
emulate.

> [!WARNING]
> The per-arch jobs must **not** push tags. Two jobs pushing `:main` would
> overwrite each other and the result would be single-arch — whichever finished
> last. Tagging happens only in the merge job.

The build cache is scoped per platform (`scope=${{ matrix.platform }}`);
sharing one scope has the two builds evict each other every run.

### Nothing is written into the data directory at startup

The container creates no files on boot. A new install has an empty `data/` and
an empty dashboard, and the first write happens when someone sets a password.

This is worth stating because it briefly wasn't true, and the failure was
instructive — see [No example data, ever](#no-example-data-ever).

## Self-update

The Settings page can update a production install in place: when the image tag
this install follows has moved on, the sidebar shows a quiet notice and
Settings offers **Update now**. Two halves, deliberately separated:

**Noticing** (`src/lib/update.ts`) asks the registry a narrow question: *does
the tag I was started from point at a different image than the one I am?* The
publish workflow stamps every image with its git sha — as the
`org.opencontainers.image.revision` label and as `CONTROL_ROOM_BUILD_SHA` in
the environment — and the check compares the two: anonymous pull token →
manifest for the followed tag → this machine's arch entry (buildx attestation
manifests report their platform as `unknown`, so match real os/arch rather than
taking the first) → config blob → labels.

Framing it as "has the tag moved" rather than "is there a newer release" makes
pinning behave correctly for free: `latest` updates on releases, `main` on
every push, `1.2` on patch releases, and an exact `1.2.3` pin reports up to
date forever, because a pinned tag never moves — which is what pinning means.
An exact pin short-circuits before any network call: the answer is known
before the question, and it spares installs pinned to a pre-label release a
permanent "image predates update checks" error for a tag that will never be
republished.
The compose file passes `CONTROL_ROOM_TAG` *into* the container for this; a
container run some other way defaults to comparing against `latest`, so set the
variable if you follow anything else.

Three consequences of the check rendering in the sidebar on every page:

- Registry calls use a 5s timeout, and **failures are cached for 10 minutes**
  rather than the usual 15s error TTL — with the short TTL, a dead registry
  would re-block a page render every 15 seconds.
- A source checkout short-circuits to `unconfigured` before any network call
  (no baked sha, nothing to compare), so dev servers never talk to GHCR.
- Anything other than a definite "yes" renders nothing in the navigation. An
  update check must never put an error in the nav.

**Acting** is not something the app container can do to itself — replacing a
running container needs the Docker socket, and the socket is root-equivalent on
the host. It does not belong in a container that drives a real browser across
arbitrary websites. So the deploy compose file runs a separate `updater`
service — Watchtower in **HTTP API mode** — and the app's only power is to POST
"update now" to it with a shared token. Watchtower in this mode polls nothing
and schedules nothing; it acts only when asked, only on containers labelled
`com.centurylinklabs.watchtower.enable`, its port is never published, and old
images are cleaned up after a switch. Remove the service and the button
degrades to printing `docker compose pull && docker compose up -d`.

One timing subtlety, learned from reading rather than debugging but worth
recording: Watchtower answers a *refusal* (bad token) immediately, but on
success it **holds the HTTP connection for the entire pull-and-recreate — and
the requesting container is killed partway through**, so the app would wait on
a socket that can only die. `triggerUpdate()` therefore waits three seconds for
a refusal, then reports "started" and lets the settings page watch
`/api/health` for the restart: the page reloads only after seeing the endpoint
go *down and come back*, because reloading on the first OK would declare
victory while the old container was still serving.

## No example data, ever

`loadRegistry()` used to fall back to a bundled `sites.example.json` so a fresh
install looked explorable. The registry it returned was tagged
`source: 'example'`, and the intent was that callers would notice.

**None of them did.** Five fictional sites were handed straight to the live
providers, and a brand-new install would:

- fetch `example.org` over the network and cache its title and favicon,
- do the same for `blog.example.org`, `docs.example.org` and
  `other.example.com`,
- ask Plausible for `blog.example.org` **on every page render**, because the
  sidebar's live visitor counts run in the layout.

That last one is how it surfaced. Plausible answers an unknown site with
`401 Invalid API key or site ID` — one message covering both causes — so the
settings page reported a **valid API key as invalid**. The key was correct, the
instance was correct, and the only thing wrong was that the dashboard was asking
about a domain nobody owns.

The lesson is not "add a guard". A guard was added, in one of the five call
sites, by the person who wrote the tag — and the other four kept lying. The fix
is that **a site in the registry is always a real site**, so no caller has to
remember anything.

The ambiguous 401 that made this so hard to read went on to cost a second
afternoon on its own; it is now handled inside the provider rather than at each
call site, for exactly the reason above — see
[Plausible's 401 covers two very different causes](#plausibles-401-covers-two-very-different-causes).

If you are tempted to re-add sample data for onboarding: make it a registry the
user explicitly chose (a "load examples" button writing `sites.json`), never a
silent fallback that pretends to be one.

### The `sites.json` format

Two ways to list a site. Shorthand, when everything can be derived:

```json
{
  "domains": ["example.org", "docs.example.org", "blog.example.org"]
}
```

Each entry becomes its own site — subdomains included, since Plausible treats
each as a separate property. Slug, name and url are derived from the domain.

Full entries, for anything needing integration ids or custom test pages:

```json
{
  "sites": [
    {
      "slug": "example",
      "name": "Example",
      "url": "https://example.org",
      "tags": ["marketing"],
      "cloudflare": { "zoneId": "…" },
      "netlify": { "siteId": "…", "enabled": true },
      "plausible": { "domain": "example.org" },
      "github": { "repo": "owner/repo" },
      "testPages": ["/", "/about/"],
      "interactivePages": ["/product/"]
    }
  ]
}
```

Both keys can appear in the same file; an explicit entry wins over the same
domain in `domains`, so you can paste a domain list in and promote sites as you
add ids.

| Field | Notes |
|---|---|
| `slug` | Immutable — runs and artifacts are stored under it |
| `cloudflare.zoneId` | Cloudflare → site → Overview |
| `netlify.siteId` | Optional; resolved by domain when omitted. `enabled: false` silences the panel |
| `plausible.domain` | Optional. Omit it and the provider resolves it — see [Plausible's 401 covers two very different causes](#plausibles-401-covers-two-very-different-causes) |
| `plausible.baseUrl` | Only when this site is on a *different* Plausible instance |
| `plausible.keyEnv` | Name of the env var holding that instance's key |
| `github.repo` | `owner/repo`, case-sensitive |
| `testPages` | Audited and captured by default |
| `interactivePages` | Where the scroll-performance test aims |

## Not built yet

- **Type checking.** `@astrojs/check` is at 0.9.x and peer-deps on TypeScript 5,
  while current TypeScript is 7.x, so it was left out to keep the install clean.
  Worth revisiting.
- **No test suite of our own.** The app tests other people's sites and none of
  its own code.
- **`data/runs/` grows unbounded.** No pruning, and no score trends over time.
