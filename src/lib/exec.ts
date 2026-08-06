import { execFile } from 'node:child_process';
import { record, truncate } from './debug';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  timeoutMs?: number;
  /** Extra environment on top of the server's own. */
  env?: Record<string, string | undefined>;
  maxBufferBytes?: number;
  cwd?: string;
}

/**
 * Run a binary and collect its output.
 *
 * Deliberately execFile and not exec: arguments are passed as an array and
 * never touch a shell, so a site slug or branch name out of sites.json cannot
 * turn into shell injection.
 *
 * A non-zero exit is a normal, resolved result — callers decide whether that is
 * an error. Only genuine spawn failures and timeouts reject.
 */
export const runCommand = (
  file: string,
  args: string[],
  options: ExecOptions = {},
): Promise<ExecResult> =>
  new Promise((resolve, reject) => {
    /*
     * Logged for the same reason HTTP calls are: `gh` failing is otherwise a
     * silent panel. Arguments are safe to record — they are a fixed list built
     * by us, and the token reaches gh through the environment, never argv.
     */
    const started = Date.now();
    const log = (status: number | undefined, ok: boolean, detail?: string) =>
      record({
        kind: 'command',
        provider: file === 'gh' ? 'github' : file,
        label: `${file} ${args.join(' ')}`,
        target: file,
        status,
        ok,
        ms: Date.now() - started,
        detail,
      });

    execFile(
      file,
      args,
      {
        timeout: options.timeoutMs ?? 30_000,
        maxBuffer: options.maxBufferBytes ?? 32 * 1024 * 1024,
        env: { ...process.env, ...options.env },
        cwd: options.cwd,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (!error) {
          log(0, true);
          resolve({ code: 0, stdout, stderr });
          return;
        }

        const errno = error as NodeJS.ErrnoException & { killed?: boolean };

        if (errno.killed) {
          const message = `${file} timed out after ${options.timeoutMs ?? 30_000}ms`;
          log(undefined, false, message);
          reject(new Error(message));
          return;
        }

        if (errno.code === 'ENOENT') {
          const message = `${file} is not installed in this container`;
          log(undefined, false, message);
          reject(new Error(message));
          return;
        }

        // execFile puts the process exit status in `code` when it is numeric.
        if (typeof errno.code === 'number') {
          log(errno.code, false, truncate(stderr || stdout));
          resolve({ code: errno.code, stdout, stderr });
          return;
        }

        log(undefined, false, error.message);
        reject(error);
      },
    );
  });

/** Parse stdout as JSON, with the command's stderr surfaced when it isn't. */
export const parseJsonOutput = <T>(result: ExecResult, what: string): T => {
  try {
    return JSON.parse(result.stdout) as T;
  } catch {
    const detail = result.stderr.trim() || result.stdout.trim().slice(0, 300);
    throw new Error(`${what} did not return JSON: ${detail || 'empty output'}`);
  }
};
