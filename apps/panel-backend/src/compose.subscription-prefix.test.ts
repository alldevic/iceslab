import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
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

// Milestone 10.4: the geo files at /geo/<token>/<file>. The path is a constant
// (no variable), but it is still written in more than one place: a location that
// proxies it, two masks that keep the token out of the access log, and the three
// settings the backend reads.
describe('the geo files path (/geo/) and its settings', () => {
  const tpl = () => read('apps/panel-frontend/nginx.conf.template');

  it('the nginx template proxies /geo/ to the backend, with ^~ so the static-asset regex cannot take a .dat', () => {
    const t = tpl();
    const at = t.indexOf('location ^~ /geo/ {');
    expect(at, 'no `location ^~ /geo/` in nginx.conf.template: /geo/ would answer index.html with 200').toBeGreaterThan(-1);
    const block = t.slice(at, t.indexOf('\n    }\n', at));
    expect(block).toContain('proxy_pass http://$backend;');
    expect(block).toMatch(/proxy_read_timeout (\d+)s;/);
    expect(Number(/proxy_read_timeout (\d+)s;/.exec(block)![1])).toBeGreaterThanOrEqual(300);
    // The error log carries the request line, token included.
    expect(block).toMatch(/error_log [^\n]* crit;/);
  });

  it('both log masks list /geo/, so the token is never written', () => {
    const maps = [...tpl().matchAll(/^\s+"~\^[^\n]*\(\$\{SUBSCRIPTION_PATH_PREFIX\}\/\|([^)\n]*)\)\[\^\/\?\]\+/gm)];
    expect(maps.length, 'the URI map and the Referer map').toBe(2);
    for (const m of maps) expect(m[1]!.split('|'), 'a mask lacks /geo/').toContain('/geo/');
  });

  it.each(COMPOSE_FILES)('%s passes the three geo settings to the backend, off and blank by default', (file) => {
    const backend = services(read(file))['backend']!;
    expect(backend).toMatch(/^\s+GEO_SELF_HOST:\s*\$\{GEO_SELF_HOST:-false\}\s*$/m);
    expect(backend).toMatch(/^\s+GEO_ARTIFACT_TOKEN:\s*\$\{GEO_ARTIFACT_TOKEN:-\}\s*$/m);
    expect(backend).toMatch(/^\s+RATE_LIMIT_GEO_PER_MIN:\s*\$\{RATE_LIMIT_GEO_PER_MIN:-60\}\s*$/m);
  });

  // Milestone 10.5. A blank default here would override the image's own ENV and
  // leave the panel with no sing-box, so the default is the image's path.
  it.each(COMPOSE_FILES)('%s passes SINGBOX_BIN with the image\'s own path as the default', (file) => {
    expect(services(read(file))['backend']!).toMatch(/^\s+SINGBOX_BIN:\s*\$\{SINGBOX_BIN:-\/usr\/local\/bin\/sing-box\}\s*$/m);
  });

  it('the panel Dockerfile installs sing-box there and sets SINGBOX_BIN to it', () => {
    const d = read('apps/panel-backend/Dockerfile');
    expect(d).toMatch(/^COPY --from=cores \/singbox\/sing-box \/usr\/local\/bin\/sing-box$/m);
    expect(d).toMatch(/^ENV SINGBOX_BIN=\/usr\/local\/bin\/sing-box$/m);
    // From the archive the cores stage has checked, of the pinned release.
    expect(d).toContain('CORE_VERSIONS.singbox.pinned');
  });
});

// Milestone 14.8: the facade prefix (REMNAWAVE_COMPAT_PREFIX, default rw). Written
// in the backend schema, both compose files (to the backend and to the frontend),
// the image's default and filter, the nginx location and the entrypoint check.
describe('the facade prefix (REMNAWAVE_COMPAT_PREFIX) reaches the frontend container', () => {
  const FKEY = 'REMNAWAVE_COMPAT_PREFIX';
  const tpl = () => read('apps/panel-frontend/nginx.conf.template');

  it.each(COMPOSE_FILES)('%s feeds it to the backend and to the frontend, at the schema default', (file) => {
    const svc = services(read(file));
    for (const name of ['backend', 'frontend']) {
      const line = new RegExp(`^\\s+${FKEY}:\\s*\\$\\{${FKEY}:-(.*)\\}\\s*$`, 'm').exec(svc[name]!);
      expect(line, `${file}: ${name} must get ${FKEY} from \${${FKEY}:-...}`).not.toBeNull();
      expect(line![1], `${file}: ${name} defaults to a different value than the panel does`).toBe(schemaDefault(FKEY));
    }
  });

  it('the image ships the same default and a filter that passes both prefixes and no nginx variable', () => {
    const dockerfile = read('apps/panel-frontend/Dockerfile');
    expect(new RegExp(`${FKEY}=(\\S+)`).exec(dockerfile)?.[1]).toBe(schemaDefault(FKEY));
    const re = new RegExp(/NGINX_ENVSUBST_FILTER=(\S+)/.exec(dockerfile)![1]!);
    expect(re.test(FKEY)).toBe(true);
    expect(re.test(KEY)).toBe(true);
    for (const nginxVar of ['host', 'uri', 'remote_addr', 'backend', 'request_id']) expect(re.test(nginxVar)).toBe(false);
    expect(dockerfile).toContain('docker-entrypoint.d/16-compat-prefix.sh');
  });

  it('the template forwards everything under the prefix to the backend, ^~ and before the SPA fallback', () => {
    const t = tpl();
    const at = t.indexOf(`location ^~ /\${${FKEY}}/ {`);
    expect(at, 'no facade location: /rw/api/... would answer index.html with 200').toBeGreaterThan(-1);
    const block = t.slice(at, t.indexOf('\n    }\n', at));
    expect(block).toContain('proxy_pass http://$backend;');
    expect(block).toContain('proxy_set_header Host $host;');
    expect(block).toContain('proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;');
    expect(block).toContain('proxy_read_timeout 60s;');
    // No add_header of its own: the server-level security headers stay (an
    // add_header in a location drops them).
    expect(block).not.toContain('add_header');
    expect(at).toBeLessThan(t.indexOf('location / {'));
    // The facade is mounted at /<prefix> by the backend: the location covers it.
    expect(read('apps/panel-backend/src/app.ts')).toContain('prefix: `/${config.REMNAWAVE_COMPAT_PREFIX}`');
  });

  const run = (env: Record<string, string>) =>
    spawnSync('sh', [resolve(repoRoot, 'apps/panel-frontend/docker-entrypoint.d/16-compat-prefix.sh')], {
      env: { PATH: process.env['PATH'] ?? '', ...env },
      encoding: 'utf8',
    });

  it.each([['rw'], ['shop_1'], ['Facade-2']])('the entrypoint check accepts %s', (v) => {
    const r = run({ REMNAWAVE_COMPAT_PREFIX: v });
    expect(r.status, r.stderr).toBe(0);
  });

  it.each([
    ['', 'empty'],
    ['api', 'taken'],
    ['API', 'taken'],
    ['health', 'taken'],
    ['a/b', 'one path segment'],
    ['/rw', 'one path segment'],
    ['wp-admin', 'honeypot'],
    ['phpmyadmin', 'honeypot'],
    ['sub', 'SUBSCRIPTION_PATH_PREFIX'],
    ['SUB', 'SUBSCRIPTION_PATH_PREFIX'],
  ])('the entrypoint check refuses "%s"', (v, why) => {
    const r = run({ REMNAWAVE_COMPAT_PREFIX: v });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('REMNAWAVE_COMPAT_PREFIX');
    expect(r.stderr).toContain(why);
  });

  it('the entrypoint check follows a custom subscription prefix', () => {
    expect(run({ REMNAWAVE_COMPAT_PREFIX: 'sub', SUBSCRIPTION_PATH_PREFIX: '/v' }).status).toBe(0);
    expect(run({ REMNAWAVE_COMPAT_PREFIX: 'v', SUBSCRIPTION_PATH_PREFIX: '/v' }).status).toBe(1);
  });
});
