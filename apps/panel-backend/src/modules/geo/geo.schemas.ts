import { z } from 'zod';
import { parseCidr } from './geo.compose.js';

// URL shape is validated at the route via assertFetchableUrl (https-only, no
// private/metadata hosts); here we only bound the string. nullish() lets an
// update send `null` to clear a URL, or omit it to leave it unchanged.
const UrlField = z.string().min(1).max(2048);

// Per-source refresh interval in hours (1h .. 30d). The service clamps too; this
// bounds the wire.
const RefreshInterval = z.number().int().min(1).max(24 * 30);

export const GeoSourceInputSchema = z
  .object({
    name: z.string().min(1).max(80),
    geositeUrl: UrlField.nullish(),
    geoipUrl: UrlField.nullish(),
    enabled: z.boolean().optional(),
    refreshIntervalHours: RefreshInterval.optional(),
  })
  .refine((s) => Boolean(s.geositeUrl || s.geoipUrl), {
    message: 'a geo source needs at least a geosite or geoip URL',
  });

export const GeoSourceUpdateSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  geositeUrl: UrlField.nullish(),
  geoipUrl: UrlField.nullish(),
  enabled: z.boolean().optional(),
  refreshIntervalHours: RefreshInterval.optional(),
});

// Reorder = set the source priority (first enabled with a database wins the
// full-db mirror clients fetch). The client sends the full ordered id list.
export const GeoSourceOrderSchema = z.object({
  ids: z.array(z.string().min(1).max(64)).max(256),
});

export type GeoSourceInputBody = z.infer<typeof GeoSourceInputSchema>;
export type GeoSourceUpdateBody = z.infer<typeof GeoSourceUpdateSchema>;

// ───── custom categories (G3) ─────
const CategoryRef = z.object({
  sourceId: z.string().min(1).max(64),
  category: z.string().min(1).max(128),
});
const Matcher = z.string().min(1).max(256);
// Validate manual IPs at the API edge so a bad entry is a clear 400, not a
// value the builder silently drops (composeCategory discards unparseable CIDRs).
const ManualIp = z
  .string()
  .min(1)
  .max(64)
  .refine((s) => parseCidr(s) !== null, { message: 'not a valid IP or CIDR' });

export const GeoCategoryInputSchema = z.object({
  // A category name becomes the tag of an xray `ext:geo-custom.dat:<name>`
  // routing matcher. xray splits that string on ':' (and '@' for attributes),
  // so a name containing ':' or '@' - or anything outside a safe tag charset -
  // renders an ext matcher xray can't parse, crash-looping the entry node.
  // Restrict to the same [A-Za-z0-9._-] charset the public artifact route allows.
  name: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[A-Za-z0-9._-]+$/, { message: 'name may only contain letters, digits, . _ -' }),
  domainRefs: z.array(CategoryRef).max(256).optional(),
  ipRefs: z.array(CategoryRef).max(256).optional(),
  manualDomains: z.array(Matcher).max(8192).optional(),
  manualIps: z.array(ManualIp).max(8192).optional(),
  excludeDomains: z.array(Matcher).max(8192).optional(),
  enabled: z.boolean().optional(),
});

/** PATCH: every field optional (name too). */
export const GeoCategoryUpdateSchema = GeoCategoryInputSchema.partial();

export type GeoCategoryInputBody = z.infer<typeof GeoCategoryInputSchema>;
export type GeoCategoryUpdateBody = z.infer<typeof GeoCategoryUpdateSchema>;
