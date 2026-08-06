import {
  hostOf as debugHostOf,
  providerForHost,
  record,
  redactUrl,
  truncate,
} from './debug';
import { messageOf } from './types';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly host: string,
    message: string,
    readonly body?: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }

  /** 401/403 almost always means the token, not the request. */
  get isAuthFailure() {
    return this.status === 401 || this.status === 403;
  }
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** Trim an error body down to something readable in a UI panel. */
const snippet = (body: string) => {
  const text = body.trim();
  if (text === '') return '';
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
};

export interface JsonRequestInit extends Omit<RequestInit, 'signal'> {
  timeoutMs?: number;
  /**
   * Extra context for the debug log. The provider is inferred from the host
   * when omitted; pass it for a self-hosted instance, and use `context` for the
   * facts that make a failure diagnosable — the site id being asked about, say.
   */
  debug?: {
    provider?: string;
    context?: Record<string, string>;
  };
}

/**
 * fetch + JSON with useful failures. Providers translate the thrown errors into
 * PanelResult values; nothing here decides how a problem is presented.
 */
export const fetchJson = async <T>(
  url: string,
  init: JsonRequestInit = {},
): Promise<T> => {
  const { timeoutMs = 15_000, debug, ...rest } = init;
  const host = hostOf(url);

  /*
   * Every REST call in the app funnels through here, which makes this the one
   * place worth instrumenting. Headers are never logged — credentials live in
   * them — and the URL is redacted before it is stored.
   */
  const started = Date.now();
  const log = (status: number | undefined, ok: boolean, detail?: string) =>
    record({
      kind: 'http',
      provider: debug?.provider ?? providerForHost(debugHostOf(url)),
      label: `${(rest.method ?? 'GET').toUpperCase()} ${redactUrl(url)}`,
      target: host,
      status,
      ok,
      ms: Date.now() - started,
      detail,
      context: debug?.context,
    });

  let response: Response;
  try {
    response = await fetch(url, {
      ...rest,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const name = (error as Error).name;
    const timedOut = name === 'TimeoutError' || name === 'AbortError';
    const message = timedOut
      ? `${host} did not respond within ${timeoutMs}ms`
      : `Could not reach ${host}: ${messageOf(error)}`;
    log(undefined, false, message);
    throw new Error(message);
  }

  const text = await response.text();

  if (!response.ok) {
    const detail = snippet(text);
    log(response.status, false, detail || response.statusText);
    throw new HttpError(
      response.status,
      host,
      `${host} returned ${response.status} ${response.statusText}${
        detail ? `: ${detail}` : ''
      }`,
      text,
    );
  }

  log(response.status, true);

  if (text.trim() === '') return undefined as T;

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${host} returned a non-JSON response`);
  }
};

export const bearer = (token: string) => ({
  Authorization: `Bearer ${token}`,
});
