import type { SubscriptionTemplate, TemplateType } from '@/lib/domain/subscriptionTemplates';

/**
 * The template types whose output runs the panel's DNS rules (xray-json, its
 * array, mihomo, sing-box: the rows of DNS_FORMATS that run them). Stash and
 * the old Clash are given no rules whatever the template says.
 */
const RULE_TYPES: readonly TemplateType[] = ['xray-json', 'xray-json-array', 'mihomo', 'singbox'];

export interface DnsSkippingTemplate {
  id: string;
  type: TemplateType;
  name: string;
}

/**
 * The templates of the panel that ask for its routing and still do not get the
 * DNS rules, because their own `dns` wins whole (m19.7); a template marked `dns: merge` (m19.8) does get them and is not listed. The same facts the
 * dry run of a template warns by, read from the list. A body that did not read
 * (`null`) and a server that does not say (absent) are left out: nothing is
 * known of them.
 */
export function templatesSkippingDnsRules(templates: readonly SubscriptionTemplate[] | undefined): DnsSkippingTemplate[] {
  return (templates ?? [])
    .filter((t) => RULE_TYPES.includes(t.type) && t.ownDns === true && t.mergesDns !== true && t.asksRouting === true)
    .map((t) => ({ id: t.id, type: t.type, name: t.name }));
}
