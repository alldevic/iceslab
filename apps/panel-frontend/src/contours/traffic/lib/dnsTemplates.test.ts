import { describe, expect, it } from 'vitest';
import { templatesSkippingDnsRules } from '@/contours/traffic/lib/dnsTemplates';
import type { SubscriptionTemplate } from '@/lib/domain/subscriptionTemplates';

const tpl = (over: Partial<SubscriptionTemplate>): SubscriptionTemplate => ({
  id: 'id', type: 'singbox', name: 'Default', body: '', isDefault: false, ownDns: false, asksRouting: true, updatedAt: '', ...over,
});

describe('templatesSkippingDnsRules (m19.7)', () => {
  it('no templates, or none with its own dns: nothing to list', () => {
    expect(templatesSkippingDnsRules(undefined)).toEqual([]);
    expect(templatesSkippingDnsRules([])).toEqual([]);
    expect(templatesSkippingDnsRules([tpl({}), tpl({ type: 'mihomo', id: 'b' })])).toEqual([]);
  });

  it('lists the templates of the rule formats with their own dns that ask for the routing', () => {
    const list = [
      tpl({ id: 'a', type: 'xray-json', name: 'strict', ownDns: true }),
      tpl({ id: 'b', type: 'singbox', name: 'Default' }),
      tpl({ id: 'c', type: 'mihomo', name: 'home', ownDns: true }),
    ];
    expect(templatesSkippingDnsRules(list)).toEqual([
      { id: 'a', type: 'xray-json', name: 'strict' },
      { id: 'c', type: 'mihomo', name: 'home' },
    ]);
  });

  it('m19.8: a template marked `dns: merge` whose dns takes the rules is not listed; one marked but unable to take them still is', () => {
    const list = [
      tpl({ id: 'a', type: 'xray-json', name: 'merged', ownDns: true, mergesDns: true }),
      tpl({ id: 'b', type: 'singbox', name: 'old-form', ownDns: true, mergesDns: false }),
      tpl({ id: 'c', type: 'mihomo', name: 'older-server', ownDns: true, mergesDns: undefined }),
    ];
    expect(templatesSkippingDnsRules(list).map((x) => x.name)).toEqual(['old-form', 'older-server']);
  });

  it('leaves out stash and the old clash, a template that does not ask for the routing, and unknowns', () => {
    const list = [
      tpl({ id: 'a', type: 'stash', ownDns: true }),
      tpl({ id: 'b', type: 'clash', ownDns: true }),
      tpl({ id: 'c', type: 'singbox', ownDns: true, asksRouting: false }),
      tpl({ id: 'd', type: 'singbox', ownDns: null, asksRouting: null }),
      tpl({ id: 'e', type: 'singbox', ownDns: undefined, asksRouting: undefined }),
    ];
    expect(templatesSkippingDnsRules(list)).toEqual([]);
  });
});
