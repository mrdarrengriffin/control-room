# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# base — Chromium with every system library it needs, plus the gh CLI.
#
# The official Playwright image carries a matching browser build and the long
# tail of shared objects Chromium needs on Linux. That is the whole reason this
# project is containerised: Lighthouse and Playwright both drive a real browser,
# and installing one by hand on Windows is the part that never works.
#
# This tag MUST stay in lockstep with the pinned `playwright` version in
# package.json — a mismatch means the npm package looks for a browser build that
# is not in the image. That is why playwright is pinned exactly, not caret-ranged.
# ---------------------------------------------------------------------------
FROM mcr.microsoft.com/playwright:v1.62.1-noble AS base

ENV DEBIAN_FRONTEND=noninteractive \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# gh is a runtime dependency, not a convenience: the GitHub provider shells out
# to `gh pr list --json statusCheckRollup`, which returns pull requests and all
# of their CI job results in a single call. Doing that over REST would need one
# request per PR.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg git jq tini \
 && mkdir -p -m 755 /etc/apt/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

# ---------------------------------------------------------------------------
# deps — resolve node_modules once so dev/build/prod all share the layer.
# ---------------------------------------------------------------------------
FROM base AS deps
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

# ---------------------------------------------------------------------------
# dev — source is bind-mounted over /workspace by docker-compose.yml, so
# what matters here is the toolchain, not the copied files.
# ---------------------------------------------------------------------------
FROM base AS dev
ENV NODE_ENV=development
COPY --from=deps /workspace/node_modules ./node_modules
COPY . .
EXPOSE 4321
ENTRYPOINT ["/usr/bin/tini", "--"]
# Clear any stale dev-server lock first — see the note in docker-compose.yml
# for why `astro dev --force` is the wrong tool for this.
CMD ["bash", "-lc", "rm -f .astro/dev.json; exec npm run dev -- --host 0.0.0.0"]

# ---------------------------------------------------------------------------
# build — produce dist/
# ---------------------------------------------------------------------------
FROM base AS build
ENV NODE_ENV=development
COPY --from=deps /workspace/node_modules ./node_modules
COPY . .
RUN npm run build

# ---------------------------------------------------------------------------
# prod — the instance you daily-drive. node_modules is kept because the Astro
# Node adapter externalises server dependencies rather than bundling them, and
# because this app runs Lighthouse and Playwright at request time.
#
# Entry is our own server (see server/index.mjs), not Astro's: the adapter runs
# in middleware mode so that the WebSocket upgrade has somewhere to live.
# ---------------------------------------------------------------------------
FROM base AS prod
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4321
COPY --from=deps /workspace/node_modules ./node_modules
COPY --from=build /workspace/dist ./dist
COPY server ./server
COPY package.json ./

# The image is a distribution of the work, so it carries the licence with it —
# Apache-2.0 §4(a) and §4(d).
COPY LICENSE NOTICE /workspace/

# Nothing is seeded into the data directory. A new install has no sites and the
# dashboard says so; it used to ship an example registry, but nothing downstream
# distinguished those fictional sites from real ones and they were handed
# straight to the live providers.

# Who this build is, stamped by the publish workflow. The app compares its own
# sha against what the registry currently serves for the tag it follows (see
# src/lib/update.ts). All three stay empty in a local build, which the app reads
# as "source checkout — updates come via git, not the registry".
ARG GIT_SHA=""
ARG VERSION=""
ARG IMAGE=""
ENV CONTROL_ROOM_BUILD_SHA=$GIT_SHA \
    CONTROL_ROOM_BUILD_VERSION=$VERSION \
    CONTROL_ROOM_IMAGE=$IMAGE

EXPOSE 4321
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "./server/index.mjs"]
