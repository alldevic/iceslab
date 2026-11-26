import { describe, expect, it } from 'vitest';
import { CreateNamedOutboundSchema, UpdateNamedOutboundSchema } from '@backend/modules/named-outbounds/named-outbounds.schemas';
import { accepted } from '@/test/formDrive';
import { outboundCreateBody, outboundFormValues, outboundProblems, outboundUpdateBody, type OutboundFormValues } from '@/contours/traffic/lib/namedOutboundForm';
import type { NamedOutbound } from '@/lib/domain/namedOutbounds';

/*
 * The named-outbound form (a feature of the migration, with a schema of its own)
 * against CreateNamedOutboundSchema / UpdateNamedOutboundSchema (milestone
 * 17.5). The form's request is built by two pure functions, so they are what
 * runs here, on the values the form holds after the operator filled the required
 * fields of each type.
 */

const UUID = '11111111-1111-4111-8111-111111111111';
const PUBKEY = 'A'.repeat(43);
const fill = (over: Partial<OutboundFormValues>): OutboundFormValues => ({ ...outboundFormValues(null), name: 'exit-nl', ...over });

const CASES: Array<[string, OutboundFormValues]> = [
  ['vless over plain TCP', fill({ server: 'exit.example.test', port: 443, uuid: UUID })],
  ['vless with TLS and Vision', fill({ server: 'exit.example.test', port: 443, uuid: UUID, security: 'tls', vision: true, sni: 'exit.example.test', fingerprint: 'chrome', alpn: 'h2, http/1.1' })],
  ['vless with REALITY', fill({ server: '203.0.113.9', port: 443, uuid: UUID, security: 'reality', sni: 'cdn.example.test', realityPublicKey: PUBKEY, realityShortId: '', fingerprint: 'chrome' })],
  ['socks without a login', fill({ type: 'socks', server: 'proxy.example.test', port: 1080 })],
  ['socks with a login', fill({ type: 'socks', server: 'proxy.example.test', port: 1080, username: 'u', password: 'p', countryCode: 'nl' })],
];

describe('named outbound create form', () => {
  it.each(CASES)('%s: the filled form has no problems and its request passes CreateNamedOutboundSchema', (_n, values) => {
    expect(outboundProblems(values)).toEqual({});
    accepted(CreateNamedOutboundSchema, outboundCreateBody(values));
  });
});

describe('named outbound edit form, opened on a stored outbound', () => {
  const stored = (values: OutboundFormValues): NamedOutbound => {
    const body = outboundCreateBody(values);
    return {
      id: UUID,
      name: body.name,
      type: body.type,
      countryCode: (body.countryCode as string | null | undefined) ?? null,
      config: body.config,
      usedBy: [],
      createdAt: '1970-01-01T00:00:00.000Z',
      updatedAt: '1970-01-01T00:00:00.000Z',
    };
  };

  it.each(CASES)('%s: saved without an edit, nothing is sent', (_n, values) => {
    const s = stored(values);
    expect(outboundUpdateBody(s, outboundFormValues(s))).toEqual({});
  });

  it.each(CASES)('%s: renamed, the request passes UpdateNamedOutboundSchema and carries the name alone', (_n, values) => {
    const s = stored(values);
    const body = outboundUpdateBody(s, { ...outboundFormValues(s), name: 'renamed' });
    accepted(UpdateNamedOutboundSchema, body);
    expect(body).toEqual({ name: 'renamed' });
  });

  it.each(CASES)('%s: a changed port goes with the whole config, which the schema takes', (_n, values) => {
    const s = stored(values);
    const body = outboundUpdateBody(s, { ...outboundFormValues(s), port: 8443 });
    accepted(UpdateNamedOutboundSchema, body);
    expect(body.config).toMatchObject({ port: 8443 });
  });
});
