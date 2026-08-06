import { TTL, cachedResult } from '../cache';
import { env } from '../env';
import { parseJsonOutput, runCommand } from '../exec';
import { failed, messageOf, ok, unconfigured } from '../types';
import type { PanelResult } from '../types';

/**
 * GitHub goes through the gh CLI rather than REST for one concrete reason:
 * `--json statusCheckRollup` returns every pull request together with the
 * status of all of its CI jobs in a single call. The equivalent over REST is a
 * PR list followed by one check-runs request per PR.
 */

const FIELDS = [
  'number',
  'title',
  'url',
  'headRefName',
  'baseRefName',
  'isDraft',
  'author',
  'createdAt',
  'updatedAt',
  'additions',
  'deletions',
  'reviewDecision',
  'mergeable',
  'statusCheckRollup',
].join(',');

export type CheckState =
  | 'success'
  | 'failure'
  | 'pending'
  | 'cancelled'
  | 'skipped'
  | 'neutral'
  | 'unknown';

export interface Check {
  name: string;
  state: CheckState;
  url?: string;
  workflow?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface CheckRollup {
  overall: CheckState;
  total: number;
  success: number;
  failure: number;
  pending: number;
  other: number;
  checks: Check[];
}

export interface PullRequest {
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  headRefName: string;
  baseRefName: string;
  isDraft: boolean;
  createdAt: string;
  updatedAt: string;
  additions: number;
  deletions: number;
  /** APPROVED / CHANGES_REQUESTED / REVIEW_REQUIRED, or undefined. */
  reviewDecision?: string;
  mergeable?: string;
  checks: CheckRollup;
}

/** One entry of gh's statusCheckRollup: either a check run or a legacy status. */
interface RollupEntry {
  __typename?: string;
  name?: string;
  status?: string;
  conclusion?: string;
  detailsUrl?: string;
  workflowName?: string;
  startedAt?: string;
  completedAt?: string;
  context?: string;
  state?: string;
  targetUrl?: string;
}

interface RawPullRequest {
  number: number;
  title: string;
  url: string;
  headRefName: string;
  baseRefName: string;
  isDraft: boolean;
  author?: { login?: string };
  createdAt: string;
  updatedAt: string;
  additions?: number;
  deletions?: number;
  reviewDecision?: string;
  mergeable?: string;
  statusCheckRollup?: RollupEntry[] | null;
}

const CONCLUSION: Record<string, CheckState> = {
  SUCCESS: 'success',
  FAILURE: 'failure',
  TIMED_OUT: 'failure',
  STARTUP_FAILURE: 'failure',
  ACTION_REQUIRED: 'failure',
  CANCELLED: 'cancelled',
  SKIPPED: 'skipped',
  NEUTRAL: 'neutral',
  STALE: 'neutral',
};

const STATUS_CONTEXT: Record<string, CheckState> = {
  SUCCESS: 'success',
  FAILURE: 'failure',
  ERROR: 'failure',
  PENDING: 'pending',
  EXPECTED: 'neutral',
};

const normaliseEntry = (entry: RollupEntry): Check => {
  // Legacy commit statuses carry `context`/`state`; check runs carry the rest.
  if (entry.__typename === 'StatusContext' || entry.context !== undefined) {
    return {
      name: entry.context ?? 'status',
      state: STATUS_CONTEXT[entry.state ?? ''] ?? 'unknown',
      url: entry.targetUrl,
    };
  }

  const state: CheckState =
    entry.status && entry.status !== 'COMPLETED'
      ? 'pending'
      : (CONCLUSION[entry.conclusion ?? ''] ?? 'unknown');

  return {
    name: entry.name ?? 'check',
    state,
    url: entry.detailsUrl,
    workflow: entry.workflowName,
    startedAt: entry.startedAt,
    completedAt: entry.completedAt,
  };
};

/**
 * Collapse individual checks into one verdict. Failure dominates so a red run
 * is never hidden by surrounding green; pending outranks success so an
 * in-flight run is not reported as passing.
 */
const rollup = (entries: RollupEntry[] | null | undefined): CheckRollup => {
  const checks = (entries ?? []).map(normaliseEntry);
  const count = (state: CheckState) =>
    checks.filter((check) => check.state === state).length;

  const success = count('success');
  const failure = count('failure');
  const pending = count('pending');
  const other = checks.length - success - failure - pending;

  const overall: CheckState =
    checks.length === 0
      ? 'unknown'
      : failure > 0
        ? 'failure'
        : pending > 0
          ? 'pending'
          : success > 0
            ? 'success'
            : 'neutral';

  return { overall, total: checks.length, success, failure, pending, other, checks };
};

const ghEnv = () => {
  const token = env.githubToken();
  return token ? { GH_TOKEN: token, GITHUB_TOKEN: token } : {};
};

/**
 * Open pull requests for one repository, with CI status attached.
 *
 * `author` accepts gh's '@me' shorthand, which is how the dashboard narrows to
 * your own PRs without needing to know your username.
 */
export const pullRequests = async (
  repo: string,
  options: { author?: string; limit?: number } = {},
): Promise<PanelResult<PullRequest[]>> => {
  if (!env.githubToken()) {
    return unconfigured('GITHUB_TOKEN is not set in .env');
  }

  return cachedResult(
    `github:prs:${repo}:${options.author ?? 'all'}:${options.limit ?? 30}`,
    TTL.activity,
    () => loadPullRequests(repo, options),
  );
};

const loadPullRequests = async (
  repo: string,
  options: { author?: string; limit?: number },
): Promise<PanelResult<PullRequest[]>> => {
  const args = [
    'pr',
    'list',
    '--repo',
    repo,
    '--state',
    'open',
    '--limit',
    String(options.limit ?? 30),
    '--json',
    FIELDS,
  ];

  if (options.author) args.push('--author', options.author);

  try {
    const result = await runCommand('gh', args, {
      timeoutMs: 45_000,
      env: ghEnv(),
    });

    if (result.code !== 0) {
      const detail = result.stderr.trim() || `gh exited ${result.code}`;
      if (/HTTP 401|bad credentials/i.test(detail)) {
        return failed('GitHub rejected the token (GITHUB_TOKEN).');
      }
      if (/HTTP 404|could not resolve/i.test(detail)) {
        return failed(`No repository "${repo}" visible to this token.`);
      }
      return failed(detail);
    }

    const raw = parseJsonOutput<RawPullRequest[]>(result, `gh pr list ${repo}`);

    return ok(
      raw.map((pr) => ({
        repo,
        number: pr.number,
        title: pr.title,
        url: pr.url,
        author: pr.author?.login ?? 'unknown',
        headRefName: pr.headRefName,
        baseRefName: pr.baseRefName,
        isDraft: pr.isDraft,
        createdAt: pr.createdAt,
        updatedAt: pr.updatedAt,
        additions: pr.additions ?? 0,
        deletions: pr.deletions ?? 0,
        reviewDecision: pr.reviewDecision || undefined,
        mergeable: pr.mergeable || undefined,
        checks: rollup(pr.statusCheckRollup),
      })),
    );
  } catch (error) {
    return failed(messageOf(error));
  }
};

export interface RepoPullRequests {
  repo: string;
  result: PanelResult<PullRequest[]>;
}

/** Fan out across every configured repo at once. */
export const pullRequestsForRepos = async (
  repos: string[],
  options: { author?: string; limit?: number } = {},
): Promise<RepoPullRequests[]> => {
  const unique = [...new Set(repos)];
  return Promise.all(
    unique.map(async (repo) => ({
      repo,
      result: await pullRequests(repo, options),
    })),
  );
};

export interface GhIdentity {
  login: string;
}

/** Who the token belongs to — also serves as a credential check. */
export const whoami = async (): Promise<PanelResult<GhIdentity>> => {
  if (!env.githubToken()) {
    return unconfigured('GITHUB_TOKEN is not set in .env');
  }

  try {
    const result = await runCommand(
      'gh',
      ['api', 'user', '--jq', '.login'],
      { timeoutMs: 20_000, env: ghEnv() },
    );

    if (result.code !== 0) {
      return failed(result.stderr.trim() || `gh exited ${result.code}`);
    }

    const login = result.stdout.trim();
    return login
      ? ok({ login })
      : failed('gh returned no login for this token');
  } catch (error) {
    return failed(messageOf(error));
  }
};
