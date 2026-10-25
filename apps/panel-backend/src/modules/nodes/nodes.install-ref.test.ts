import { describe, expect, it, vi } from 'vitest';

/**
 * A-270: the command follows the version the panel reports, whatever it is.
 * The version reader is replaced here, so this file says the same thing on a
 * release, on a candidate and on develop after the tag (X.Y.Z-rc.N+dev).
 */
const version = { current: '0.3.0-rc.1' };
vi.mock('../system/system.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../system/system.service.js')>()),
  readCurrentVersion: () => version.current,
}));

const { panelInstallCommand } = await import('./nodes.service.js');

const firstLine = (v: string) => {
  version.current = v;
  return panelInstallCommand({ panelUrl: 'https://p', token: 't', engines: [], panelIp: '198.51.100.7', acmeEmail: '' }).split('\n')[0];
};

describe('the install command by the panel version (A-270)', () => {
  it('a candidate installs its own tag', () => {
    expect(firstLine('0.3.0-rc.1')).toBe(
      'ICESLAB_NODE_REF=v0.3.0-rc.1 bash <(curl -fsSL https://raw.githubusercontent.com/icecompany-tech/iceslab/v0.3.0-rc.1/scripts/install-iceslab-node.sh) \\',
    );
  });

  it('develop after the tag, X.Y.Z-rc.N+dev, installs from main', () => {
    expect(firstLine('0.3.0-rc.1+dev')).toBe(
      'bash <(curl -fsSL https://raw.githubusercontent.com/icecompany-tech/iceslab/main/scripts/install-iceslab-node.sh) \\',
    );
  });

  it('a final installs its own tag', () => {
    expect(firstLine('0.3.0')).toBe(
      'ICESLAB_NODE_REF=v0.3.0 bash <(curl -fsSL https://raw.githubusercontent.com/icecompany-tech/iceslab/v0.3.0/scripts/install-iceslab-node.sh) \\',
    );
  });
});
