import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Static file serving for dist/client.
 *
 * Astro's middleware mode explicitly does not serve files — that becomes the
 * host server's job, and without this the CSS and client scripts 404.
 */

const clientRoot = path.resolve(
  fileURLToPath(new URL('../dist/client/', import.meta.url)),
);

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

export const serveStatic = async (req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();

  let pathname;
  try {
    pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  } catch {
    return next();
  }

  // Directories and routes are Astro's business.
  if (pathname === '/' || pathname.endsWith('/')) return next();

  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return next();
  }

  const target = path.resolve(clientRoot, `.${decoded}`);

  // Same guard as the artifact route: refuse anything resolving outside the
  // root, so an encoded ../ can't reach .env or the data directory.
  if (target !== clientRoot && !target.startsWith(clientRoot + path.sep)) {
    res.statusCode = 403;
    res.end('Forbidden');
    return;
  }

  let info;
  try {
    info = await stat(target);
  } catch {
    return next();
  }
  if (!info.isFile()) return next();

  const extension = path.extname(target).toLowerCase();
  res.statusCode = 200;
  res.setHeader(
    'Content-Type',
    CONTENT_TYPES[extension] ?? 'application/octet-stream',
  );
  res.setHeader('Content-Length', String(info.size));
  // Everything Astro emits under _astro/ carries a content hash in its name.
  res.setHeader(
    'Cache-Control',
    decoded.startsWith('/_astro/')
      ? 'public, max-age=31536000, immutable'
      : 'public, max-age=600',
  );

  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  createReadStream(target)
    .on('error', () => {
      if (!res.headersSent) res.statusCode = 500;
      res.end();
    })
    .pipe(res);
};
