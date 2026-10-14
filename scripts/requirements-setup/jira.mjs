/**
 * A deliberately small Jira Cloud REST client for the Requirements setup scripts.
 *
 * CREDENTIALS. Read from `.env.requirements` at the repo root (gitignored by the
 * `.env*` rule) or from the process environment. They are never printed, never
 * written to the state file, and never placed in a URL.
 *
 *   JIRA_SITE=https://mgtechdemo.atlassian.net
 *   JIRA_EMAIL=<site admin's Atlassian email>
 *   JIRA_API_TOKEN=<API token from id.atlassian.com>
 *
 * READ-ONLY BY DEFAULT. A client made with `{ write: false }` refuses every
 * mutating request, except the handful of Jira endpoints that read through a
 * POST body (listed in READ_POSTS). The inspect script and every plan/dry run
 * use a read-only client, so they cannot change the site even by mistake.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const READ_POSTS = [
  /^\/rest\/api\/3\/workflows$/, // bulk get workflows by name/id
  /^\/rest\/api\/3\/workflows\/create\/validation$/,
  /^\/rest\/api\/3\/workflows\/update\/validation$/,
  /^\/rest\/api\/3\/search\/jql$/
];

function loadEnvFile() {
  const file = join(ROOT, '.env.requirements');
  if (!existsSync(file)) return {};
  const out = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

export function createClient({ write = false } = {}) {
  const env = { ...loadEnvFile(), ...process.env };
  const site = (env.JIRA_SITE ?? '').replace(/\/+$/, '');
  const missing = ['JIRA_SITE', 'JIRA_EMAIL', 'JIRA_API_TOKEN'].filter((k) => !env[k]);
  if (missing.length) {
    throw new Error(`Missing ${missing.join(', ')}. Put them in .env.requirements at the repo root (see scripts/requirements-setup/README.md).`);
  }
  if (!/^https:\/\/[a-z0-9-]+\.atlassian\.net$/.test(site)) {
    throw new Error(`JIRA_SITE must look like https://<name>.atlassian.net (got a value of length ${site.length}).`);
  }
  const auth = 'Basic ' + Buffer.from(`${env.JIRA_EMAIL}:${env.JIRA_API_TOKEN}`).toString('base64');

  async function request(method, path, body) {
    const mutating = method !== 'GET' && !(method === 'POST' && READ_POSTS.some((re) => re.test(path.split('?')[0])));
    if (mutating && !write) {
      throw new Error(`Refused ${method} ${path}: this client is read-only (run with --apply to make changes).`);
    }
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(site + path, {
        method,
        headers: {
          Authorization: auth,
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
        },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      if (res.status === 429 && attempt < 5) {
        const wait = Number(res.headers.get('retry-after') ?? 2) * 1000;
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = text; }
      if (!res.ok) {
        const err = new Error(`${method} ${path} → ${res.status}: ${typeof data === 'string' ? data.slice(0, 500) : JSON.stringify(data).slice(0, 1500)}`);
        err.status = res.status;
        err.data = data;
        throw err;
      }
      return data;
    }
  }

  return {
    site,
    write,
    get: (p) => request('GET', p),
    post: (p, b) => request('POST', p, b ?? {}),
    put: (p, b) => request('PUT', p, b ?? {}),
    del: (p) => request('DELETE', p),
    /** GET that returns null on 404 instead of throwing. */
    async find(p) {
      try { return await request('GET', p); } catch (e) { if (e.status === 404) return null; throw e; }
    },
    /** Every page of a Jira paginated list (`values` + isLast/startAt). */
    async all(p) {
      const out = [];
      let startAt = 0;
      for (;;) {
        const sep = p.includes('?') ? '&' : '?';
        const page = await request('GET', `${p}${sep}startAt=${startAt}&maxResults=100`);
        const values = page.values ?? [];
        out.push(...values);
        if (page.isLast || values.length === 0 || (page.total != null && out.length >= page.total)) return out;
        startAt += values.length;
      }
    }
  };
}
