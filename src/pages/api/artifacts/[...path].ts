import type { APIRoute } from 'astro';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { resolveArtifactPath } from '../../../lib/store';

/**
 * Serve captured screenshots and video out of the data directory.
 *
 * The path comes from a URL, so it goes through resolveArtifactPath, which
 * refuses anything resolving outside the artifacts root. Without that,
 * `/api/artifacts/../../.env` would hand out the tokens.
 */

const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.json': 'application/json',
  '.html': 'text/html; charset=utf-8',
};

export const GET: APIRoute = async ({ params }) => {
  const relative = params.path;
  if (!relative) return new Response('Not found', { status: 404 });

  const absolute = resolveArtifactPath(relative);
  if (!absolute) {
    return new Response('Forbidden', { status: 403 });
  }

  let size: number;
  try {
    const info = await stat(absolute);
    if (!info.isFile()) return new Response('Not found', { status: 404 });
    size = info.size;
  } catch {
    return new Response('Not found', { status: 404 });
  }

  const contentType =
    CONTENT_TYPES[path.extname(absolute).toLowerCase()] ??
    'application/octet-stream';

  const body = Readable.toWeb(
    createReadStream(absolute),
  ) as unknown as ReadableStream;

  return new Response(body, {
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(size),
      // Artifacts are immutable once written: the run id is in the path.
      'Cache-Control': 'private, max-age=31536000, immutable',
    },
  });
};
