import { describe, expect, it } from 'vitest';
import { countryFlag, subscriptionServerName } from './country-flag.js';

describe('countryFlag', () => {
  it('builds the emoji from regional indicators', () => {
    expect(countryFlag('RU')).toBe('🇷🇺');
    expect(countryFlag('SE')).toBe('🇸🇪');
    expect(countryFlag('NL')).toBe('🇳🇱');
  });

  it('accepts lowercase and surrounding space', () => {
    expect(countryFlag(' de ')).toBe('🇩🇪');
  });

  it('returns nothing rather than mojibake for a missing or bogus code', () => {
    for (const bad of [null, undefined, '', 'X', 'XYZ', '12', 'R1']) {
      expect(countryFlag(bad)).toBe('');
    }
  });
});

describe('subscriptionServerName', () => {
  it("uses the host's own name, not the node's", () => {
    // The regression: clients showed "ru-test1 · Ru-xhttp-reality", pairing an
    // internal node name with the label the operator actually wrote.
    expect(
      subscriptionServerName({
        hostRemark: 'Ru-xhttp-reality',
        nodeName: 'ru-test1',
        countryCode: 'RU',
      }),
    ).toBe('🇷🇺 Ru-xhttp-reality');
  });

  it('falls back to the node name for the auto-created Default host', () => {
    expect(
      subscriptionServerName({ hostRemark: 'Default', nodeName: 'se-test1', countryCode: 'SE' }),
    ).toBe('🇸🇪 se-test1');
    expect(
      subscriptionServerName({ hostRemark: '', nodeName: 'se-test1', countryCode: 'SE' }),
    ).toBe('🇸🇪 se-test1');
  });

  it('omits the flag when the node has no country, without a stray space', () => {
    expect(subscriptionServerName({ hostRemark: 'Direct', nodeName: 'n1', countryCode: null })).toBe(
      'Direct',
    );
  });

  it('puts the flag first so it survives truncation in a client list', () => {
    const name = subscriptionServerName({
      hostRemark: 'A very long host name that a narrow client will cut off',
      nodeName: 'n1',
      countryCode: 'NL',
    });
    expect(name.startsWith('🇳🇱 ')).toBe(true);
  });
});
