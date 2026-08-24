import type { APIRoute } from 'astro';
import { discoverSite } from '../../../lib/discover';
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

    /*
     * Discovery runs here rather than on a confirmation screen.
     *
     * Adding a site used to be two steps: look the URL up, review what four
     * services said, then save. Everything on that screen is editable
     * afterwards, so it only delayed a decision already made. The lookup still
     * happens — it just happens on the way in.
     *
     * Skipped entirely when the caller supplies its own values, which is what
     * the edit form does, so saving an edit never re-queries four services.
     */
    const explicit = ['cloudflareZoneId', 'netlifySiteId', 'githubRepo', 'plausibleDomain']
      .some((name) => field(form, name) !== undefined);

    const found = explicit ? undefined : await discoverSite(rawUrl).catch(() => undefined);

    const zoneId =
      field(form, 'cloudflareZoneId') ?? found?.cloudflare.value?.zoneId;
    const netlifySiteId = field(form, 'netlifySiteId');
    const githubRepo = field(form, 'githubRepo') ?? found?.github.value?.repo;
    const plausibleDomain =
      field(form, 'plausibleDomain') ?? found?.plausible.value?.domain;
    const plausibleBaseUrl =
      field(form, 'plausibleBaseUrl') ?? found?.plausible.value?.baseUrl;
    const plausibleKeyEnv =
      field(form, 'plausibleKeyEnv') ?? found?.plausible.value?.keyEnv;

    if (githubRepo && !/^[^/\s]+\/[^/\s]+$/.test(githubRepo)) {
      return fail(`GitHub repo should be "owner/repo", got "${githubRepo}".`, rawUrl);
    }

    const testPages = lines(String(form.get('testPages') ?? ''));
    const interactivePages = lines(String(form.get('interactivePages') ?? ''));

    /*
     * A site here is a domain, because all four integrations are domain-scoped:
     * a Cloudflare zone, a Netlify site, a Plausible property and a repository.
     * A path cannot have any of them, so "home-assistant.io/community" is not a
     * second site — it is a page of an existing one.
     *
     * The path used to be dropped in silence. It is now kept as a test page,
     * which is the thing that actually audits and captures a section.
     */
    const subPath = parsed.pathname.replace(/\/+$/, '');
    const pages =
      testPages.length > 0
        ? testPages
        : subPath !== ''
          ? ['/', subPath]
          : ['/'];

    const site: Site = {
      slug,
      name: field(form, 'name') ?? hostname.replace(/^www\./, ''),
      url: `${parsed.protocol}//${parsed.host}`,
      description: field(form, 'description'),
      cloudflare: zoneId ? { zoneId } : undefined,
      netlify: netlifySiteId ? { siteId: netlifySiteId } : undefined,
      // A blank domain is fine — the provider resolves it from the URL — but an
      // instance or key variable on its own still has to be kept.
      plausible:
        plausibleDomain || plausibleBaseUrl || plausibleKeyEnv
          ? {
              domain: plausibleDomain,
              baseUrl: plausibleBaseUrl,
              keyEnv: plausibleKeyEnv,
            }
          : undefined,
      github: githubRepo ? { repo: githubRepo } : undefined,
      testPages: pages,
      interactivePages: interactivePages.length > 0 ? interactivePages : undefined,
    };

    const result = await appendSite(site);
    if (!result.ok) {
      // The common way to hit this is pasting a URL with a path for a domain
      // already here. Saying only "slug exists" leaves you wondering where the
      // path went, so name the thing to do instead.
      if (subPath !== '') {
        return fail(
          `${hostname} is already a site. A path isn't a separate site — open it and add "${subPath}" under Test pages to audit and capture that section.`,
          rawUrl,
        );
      }
      return fail(result.reason ?? 'Could not save the site.', rawUrl);
    }

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
