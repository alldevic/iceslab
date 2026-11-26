import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The subscription path prefix is one decision written in five places: the
 * backend schema, both compose files (to the backend AND to the frontend), the
 * frontend Dockerfile's defaults and the nginx template. Nothing compared them,
 * and a mismatch does not error: the frontend's SPA fallback answers index.html
 * with HTTP 200, so a subscriber's client gets a page of HTML while every
 * status code says fine.
 *
 * So they are bound to one variable, SUBSCRIPTION_PATH_PREFIX, and one default
 * here. Facade prefixes and the geo location arrive with their own milestones
 * (stage 14, stage 10) and extend this file with the same checks.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const read = (rel: string) => readFileSync(resolve(repoRoot, rel), 'utf8');

const COMPOSE_FILES = ['docker-compose.prod.yml', 'docker-compose.ghcr.yml'];
const KEY = 'SUBSCRIPTION_PATH_PREFIX';

/** The default the panel itself falls back to: `KEY: z ... .default('X')`. */
function schemaDefault(key: string): string {
  const src = read('apps/panel-backend/src/config.ts');
  const entry = new RegExp(`^ {2}${key}:\\s*z[\\s\\S]*?\\n {2}[A-Z_]+:`, 'm').exec(src);
  const def = /\.default\('([^']*)'\)/.exec(entry ? entry[0] : '');
  if (!def) throw new Error(`no .default('...') found for ${key}; the mirror cannot be checked`);
  return def[1]!;
}

/** Text of each top-level compose service, by name (2-space-indented keys). */
function services(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  const from = src.search(/^services:\s*$/m);
  let name = '';
  for (const line of src.slice(from).split('\n').slice(1)) {
    const m = /^ {2}([A-Za-z][\w-]*):\s*$/.exec(line);
    if (m) {
      name = m[1]!;
      out[name] = '';
    } else if (name) out[name] += line + '\n';
  }
  return out;
}

describe('the subscription prefix is one variable with one default', () => {
  it.each(COMPOSE_FILES)('%s feeds it to the backend and to the frontend, at the schema default', (file) => {
    const svc = services(read(file));
    for (const name of ['backend', 'frontend']) {
      expect(svc[name], `${file} has no ${name} service`).toBeDefined();
      const line = new RegExp(`^\\s+${KEY}:\\s*\\$\\{${KEY}:-(.*)\\}\\s*$`, 'm').exec(svc[name]!);
      expect(
        line,
        `${file}: ${name} must get ${KEY} from \${${KEY}:-...}. Without it the two halves ` +
          'disagree and the SPA fallback answers the subscriber with index.html and HTTP 200.',
      ).not.toBeNull();
      expect(line![1], `${file}: ${name} defaults to a different value than the panel does`).toBe(
        schemaDefault(KEY),
      );
    }
  });

  it('the frontend image ships the same default and a filter that lets the variable through', () => {
    const dockerfile = read('apps/panel-frontend/Dockerfile');
    const def = new RegExp(`${KEY}=(\\S+)`).exec(dockerfile);
    expect(def, `apps/panel-frontend/Dockerfile declares no ${KEY}`).not.toBeNull();
    expect(def![1], "the image's default disagrees with the panel's").toBe(schemaDefault(KEY));

    const filter = /NGINX_ENVSUBST_FILTER=(\S+)/.exec(dockerfile);
    expect(filter, 'NGINX_ENVSUBST_FILTER is missing; envsubst would eat the nginx variables too').not.toBeNull();
    // The image's script keeps a variable when the filter (an egrep) matches its
    // NAME. It must keep ours and leave nginx's own ($host, $uri ...) alone.
    const re = new RegExp(filter![1]!);
    expect(re.test(KEY), 'the filter does not pass the prefix variable').toBe(true);
    for (const nginxVar of ['host', 'uri', 'remote_addr', 'backend']) {
      expect(re.test(nginxVar), `the filter lets nginx's $${nginxVar} be substituted`).toBe(false);
    }
  });

  it('the nginx template routes by the variable rather than by a hardcoded path', () => {
    const tpl = read('apps/panel-frontend/nginx.conf.template');
    expect(tpl, `nginx.conf.template has no location built from \${${KEY}}`).toMatch(
      new RegExp(`location[^\\n]*\\$\\{${KEY}\\}`),
    );
    expect(tpl, 'the template hardcodes the default as a location').not.toMatch(
      new RegExp(`location[^\\n]*${schemaDefault(KEY)}/`),
    );
  });
});
