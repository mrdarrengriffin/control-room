import type { APIRoute } from 'astro';
import { removeSite, updateSite } from '../../../lib/sites';
import { messageOf } from '../../../lib/types';

/** Split a textarea into paths, accepting full URLs as well. */
const parsePaths = (raw: string): string[] => {
  const seen = new Set<string>();

  for (const line of raw.split(/[\r\n,]+/)) {
    let value = line.trim();
    if (value === '') continue;

    if (/^https?:\/\//i.test(value)) {
      try {
        value = new URL(value).pathname;
      } catch {
        continue;
      }
    }

    if (!value.startsWith('/')) value = `/${value}`;
    seen.add(value);
  }

  return [...seen];
};

const field = (form: FormData, name: string): string | undefined => {
  const value = String(form.get(name) ?? '').trim();
  return value === '' ? undefined : value;
};

export const POST: APIRoute = async ({ request }) => {
  let slug = '';

  const toEdit = (status: 'ok' | 'error', message: string) =>
    new Response(null, {
      status: 303,
      headers: {
        Location: `/sites/${encodeURIComponent(slug)}/edit?flash=${status}&message=${encodeURIComponent(message)}`,
      },
    });

  try {
    const form = await request.formData();
    slug = String(form.get('slug') ?? '').trim();
    if (slug === '') {
      return new Response(null, { status: 303, headers: { Location: '/' } });
    }

    if (String(form.get('action') ?? '') === 'delete') {
      const removed = await removeSite(slug);
      if (!removed.ok) return toEdit('error', removed.reason ?? 'Could not remove.');

      return new Response(null, {
        status: 303,
        headers: {
          Location: `/?flash=ok&message=${encodeURIComponent(
            `Removed ${slug}. Saved runs and artifacts were kept.`,
          )}`,
        },
      });
    }

    const rawUrl = field(form, 'url');
    if (!rawUrl) return toEdit('error', 'A URL is required.');

    let parsed: URL;
    try {
      parsed = new URL(/^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`);
    } catch {
      return toEdit('error', `"${rawUrl}" is not a valid URL.`);
    }

    const githubRepo = field(form, 'githubRepo');
    if (githubRepo && !/^[^/\s]+\/[^/\s]+$/.test(githubRepo)) {
      return toEdit('error', `GitHub repo should be "owner/repo", got "${githubRepo}".`);
    }

    const tags = String(form.get('tags') ?? '')
      .split(',')
      .map((tag) => tag.trim())
      .filter((tag) => tag !== '');

    const result = await updateSite(slug, {
      name: field(form, 'name') ?? parsed.hostname,
      url: `${parsed.protocol}//${parsed.host}`,
      description: field(form, 'description'),
      tags,
      cloudflareZoneId: field(form, 'cloudflareZoneId'),
      netlifySiteId: field(form, 'netlifySiteId'),
      // Checkbox absent means "not on Netlify".
      netlifyEnabled: form.get('netlifyEnabled') !== null ? undefined : false,
      plausibleDomain: field(form, 'plausibleDomain'),
      plausibleBaseUrl: field(form, 'plausibleBaseUrl'),
      plausibleKeyEnv: field(form, 'plausibleKeyEnv'),
      githubRepo,
      testPages: parsePaths(String(form.get('testPages') ?? '')),
      interactivePages: parsePaths(String(form.get('interactivePages') ?? '')),
    });

    if (!result.ok) return toEdit('error', result.reason ?? 'Could not save.');

    return new Response(null, {
      status: 303,
      headers: {
        Location: `/sites/${encodeURIComponent(slug)}?flash=ok&message=${encodeURIComponent('Site updated.')}`,
      },
    });
  } catch (error) {
    return toEdit('error', messageOf(error));
  }
};
