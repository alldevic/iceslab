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

/** Public base URL clients/nodes fetch geo artifacts from: PUBLIC_URL/geo/<token>. */
export function geoArtifactBaseUrl(): string {
  return `${config.PUBLIC_URL.replace(/\/+$/, '')}/geo/${geoArtifactToken()}`;
}
