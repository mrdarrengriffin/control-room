# Working on Control Room

## Read first

**[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** covers how this is built and,
more usefully, a long list of things that were surprising or wrong the first
time — Plausible's date ranges, Netlify's loose site matching, Lighthouse 13's
renamed audit ids, coordinate spaces in element crops, the WebSocket/middleware
constraint. Check it before changing providers, caching or the container.

## Running it

Everything runs in Docker. There is no Node.js on the host, so **don't run
`npm`, `astro` or `node` directly** — they won't work.

```sh
docker compose up -d --build                      # prod-ish  :4331
docker compose -f docker-compose.dev.yml up -d    # hot reload :4332
docker compose -f docker-compose.dev.yml logs -f  # dev logs
```

> [!WARNING]
> Never start the dev server with `astro dev --force`. It reads a stale PID from
> `.astro/dev.json` — which survives in the bind mount — and in a fresh PID
> namespace that PID belongs to the new node process, so Astro SIGTERMs itself
> and the container exits 143. Compose already deletes the lock on start.

To run a one-off command, exec into the container:

```sh
docker exec control-room-control-room-1 gh pr list --repo owner/name
```

## Conventions

- **Providers never throw.** Return a `PanelResult` (`ok` / `unconfigured` /
  `error`) so one missing token degrades one panel, not the page.
- **No client framework.** UI is server-rendered Astro components with plain
  CSS custom properties in `src/styles/app.css`. Adding React or Tailwind is a
  decision, not a convenience.
- **No database.** Flatfile JSON under `data/`, written via `src/lib/store.ts`
  (temp file + rename, so an interrupted write can't truncate).
- **Nothing secret reaches the page.** The settings UI shows a value's length
  and which layer it came from, never any part of the value itself.
- **Charts need a table view.** No value should be reachable only by hovering.
- **`playwright` in package.json must exactly match the Dockerfile's base image
  tag.** Bump both together or neither.

## Before committing

`data/` is gitignored apart from `sites.example.json` — keep it that way.
`secrets.json`, `auth.json`, `sites.json`, `favicons/`, `runs/` and
`artifacts/` all contain real credentials or real infrastructure ids, and this
repo is public.

## Astro reference

This is Astro 7 with `@astrojs/node` in **middleware** mode (`output: 'server'`).

- [Routing and middleware](https://docs.astro.build/en/guides/routing/)
- [Astro components](https://docs.astro.build/en/basics/astro-components/)
- [Styling](https://docs.astro.build/en/guides/styling/)
