/**
 * The proxy-core binaries this panel carries, pinned by version and sha256.
 *
 * Why the panel carries them at all. Until 2026-08-28 every node fetched its
 * core straight from GitHub: `bootstrap-singbox.sh`, `-mtg.sh` and `-mieru.sh`
 * resolved "latest" from api.github.com and installed what came back, and the
 * xray and hysteria paths ran an upstream INSTALL SCRIPT which was itself
 * commit-pinned (`pinned_fetch`) while the binary it then downloaded was not.
 * So the bytes that terminate subscriber traffic and sit next to the node's
 * mTLS key arrived from a host nobody in this system authenticates, over a
 * path that a node behind a censoring ISP may not even have.
 *
 * Now: the panel's own image downloads each artefact at BUILD time and refuses
 * to build if the sha256 does not match, and the node takes the binary from
 * the panel it already trusts — same TLS, same bearer token the heartbeat
 * uses. The trust question is answered once, by the operator who builds or
 * pulls the panel, instead of once per node per install.
 *
 * Artefacts are served BYTE-IDENTICAL to what upstream published, archive and
 * all. The node unpacks them exactly as it did before, and the sha256 below
 * means the same thing at every hop: at panel build, on the panel's disk, and
 * on the node after the download.
 *
 * ── Bumping a version ────────────────────────────────────────────────────
 * Change `version`, change every `sha256` under it, rebuild the panel image.
 * The build fails on a stale sum rather than shipping an unexpected binary,
 * so a half-done bump cannot reach a node. Cores ride the panel release: an
 * operator updates cores with the same command they already use to update the
 * panel, and `/api/system/version` already tells them a release exists.
 */

/** Node architectures, spelled the way `uname -m` is normalised on the node. */
export type CoreArch = 'amd64' | 'arm64' | 'armv7';

export const CORE_ARCHES: readonly CoreArch[] = ['amd64', 'arm64', 'armv7'];

export interface CoreAsset {
  /** File name as published, which is also the name the panel serves it under. */
  file: string;
  sha256: string;
}

export interface CoreBinary {
  /** Upstream repository, so a drift report can name where a version comes from. */
  upstream: string;
  /** Pinned release, without a leading `v`. */
  version: string;
  /** `{version}` and `{file}` are substituted. */
  urlTemplate: string;
  /**
   * Published artefact per architecture.
   *
   * An architecture ABSENT here is one upstream does not publish in a form
   * this panel can serve, and the node installer refuses with that sentence
   * rather than guessing at a URL. Both absences below are real and were found
   * by trying to download them: hysteria publishes `hysteria-linux-arm` for
   * 32-bit ARM and no `-armv7` at all — which is the file the node script has
   * always asked for, so `--protocol hysteria` on an armv7 box has never
   * worked — and mieru ships armv7 only as a tarball while the installer
   * installs a .deb.
   */
  assets: Partial<Record<CoreArch, CoreAsset>>;
}

export const CORE_BINARIES = {
  xray: {
    upstream: 'XTLS/Xray-core',
    version: '26.3.27',
    urlTemplate: 'https://github.com/XTLS/Xray-core/releases/download/v{version}/{file}',
    assets: {
      amd64: {
        file: 'Xray-linux-64.zip',
        sha256: '23cd9af937744d97776ee35ecad4972cf4b2109d1e0fe6be9930467608f7c8ae',
      },
      arm64: {
        file: 'Xray-linux-arm64-v8a.zip',
        sha256: '4d30283ae614e3057f730f67cd088a42be6fdf91f8639d82cb69e48cde80413c',
      },
      armv7: {
        file: 'Xray-linux-arm32-v7a.zip',
        sha256: 'c7265ae13c63ca0241a037df4ef960ad37938c8a67d984cc08834b2cfdf5654b',
      },
    },
  },
  'sing-box': {
    upstream: 'SagerNet/sing-box',
    version: '1.13.19',
    urlTemplate: 'https://github.com/SagerNet/sing-box/releases/download/v{version}/{file}',
    // The `-musl` variant, and that is load-bearing rather than a preference.
    // Upstream publishes three builds per architecture: the plain one and
    // `-glibc` are dynamically linked against glibc, and `-musl` is static.
    // This panel runs on node:alpine and the nodes run Debian, so only the
    // static build is ONE artefact both can execute — measured, not assumed:
    // the plain 1.13.19 amd64 build exits 127 on alpine (no ELF interpreter),
    // and the musl build answers `sing-box version` on alpine AND on
    // debian:13-slim. The old runtime block got away with a plain tarball
    // because the version it pinned, 1.11.4, still shipped statically linked.
    assets: {
      amd64: {
        file: 'sing-box-1.13.19-linux-amd64-musl.tar.gz',
        sha256: '150456f94fcf936fc2519de28d856422fb671a1ff181cd909b78f20e208fdcb8',
      },
      arm64: {
        file: 'sing-box-1.13.19-linux-arm64-musl.tar.gz',
        sha256: '5146181884310ea2381e085ef504005c81bd09f80721542127efb0a73f12cd2f',
      },
      armv7: {
        file: 'sing-box-1.13.19-linux-armv7-musl.tar.gz',
        sha256: '1fb4134b2deaa22f15cacd2156220cc6d3ba32d12fed9b0f23ad5666529b6b64',
      },
    },
  },
  hysteria: {
    upstream: 'apernet/hysteria',
    version: '2.12.2',
    // The tag is `app/v<version>`, url-encoded. Upstream releases the app and
    // the library from one repository under different tag prefixes.
    urlTemplate: 'https://github.com/apernet/hysteria/releases/download/app%2Fv{version}/{file}',
    assets: {
      amd64: {
        file: 'hysteria-linux-amd64',
        sha256: '6493dfffd55b5883f64c76c63880ecc32988f0c568c9ca9014907877b4d55f94',
      },
      arm64: {
        file: 'hysteria-linux-arm64',
        sha256: 'ebfacc1ec3a0edfd742cd68ce17f292a6092e606b9d11f99b035c1d888f3d709',
      },
      // Upstream's 32-bit ARM build is `-arm`, not `-armv7`.
      armv7: {
        file: 'hysteria-linux-arm',
        sha256: '274a0de7e2d145aa03fac017a7c7e9a995620f4eaf8db41656d37eddf2764f03',
      },
    },
  },
  mtg: {
    upstream: '9seconds/mtg',
    version: '2.2.8',
    urlTemplate: 'https://github.com/9seconds/mtg/releases/download/v{version}/{file}',
    assets: {
      amd64: {
        file: 'mtg-2.2.8-linux-amd64.tar.gz',
        sha256: '7ef19d079d85f4e00d4f8334ec1f3f3c8718e3d0ed1f3109ea9a8673138a2102',
      },
      arm64: {
        file: 'mtg-2.2.8-linux-arm64.tar.gz',
        sha256: '562a94dd4cafcb8f179b76cfeafb76da12747c8e230bc76235bf8746cc189644',
      },
      armv7: {
        file: 'mtg-2.2.8-linux-armv7.tar.gz',
        sha256: '494ee3794ed00201e5333b478236ce2f434b33f2d3445f227debe9fc386bbef0',
      },
    },
  },
  mita: {
    upstream: 'enfein/mieru',
    version: '3.36.0',
    urlTemplate: 'https://github.com/enfein/mieru/releases/download/v{version}/{file}',
    assets: {
      amd64: {
        file: 'mita_3.36.0_amd64.deb',
        sha256: '44622bea7fac732984ac6cf1189e555fd9add1969001e9b2d7cdea9416b5919a',
      },
      arm64: {
        file: 'mita_3.36.0_arm64.deb',
        sha256: 'a43dbc4d75dcb18978ea79b924ce859e2485af8b776dfc981b29a7b60644157c',
      },
      // armv7 deliberately absent: upstream ships it only as
      // mieru_<v>_linux_armv7.tar.gz and the node installs mita from a .deb.
    },
  },
} as const satisfies Record<string, CoreBinary>;

export type CoreName = keyof typeof CORE_BINARIES;

export const CORE_NAMES = Object.keys(CORE_BINARIES) as CoreName[];

/** Where the panel downloaded an artefact from, for the build and for a report. */
export function coreAssetUrl(name: CoreName, arch: CoreArch): string | null {
  const core = CORE_BINARIES[name] as CoreBinary;
  const asset = core.assets[arch];
  if (!asset) return null;
  return core.urlTemplate.replace('{version}', core.version).replace('{file}', asset.file);
}
