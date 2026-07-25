import { createHash } from 'node:crypto';
import { config } from '../../config.js';

/**
 * The high-entropy capability prefix on the public /geo/ path. Geo data is
 * public (the threat is scanners/DDoS, not leakage - same posture as geo-svc),
 * so the prefix is not a hard secret; it keeps the artifacts off a guessable
 * path and lets an operator rotate. Explicit GEO_ARTIFACT_TOKEN wins, else it is
 * derived deterministically from JWT_SECRET (stable per deployment).
 */
export function geoArtifactToken(): string {
  if (config.GEO_ARTIFACT_TOKEN) return config.GEO_ARTIFACT_TOKEN;
  return createHash('sha256').update(`geo-artifact:${config.JWT_SECRET}`).digest('hex').slice(0, 32);
}

/**
 * Base URL geo artifacts are fetched from: `<origin>/geo/<token>`. `origin`
 * defaults to PUBLIC_URL - the right choice for the NODE fetch (the agent dials
 * the panel's own address). CLIENT subscriptions pass `subscriptionOrigin()`
 * instead, so geo URLs embedded in a clash/sing-box/xray config ride the split
 * client domain (SUBSCRIPTION_PUBLIC_URL) when one is set - otherwise a client
 * behind a blocked CDN could reach its subscription but not the geo it references.
 */
export function geoArtifactBaseUrl(origin: string = config.PUBLIC_URL): string {
  return `${origin.replace(/\/+$/, '')}/geo/${geoArtifactToken()}`;
}
