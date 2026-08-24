import { setTimeout as delay } from 'node:timers/promises';
import { cachedBy, TTL } from './cache';
import { envValue } from './env';
import { bearer, fetchJson } from './http';
import { failed, messageOf, ok, unconfigured } from './types';
import type { PanelResult } from './types';

/**
 * Self-update: notice when the image tag this install follows has moved on,
 * and hand the actual pull-and-restart to the updater sidecar.
 *
 * The question the check answers is deliberately narrow: "does the tag I was
 * started from point at a different image than the one I am?" — not "is there
 * a newer release?". That framing makes pinned tags behave sensibly for free:
 * `latest` moves on releases, `main` on every push, `1.2` on patch releases,
 * and an exact `1.2.3` never — which is exactly what pinning means, so the
 * check reports it as up to date rather than nagging about versions the pin
 * was chosen to ignore.
 *
 * Identity comes from build args stamped by the publish workflow (see
 * docker/Dockerfile): the image name, the git sha and a display version. A
 * source checkout has none of them, and the check short-circuits to
 * `unconfigured` before any network call — dev servers never talk to the
 * registry.
 */

export interface BuildInfo {
  /** e.g. ghcr.io/mrdarrengriffin/control-room — empty in a source checkout. */
  image?: string;
  sha?: string;
  version?: string;
  /** The tag this install follows. The compose file passes CONTROL_ROOM_TAG in. */
  tag: string;
}

export const buildInfo = (): BuildInfo => ({
  image: envValue('CONTROL_ROOM_IMAGE'),
  sha: envValue('CONTROL_ROOM_BUILD_SHA'),
  version: envValue('CONTROL_ROOM_BUILD_VERSION'),
  tag: envValue('CONTROL_ROOM_TAG') ?? 'latest',
});

/** An exact `1.2.3` pin — a tag that never moves, so "up to date" is by design. */
export const isPinnedTag = (tag: string): boolean => /^\d+\.\d+\.\d+$/.test(tag);

export interface UpdateStatus {
  updateAvailable: boolean;
  tag: string;
  localSha: string;
  localVersion?: string;
  remoteSha: string;
  remoteVersion?: string;
}

/**
 * The whole check runs during page renders (the sidebar shows the result), so
 * a broken or unreachable registry must cost little: short timeouts here, and
 * failures are cached below far longer than the usual 15s.
 */
const REGISTRY_TIMEOUT_MS = 5_000;

/** node's names for the architectures the image is published for. */
const ARCHES: Record<string, string> = { x64: 'amd64', arm64: 'arm64' };

const ACCEPT_MANIFEST = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

interface ManifestResponse {
  /** Present on a multi-arch index. */
  manifests?: {
    digest: string;
    platform?: { architecture?: string; os?: string };
  }[];
  /** Present on a single-arch manifest. */
  config?: { digest: string };
}

interface ImageConfig {
  config?: { Labels?: Record<string, string> };
}

const checkUncached = async (): Promise<PanelResult<UpdateStatus>> => {
  const { image, sha, version, tag } = buildInfo();

  if (!image || !sha) {
    return unconfigured(
      'Running from a source checkout, so updates come through git — the registry has nothing to say about this build.',
    );
  }

  const slash = image.indexOf('/');
  if (slash <= 0) return failed(`"${image}" is not a registry image name.`);
  const host = image.slice(0, slash);
  const repo = image.slice(slash + 1);
  const debug = { provider: 'registry', context: { image, tag } };

  try {
    // Anonymous pull token — the image is public. GHCR (and Docker's registry)
    // answer this without credentials; a private image would 401 here, which
    // surfaces as an ordinary error rather than breaking the page.
    const auth = await fetchJson<{ token?: string }>(
      `https://${host}/token?service=${host}&scope=repository:${repo}:pull`,
      { timeoutMs: REGISTRY_TIMEOUT_MS, debug },
    );
    if (!auth?.token) return failed(`${host} did not issue a pull token.`);
    const headers = { ...bearer(auth.token), Accept: ACCEPT_MANIFEST };

    const index = await fetchJson<ManifestResponse>(
      `https://${host}/v2/${repo}/manifests/${encodeURIComponent(tag)}`,
      { timeoutMs: REGISTRY_TIMEOUT_MS, headers, debug },
    );

    /*
     * A published tag is a multi-arch index; find this machine's entry. Buildx
     * can also attach attestation manifests whose platform is "unknown", so
     * match on real os/arch rather than taking the first item. A plain
     * single-arch manifest (someone's local push) carries its config directly.
     */
    let configDigest = index.config?.digest;
    if (index.manifests) {
      const arch = ARCHES[process.arch] ?? process.arch;
      const entry = index.manifests.find(
        (m) => m.platform?.os === 'linux' && m.platform.architecture === arch,
      );
      if (!entry) return failed(`${image}:${tag} has no linux/${arch} build.`);
      const manifest = await fetchJson<ManifestResponse>(
        `https://${host}/v2/${repo}/manifests/${entry.digest}`,
        { timeoutMs: REGISTRY_TIMEOUT_MS, headers, debug },
      );
      configDigest = manifest.config?.digest;
    }
    if (!configDigest) {
      return failed(`${image}:${tag} has a manifest with no config digest.`);
    }

    const config = await fetchJson<ImageConfig>(
      `https://${host}/v2/${repo}/blobs/${configDigest}`,
      { timeoutMs: REGISTRY_TIMEOUT_MS, headers: bearer(auth.token), debug },
    );

    const labels = config?.config?.Labels ?? {};
    const remoteSha = labels['org.opencontainers.image.revision'];
    if (!remoteSha) {
      return failed(
        `The ${tag} image on ${host} carries no revision label, so it predates update checks. Update once by hand: docker compose pull && docker compose up -d.`,
      );
    }

    return ok({
      updateAvailable: remoteSha !== sha,
      tag,
      localSha: sha,
      localVersion: version,
      remoteSha,
      remoteVersion: labels['org.opencontainers.image.version'],
    });
  } catch (error) {
    return failed(messageOf(error));
  }
};

/**
 * Cached with its own TTLs rather than through cachedResult: this renders in
 * the sidebar on every page, so the usual 15s error TTL would have a dead
 * registry re-block a render every 15 seconds. An update landing late costs
 * nothing; a page held up by GHCR being down costs every page.
 */
export const checkForUpdate = (): Promise<PanelResult<UpdateStatus>> =>
  cachedBy('update:check', checkUncached, (result) => {
    if (result.status === 'ok') return TTL.updateCheck;
    if (result.status === 'error') return TTL.updateCheckFailed;
    // 'unconfigured' is computed locally with no network call — never cached,
    // same as everywhere else.
    return undefined;
  });

/** Whether an updater sidecar is configured, for the settings UI to degrade on. */
export const updaterConfigured = (): boolean =>
  envValue('CONTROL_ROOM_UPDATE_TOKEN') !== undefined;

/**
 * Ask the updater sidecar (Watchtower in HTTP API mode — see
 * deploy/docker-compose.yml) to pull the tag and recreate this container.
 *
 * Watchtower answers a refusal (bad token, nothing labelled for it) at once,
 * but on success it holds the connection for the entire pull-and-recreate —
 * during which this very container is replaced and the socket dies with it. So
 * wait just long enough for a refusal to surface, then report the update as
 * started and let the page watch /api/health for the restart.
 */
export const triggerUpdate = async (): Promise<PanelResult<string>> => {
  const token = envValue('CONTROL_ROOM_UPDATE_TOKEN');
  if (!token) {
    return unconfigured(
      'No updater is running beside this container. Update from the machine itself: docker compose pull && docker compose up -d.',
    );
  }

  const base = (
    envValue('CONTROL_ROOM_UPDATER_URL') ?? 'http://updater:8080'
  ).replace(/\/+$/, '');

  const request = fetchJson<unknown>(`${base}/v1/update`, {
    method: 'POST',
    headers: bearer(token),
    // The pull of a ~2.8GB-based image takes real minutes on a slow line.
    timeoutMs: 10 * 60_000,
    debug: { provider: 'updater' },
  });
  // The socket dying mid-update is the expected success path; don't let it
  // become an unhandled rejection after the race below has moved on.
  request.catch(() => undefined);

  const outcome = await Promise.race([
    request.then(
      () => 'accepted' as const,
      (error: unknown) => new Error(messageOf(error)),
    ),
    delay(3_000).then(() => 'started' as const),
  ]);

  if (outcome instanceof Error) return failed(outcome.message);
  return ok(
    'Update started. This page will lose the server for a moment while the new image starts.',
  );
};
