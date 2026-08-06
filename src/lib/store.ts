import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { env } from './env';
import type { RunRecord } from './types';

/**
 * Flatfile persistence. No database by design — the whole point of this project
 * is that it runs on one machine with as little standing infrastructure as
 * possible. Layout under the data dir:
 *
 *   sites.json                       the site registry you maintain by hand
 *   runs/<site-slug>/<run-id>.json   one file per saved test run
 *   artifacts/<site-slug>/<run-id>/  screenshots, video, raw reports
 */

export const dataRoot = () => path.resolve(env.dataDir());
export const runsRoot = () => path.join(dataRoot(), 'runs');
export const artifactsRoot = () => path.join(dataRoot(), 'artifacts');

export const readJsonFile = async <T>(file: string): Promise<T | undefined> => {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
};

/**
 * Write through a temp file and rename. A rename is atomic on the same
 * filesystem, so an interrupted write can never leave a truncated JSON file
 * that fails to parse on next read.
 */
export const writeJsonFile = async (file: string, value: unknown) => {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${randomUUID().slice(0, 8)}`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temp, file);
};

/** Sortable, filesystem-safe run id: 20260804T142530-audit-1a2b3c. */
export const newRunId = (kind: string): string => {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, '');
  return `${stamp}-${kind}-${randomUUID().slice(0, 6)}`;
};

const runFile = (siteSlug: string, runId: string) =>
  path.join(runsRoot(), siteSlug, `${runId}.json`);

export const saveRun = async (run: RunRecord) => {
  await writeJsonFile(runFile(run.siteSlug, run.id), run);
};

export const getRun = (siteSlug: string, runId: string) =>
  readJsonFile<RunRecord>(runFile(siteSlug, runId));

/**
 * Most recent runs for a site, newest first. Run ids start with a sortable
 * timestamp, so filenames sort chronologically without opening any file.
 */
export const listRuns = async (
  siteSlug: string,
  limit = 20,
): Promise<RunRecord[]> => {
  let names: string[];
  try {
    names = await readdir(path.join(runsRoot(), siteSlug));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  const ids = names
    .filter((name) => name.endsWith('.json'))
    .sort((a, b) => b.localeCompare(a))
    .slice(0, limit);

  const runs = await Promise.all(
    ids.map((name) => getRun(siteSlug, name.replace(/\.json$/, ''))),
  );

  return runs.filter((run): run is RunRecord => run !== undefined);
};

/**
 * Resolve a caller-supplied artifact path inside the artifacts root, refusing
 * anything that escapes it. Guards the artifact-serving endpoint against
 * `../../.env` style traversal.
 */
export const resolveArtifactPath = (relative: string): string | undefined => {
  const root = artifactsRoot();
  const absolute = path.resolve(root, relative);
  if (absolute !== root && !absolute.startsWith(root + path.sep)) {
    return undefined;
  }
  return absolute;
};
