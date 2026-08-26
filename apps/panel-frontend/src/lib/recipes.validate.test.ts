import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateXrayConfig, type ValidationIssue } from './recipes';
import en from '../i18n/locales/en';
import ru from '../i18n/locales/ru';

/**
 * This validator is the only thing that tells an operator, while they are
 * typing, whether the xray profile they are building will work. It is also
 * purely advisory: ProfileFormModal renders its issues as coloured alerts and
 * nothing gates the save button, so an `error` here is the loudest colour and
 * not a guard. That makes a FALSE issue the expensive direction — the operator
 * is told in red not to build a configuration that works, and has nothing to
 * check it against.
 *
 * That is what had happened: the Vision rule said `network !== 'raw'`, while
 * the backend deliberately preserves Vision on xhttp too. Both facts were
 * measured against xray 26.3.27 and written down on the backend side; this
 * side had a second opinion and no test.
 */

const BACKEND = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'panel-backend',
  'src',
  'modules',
  'inbounds',
);

/** Read a `new Set([...])` literal out of a backend source file. */
function backendSet(file: string, name: string): string[] {
  const src = readFileSync(join(BACKEND, file), 'utf8');
  const m = new RegExp(`const ${name} = new Set\\(\\[([^\\]]*)\\]\\)`).exec(src);
  if (!m) throw new Error(`${name} not found in ${file}`);
  return [...m[1]!.matchAll(/'([a-z0-9]+)'/g)].map((x) => x[1]!).sort();
}

const base = { xrayNetwork: 'raw', xrayFlow: '', xraySubprotocol: 'vless' };
const check = (over: Partial<typeof base>): ValidationIssue[] =>
  validateXrayConfig({ ...base, ...over });
const errorsOf = (over: Partial<typeof base>): string[] =>
  check(over)
    .filter((i) => i.level === 'error')
    .map((i) => i.key);

/** Every network the form's own list can produce, plus one it cannot. */
const NETWORKS = ['raw', 'xhttp', 'grpc', 'ws', 'kcp'];

describe('the two sets this validator shares with the backend', () => {
  it('reads them out of the backend at all', () => {
    // The control: a regex that matched nothing would make both comparisons
    // below compare empty lists and pass.
    expect(backendSet('inbounds.schemas.ts', 'REALITY_TRANSPORTS').length).toBe(3);
    expect(backendSet('xray-transport-fields.ts', 'NETWORKS_CARRYING_VISION').length).toBe(2);
  });

  it('flags exactly the networks REALITY cannot carry', () => {
    // The backend refuses these at save with a 400. A network this side
    // stayed quiet about would be a save that fails with a message from the
    // API instead of an explanation in the form.
    const rejected = NETWORKS.filter((n) =>
      errorsOf({ xrayNetwork: n }).includes('validation.xray.networkInvalid'),
    );
    const carried = backendSet('inbounds.schemas.ts', 'REALITY_TRANSPORTS');
    expect(rejected.sort()).toEqual(NETWORKS.filter((n) => !carried.includes(n)).sort());
  });

  it('flags Vision exactly where the backend would drop it', () => {
    const flagged = NETWORKS.filter((n) =>
      errorsOf({ xrayNetwork: n, xrayFlow: 'xtls-rprx-vision' }).includes(
        'validation.xray.visionNeedsRawOrXhttp',
      ),
    );
    const carries = backendSet('xray-transport-fields.ts', 'NETWORKS_CARRYING_VISION');
    expect(flagged.sort()).toEqual(NETWORKS.filter((n) => !carries.includes(n)).sort());
  });
});

describe('validateXrayConfig', () => {
  // The regression, named: this combination is one the backend preserves on
  // purpose, and the form used to call it an error in red.
  it('says nothing against xhttp with Vision', () => {
    expect(check({ xrayNetwork: 'xhttp', xrayFlow: 'xtls-rprx-vision' })).toEqual([]);
  });

  it('says nothing against the canonical raw + Vision profile', () => {
    expect(check({ xrayNetwork: 'raw', xrayFlow: 'xtls-rprx-vision' })).toEqual([]);
  });

  it('flags gRPC with Vision, which loads and then rejects every client', () => {
    expect(errorsOf({ xrayNetwork: 'grpc', xrayFlow: 'xtls-rprx-vision' })).toEqual([
      'validation.xray.visionNeedsRawOrXhttp',
    ]);
  });

  it('flags a network REALITY refuses, naming it', () => {
    const issue = check({ xrayNetwork: 'ws' }).find(
      (i) => i.key === 'validation.xray.networkInvalid',
    );
    expect(issue?.level).toBe('error');
    expect(issue?.args).toEqual({ network: 'ws' });
  });

  it('warns that trojan ignores any flow it is given', () => {
    const keys = check({ xraySubprotocol: 'trojan', xrayFlow: 'xtls-rprx-vision' }).map(
      (i) => i.key,
    );
    expect(keys).toContain('validation.xray.trojanIgnoresFlow');
  });

  it('mentions the throughput cost of raw without Vision, as info only', () => {
    const issues = check({ xrayNetwork: 'raw', xrayFlow: '' });
    expect(issues.map((i) => i.key)).toEqual(['validation.xray.rawWithoutVisionSlow']);
    expect(issues[0]!.level).toBe('info');
  });
});

/**
 * The keys these issues carry reach i18n as `t(issue.key)` — a dynamic call,
 * which is exactly the form the locale scan cannot see (it reads literal
 * `t('a.b')` only, and counts what it misses). A key that does not resolve
 * renders as itself: the operator gets `validation.xray.networkInvalid` in an
 * alert box instead of a sentence.
 */
describe('every issue key resolves in both locales', () => {
  const resolve = (bundle: unknown, key: string): unknown =>
    key.split('.').reduce<unknown>((o, part) => {
      if (o === null || typeof o !== 'object') return undefined;
      return (o as Record<string, unknown>)[part];
    }, bundle);

  // Every issue this validator can produce, from the inputs that produce them.
  const allKeys = [
    ...new Set(
      [
        check({ xrayNetwork: 'ws' }),
        check({ xrayNetwork: 'grpc', xrayFlow: 'xtls-rprx-vision' }),
        check({ xraySubprotocol: 'trojan', xrayFlow: 'xtls-rprx-vision' }),
        check({ xrayNetwork: 'raw', xrayFlow: '' }),
      ]
        .flat()
        .map((i) => i.key),
    ),
  ];

  it('produced every issue the validator can emit', () => {
    // The control, again: an empty key list would resolve vacuously.
    expect(allKeys.length).toBe(4);
  });

  it.each(allKeys)('%s is a string in en and ru', (key) => {
    expect(typeof resolve(en, key), `en is missing ${key}`).toBe('string');
    expect(typeof resolve(ru, key), `ru is missing ${key}`).toBe('string');
  });
});
