import { chmod } from 'node:fs/promises';
import path from 'node:path';
import { dataDirectory, lengthOf, sourceOf } from './env';
import type { ConfigSource } from './env';
import { readJsonFile, writeJsonFile } from './store';

/**
 * Writing side of configuration. The reading side lives in env.ts, which
 * deliberately does not import this module — see the note there about why the
 * data directory must be resolvable without consulting the settings file.
 *
 * Values are written to data/secrets.json rather than back into .env, because
 * .env is hand-maintained and rewriting it would destroy its comments.
 */

const secretsFile = () => path.join(dataDirectory(), 'secrets.json');

export interface FieldChoice {
  value: string;
  label: string;
}

export interface FieldDefinition {
  key: string;
  label: string;
  /** Secret fields never have their value rendered back to the page. */
  secret: boolean;
  hint: string;
  placeholder?: string;
  /** Present for preferences with a fixed set of options; renders a select. */
  choices?: FieldChoice[];
  defaultValue?: string;
}

export interface ServiceDefinition {
  id: string;
  name: string;
  what: string;
  where: string;
  fields: FieldDefinition[];
}

export const SERVICES: ServiceDefinition[] = [
  {
    id: 'display',
    name: 'Display',
    what: 'How the dashboard itself is presented.',
    where: 'Preferences, not credentials — stored the same way.',
    fields: [
      {
        key: 'CONTROL_ROOM_SITE_LABELS',
        label: 'Sidebar site labels',
        secret: false,
        hint: "Page titles are read from each site and cached. Falls back to the site's configured name when a title can't be read.",
        defaultValue: 'title',
        choices: [
          { value: 'title', label: 'Page title' },
          { value: 'domain', label: 'Domain' },
        ],
      },
    ],
  },
  {
    id: 'plausible',
    name: 'Plausible',
    what: 'Visitor analytics for every site.',
    where:
      'Plausible → Site settings → API keys. Set the base URL too if you self-host.',
    fields: [
      {
        key: 'PLAUSIBLE_API_KEY',
        label: 'API key',
        secret: true,
        hint: 'Stats API key with access to the sites you want to read.',
      },
      {
        key: 'PLAUSIBLE_BASE_URL',
        label: 'Base URL',
        secret: false,
        hint: 'Your Plausible instance. Defaults to https://plausible.io.',
        placeholder: 'https://plausible.example.org',
      },
    ],
  },
  {
    id: 'github',
    name: 'GitHub',
    what: 'Open pull requests and every CI job against them.',
    where:
      'GitHub → Settings → Developer settings → Personal access tokens. Classic token with repo (or public_repo) and read:org.',
    fields: [
      {
        key: 'GITHUB_TOKEN',
        label: 'Personal access token',
        secret: true,
        hint: 'Used by the bundled gh CLI. A classic token avoids org approval delays.',
      },
    ],
  },
  {
    id: 'cloudflare',
    name: 'Cloudflare',
    what: 'Cache purging, and zone discovery when adding a site.',
    where:
      'Cloudflare → My Profile → API Tokens. Needs Zone → Cache Purge → Purge, plus Zone → Zone → Read for discovery.',
    fields: [
      {
        key: 'CLOUDFLARE_API_TOKEN',
        label: 'API token',
        secret: true,
        hint: 'Zone-scoped is fine. Zone Read lets "add site by URL" find zone ids.',
      },
    ],
  },
  {
    id: 'netlify',
    name: 'Netlify',
    what: 'Deploy history and build state.',
    where: 'Netlify → User settings → Applications → Personal access tokens.',
    fields: [
      {
        key: 'NETLIFY_AUTH_TOKEN',
        label: 'Personal access token',
        secret: true,
        hint: 'Sites are matched by domain, so no site ids are needed.',
      },
    ],
  },
];

export const isKnownKey = (key: string): boolean =>
  SERVICES.some((service) => service.fields.some((field) => field.key === key));

export interface FieldStatus extends FieldDefinition {
  source: ConfigSource;
  length: number;
  /** Present only for non-secret fields. */
  value?: string;
}

export interface ServiceStatus extends ServiceDefinition {
  fields: FieldStatus[];
  /** True when every secret field has a value from somewhere. */
  configured: boolean;
}

export const serviceStatuses = async (): Promise<ServiceStatus[]> => {
  const stored = (await readJsonFile<Record<string, string>>(secretsFile())) ?? {};

  return SERVICES.map((service) => {
    const fields: FieldStatus[] = service.fields.map((field) => {
      const source = sourceOf(field.key);
      const length = lengthOf(field.key);
      return {
        ...field,
        source,
        length,
        // Non-secret values are safe and useful to show; secrets never are.
        value: field.secret
          ? undefined
          : (stored[field.key] ??
            process.env[field.key] ??
            field.defaultValue ??
            ''),
      };
    });

    const secretFields = fields.filter((field) => field.secret);
    // A group with no secrets (preferences) is always "configured".
    const configured =
      secretFields.length === 0 ||
      secretFields.every((field) => field.source !== 'unset');

    return { ...service, fields, configured };
  });
};

export const setSecret = async (key: string, value: string): Promise<void> => {
  const file = secretsFile();
  const current = (await readJsonFile<Record<string, string>>(file)) ?? {};
  current[key] = value;
  await writeJsonFile(file, current);

  // Best effort: keep the file owner-only. Not all filesystems honour this
  // (Windows bind mounts in particular), so a failure must not break saving.
  await chmod(file, 0o600).catch(() => undefined);
};

export const clearSecret = async (key: string): Promise<void> => {
  const file = secretsFile();
  const current = (await readJsonFile<Record<string, string>>(file)) ?? {};
  delete current[key];
  await writeJsonFile(file, current);
  await chmod(file, 0o600).catch(() => undefined);
};
