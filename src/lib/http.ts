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
}

/**
 * fetch + JSON with useful failures. Providers translate the thrown errors into
 * PanelResult values; nothing here decides how a problem is presented.
 */
export const fetchJson = async <T>(
  url: string,
  init: JsonRequestInit = {},
): Promise<T> => {
  const { timeoutMs = 15_000, ...rest } = init;
  const host = hostOf(url);

  let response: Response;
  try {
    response = await fetch(url, {
      ...rest,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const name = (error as Error).name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new Error(`${host} did not respond within ${timeoutMs}ms`);
    }
    throw new Error(`Could not reach ${host}: ${messageOf(error)}`);
  }

  const text = await response.text();

  if (!response.ok) {
    const detail = snippet(text);
    throw new HttpError(
      response.status,
      host,
      `${host} returned ${response.status} ${response.statusText}${
        detail ? `: ${detail}` : ''
      }`,
      text,
    );
  }

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
