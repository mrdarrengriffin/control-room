import type { APIRoute } from 'astro';
import { appendSite, slugFromDomain } from '../../../lib/sites';
import { messageOf } from '../../../lib/types';
import type { Site } from '../../../lib/types';

/** Split a textarea into a clean list of paths. */
const lines = (raw: string): string[] =>
  raw
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter((line) => line !== '');

const field = (form: FormData, name: string): string | undefined => {
  const value = String(form.get(name) ?? '').trim();
  return value === '' ? undefined : value;
};

export const POST: APIRoute = async ({ request }) => {
  const fail = (message: string, url?: string) =>
    new Response(null, {
      status: 303,
      headers: {
        Location: `/sites/new?flash=error&message=${encodeURIComponent(message)}${
          url ? `&url=${encodeURIComponent(url)}` : ''
        }`,
      },
    });

  try {
    const form = await request.formData();

    const rawUrl = field(form, 'url');
    if (!rawUrl) return fail('A URL is required.');

    let parsed: URL;
    try {
      parsed = new URL(
        /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`,
      );
    } catch {
      return fail(`"${rawUrl}" is not a valid URL.`);
    }

    const hostname = parsed.hostname.toLowerCase();
    const slug = field(form, 'slug') ?? slugFromDomain(hostname);

    if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
      return fail(
        `Slug "${slug}" must be lowercase letters, numbers and hyphens.`,
        rawUrl,
      );
    }

    const zoneId = field(form, 'cloudflareZoneId');
    const netlifySiteId = field(form, 'netlifySiteId');
    const githubRepo = field(form, 'githubRepo');
    const plausibleDomain = field(form, 'plausibleDomain');
    const plausibleBaseUrl = field(form, 'plausibleBaseUrl');
    const plausibleKeyEnv = field(form, 'plausibleKeyEnv');

    if (githubRepo && !/^[^/\s]+\/[^/\s]+$/.test(githubRepo)) {
      return fail(`GitHub repo should be "owner/repo", got "${githubRepo}".`, rawUrl);
    }

    const testPages = lines(String(form.get('testPages') ?? ''));
    const interactivePages = lines(String(form.get('interactivePages') ?? ''));

    const site: Site = {
      slug,
      name: field(form, 'name') ?? hostname.replace(/^www\./, ''),
      url: `${parsed.protocol}//${parsed.host}`,
      description: field(form, 'description'),
      cloudflare: zoneId ? { zoneId } : undefined,
      netlify: netlifySiteId ? { siteId: netlifySiteId } : undefined,
      plausible: plausibleDomain
        ? {
            domain: plausibleDomain,
            baseUrl: plausibleBaseUrl,
            keyEnv: plausibleKeyEnv,
          }
        : undefined,
      github: githubRepo ? { repo: githubRepo } : undefined,
      testPages: testPages.length > 0 ? testPages : ['/'],
      interactivePages: interactivePages.length > 0 ? interactivePages : undefined,
    };

    const result = await appendSite(site);
    if (!result.ok) return fail(result.reason ?? 'Could not save the site.', rawUrl);

    return new Response(null, {
      status: 303,
      headers: {
        Location: `/sites/${encodeURIComponent(slug)}?flash=ok&message=${encodeURIComponent(
          `Added ${site.name}.`,
        )}`,
      },
    });
  } catch (error) {
    return fail(messageOf(error));
  }
};
