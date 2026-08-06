import { execFile } from 'node:child_process';

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
          resolve({ code: 0, stdout, stderr });
          return;
        }

        const errno = error as NodeJS.ErrnoException & { killed?: boolean };

        if (errno.killed) {
          reject(
            new Error(
              `${file} timed out after ${options.timeoutMs ?? 30_000}ms`,
            ),
          );
          return;
        }

        if (errno.code === 'ENOENT') {
          reject(new Error(`${file} is not installed in this container`));
          return;
        }

        // execFile puts the process exit status in `code` when it is numeric.
        if (typeof errno.code === 'number') {
          resolve({ code: errno.code, stdout, stderr });
          return;
        }

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
