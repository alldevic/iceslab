import { describe, expect, it } from 'vitest';
import { AmneziawgConfigSchema } from './inbounds.schemas.js';

const base = {
  subnet: '10.66.66.0/24',
  serverPrivateKey: 'priv',
  serverPublicKey: 'pub',
};

describe('AmneziawgConfigSchema S3/S4', () => {
  it('a profile without s3/s4 is saved with zeros (1.x clients)', () => {
    const parsed = AmneziawgConfigSchema.parse({ ...base, obfuscation: {} });
    expect(parsed.obfuscation.s3).toBe(0);
    expect(parsed.obfuscation.s4).toBe(0);
  });

  it('explicit values are kept', () => {
    const parsed = AmneziawgConfigSchema.parse({ ...base, obfuscation: { s3: 32, s4: 16 } });
    expect(parsed.obfuscation.s3).toBe(32);
    expect(parsed.obfuscation.s4).toBe(16);
  });
});
