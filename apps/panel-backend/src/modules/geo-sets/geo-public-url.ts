import { createHash, timingSafeEqual } from 'node:crypto';
import { config, subscriptionOrigin, type Config } from '../../config.js';

/**
 * Where the geo files are served to clients and under which token (milestone
 * 10.4, geo-public.routes.ts). Pure: the config is a parameter so a test can
 * hand it any shape.
 */

type TokenCfg = Pick<Config, 'GEO_ARTIFACT_TOKEN' | 'JWT_SECRET'>;
type BaseCfg = TokenCfg & Pick<Config, 'PUBLIC_URL' | 'SUBSCRIPTION_PUBLIC_URL'>;

/**
 * The one token of the panel: GEO_ARTIFACT_TOKEN when set, else derived from
 * JWT_SECRET (32 hex, stable per deployment, changes with the secret). The
 * derivation is domain-separated so the token says nothing of the secret.
 */
export function geoArtifactToken(cfg: TokenCfg = config): string {
  if (cfg.GEO_ARTIFACT_TOKEN) return cfg.GEO_ARTIFACT_TOKEN;
  return createHash('sha256').update(`geo-artifact:${cfg.JWT_SECRET}`).digest('hex').slice(0, 32);
}

/**
 * `<origin>/geo/<token>`: the subscription's origin when the operator split
 * /sub onto its own domain (the client that can reach only that one must find
 * the files there), the panel's otherwise. Append `/<file name>`.
 */
export function geoArtifactBaseUrl(cfg: BaseCfg = config): string {
  return `${subscriptionOrigin(cfg)}/geo/${geoArtifactToken(cfg)}`;
}

/** Constant-time: both sides are hashed first, so the length does not leak either. */
export function isGeoArtifactToken(given: string, cfg: TokenCfg = config): boolean {
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(geoArtifactToken(cfg)).digest();
  return timingSafeEqual(a, b);
}
