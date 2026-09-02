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
  /**
   * sha256 of the published artefact, checked at image build.
   *
   * `null` ONLY for a core the image builds from source (see `source`): there
   * is no upstream artefact to pin, so the trust anchor moves to the source
   * tarball's sum, and the panel states the sum of the file it actually holds
   * (written beside the binary at build time). The node's check is unchanged
   * either way - it compares what arrived against what the panel said.
   */
  sha256: string | null;
}

/**
 * A core the panel COMPILES instead of downloading.
 *
 * Only sing-box, and only for one reason, measured rather than assumed: the
 * upstream release binaries are not built with `with_v2ray_api`, and sing-box
 * does not ignore an `experimental.v2ray_api` block it cannot honour - it
 * exits 1 before opening a port. So every protocol the sing-box engine serves
 * either runs with no per-user traffic accounting, or does not run at all.
 * Compiling with the tag is what buys both.
 *
 * The trust story changes shape but not strength. A downloaded core is pinned
 * by the sha256 of the artefact upstream published; a built core is pinned by
 * the sha256 of the SOURCE upstream published plus the toolchain that compiled
 * it, and the build fails on a stale sum exactly the same way. What the node
 * verifies does not change at all: it checks the bytes it received against the
 * sum the panel states in a header, and for a built core the panel states the
 * sum of the file on its own disk.
 */
export interface CoreSourceBuild {
  /** Source archive, pinned by sha256. `{version}` is substituted. */
  urlTemplate: string;
  file: string;
  sha256: string;
  /** Directory the archive unpacks into. */
  unpacksTo: string;
  /** Go package to build. */
  packagePath: string;
  /**
   * File INSIDE the tarball holding the base build tags. Read from the source
   * rather than copied here so a version bump cannot leave a stale tag list
   * behind: upstream owns which features its release has, and `extraTags` owns
   * the one addition that is ours.
   */
  tagsFile: string;
  /** Build tags on top of `tagsFile`. */
  extraTags: readonly string[];
  /**
   * The one line of upstream source this build rewrites, and why.
   *
   * sing-box's v2ray_api and xray's API are the same StatsService with the same
   * messages under two different gRPC SERVICE NAMES: sing-box registers
   * `v2ray.core.app.stats.command.StatsService` (an explicit override in
   * experimental/v2rayapi/stats.go's init), xray answers to
   * `xray.app.stats.command.StatsService`. gRPC dispatches on that string, so
   * the node-agent's stats client - the xray binary, used as a generic v2ray
   * stats client because sing-box ships no stats CLI - gets
   *
   *   failed to query stats: rpc error: code = Unimplemented
   *   desc = unknown service xray.app.stats.command.StatsService
   *
   * Measured on a lab node 2026-08-30, against a sing-box built WITH
   * with_v2ray_api and serving traffic. The claim in the agent's stats.go that
   * "sing-box's v2ray_api implements the same StatsService, so the xray CLI can
   * query it" was never true, and could not have been noticed: until the same
   * day, sing-box did not start at all.
   *
   * Renaming here rather than teaching the agent a second gRPC dialect is a
   * deliberate trade. The alternative is an HTTP/2 + protobuf client inside an
   * agent whose go.mod has NO dependencies at all, for the sake of one unary
   * call to loopback. This API is loopback-only and its only caller in the
   * world is that agent, so the name is private to this pair.
   *
   * The rename must be exact and it must be verified, because a silent no-op
   * would put the failure back where it was: build-singbox.sh counts the
   * occurrences before and after and fails the build if it did not change
   * exactly one line.
   */
  renameStatsService: { inFile: string; from: string; to: string };
  /** Toolchain pin. A different Go is a different binary. */
  goVersion: string;
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
  /**
   * True for a core with no machine code in it — mtprotoproxy is Python source.
   * Such a core is one artefact listed under every architecture with the SAME
   * sha256, which is otherwise the signature of a paste error and is checked
   * for (see core-binaries.test.ts, "no checksum appears twice"): two arches
   * claiming the same bytes normally means half the fleet gets the wrong
   * binary. Declaring it here is what tells the two apart, so the guard stays
   * sharp for every core that does have per-arch builds.
   *
   * Everything else stays identical: same fetch step, same serving route, same
   * verification on the node. Arch-independence is a property of the entry, not
   * a second code path.
   */
  archIndependent?: true;
  /** Present = the image compiles this core rather than downloading it. */
  source?: CoreSourceBuild;
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
  // The one core this panel COMPILES. See CoreSourceBuild for why: the
  // published binaries carry no `with_v2ray_api`, which is not a missing
  // nicety but the difference between the sing-box engine having per-user
  // traffic accounting and not running at all.
  //
  // The archive layout is kept identical to what upstream publishes -
  // `sing-box-<version>-linux-<arch>/sing-box` inside a .tar.gz - so the node
  // installs it with the same two lines it always used. What changed is who
  // produced the bytes, not their shape.
  //
  // Static, and that is load-bearing rather than a preference: this panel runs
  // on node:alpine and the nodes run Debian, so only a static build is ONE
  // artefact both can execute. CGO_ENABLED=0 gives that directly, which is
  // also why the `-musl` variant this used to pin is no longer relevant -
  // measured, not assumed: the plain 1.13.19 amd64 release exits 127 on alpine
  // (no ELF interpreter), the musl one runs on both, and a CGO-less build has
  // no interpreter to miss.
  'sing-box': {
    upstream: 'SagerNet/sing-box',
    version: '1.13.19',
    urlTemplate: 'https://github.com/SagerNet/sing-box/releases/download/v{version}/{file}',
    source: {
      urlTemplate: 'https://github.com/SagerNet/sing-box/archive/refs/tags/v{version}.tar.gz',
      file: 'sing-box-1.13.19-src.tar.gz',
      sha256: 'abc2f4805b3fd088c18a5694b51fed6f0e1d06632fae98029d6bf7bd79a1b3a2',
      unpacksTo: 'sing-box-1.13.19',
      packagePath: './cmd/sing-box',
      /**
       * Upstream's OWN default set (their Makefile's `TAGS ?=`), which is the
       * full release set minus `with_naive_outbound`. Not an exotic
       * combination, and the omission is what buys a static binary:
       * with_naive_outbound pulls cronet-go, which needs CGO; upstream
       * satisfies that in CGO-less builds with `with_purego`, and purego
       * reaches libdl through //go:cgo_import_dynamic, so the result is
       * DYNAMICALLY linked even at CGO_ENABLED=0 - measured, interpreter
       * /lib/ld-musl-x86_64.so.1, which a Debian node cannot run.
       *
       * Static is the requirement this panel has always had here (see the note
       * on the entry): one artefact has to execute on the alpine panel and on
       * Debian nodes both. Nothing is lost - sing-box serves INBOUNDS on a
       * node, and naive is a separate core with its own Caddy; sing-box's naive
       * OUTBOUND is a client-side feature this fork never renders.
       */
      tagsFile: 'release/DEFAULT_BUILD_TAGS_OTHERS',
      extraTags: ['with_v2ray_api'],
      renameStatsService: {
        // `inFile`, not `file`: the build script reads this manifest with a
        // line matcher, and `file` is already a key of the source block above -
        // it matched that one and tried to patch the tarball. Caught by the
        // parse-only self-check.
        inFile: 'experimental/v2rayapi/stats.go',
        from: 'v2ray.core.app.stats.command.StatsService',
        to: 'xray.app.stats.command.StatsService',
      },
      /**
       * NOT the node's pin, and the difference is measured rather than
       * stylistic: lib-go.sh pins 1.27.0 because caddy needs >= 1.25.1, and
       * sing-box 1.13.19 does not COMPILE under 1.27.0 -
       *
       *   # github.com/go-json-experiment/json
       *   alias.go:618:21: undefined: json.SkipFunc
       *   alias.go:957:14: undefined: json.DiscardUnknownMembers
       *
       * a dependency reaching into the standard library's experimental
       * encoding/json/v2, which 1.27 changed under it. 1.26.7 builds it clean.
       *
       * The Dockerfile's GO_IMAGE must carry this same version; they are two
       * places because a FROM cannot read a manifest, and core-source-build.test
       * fails when they drift.
       */
      goVersion: '1.26.7',
    },
    assets: {
      amd64: { file: 'sing-box-1.13.19-linux-amd64.tar.gz', sha256: null },
      arm64: { file: 'sing-box-1.13.19-linux-arm64.tar.gz', sha256: null },
      armv7: { file: 'sing-box-1.13.19-linux-armv7.tar.gz', sha256: null },
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
  mtprotoproxy: {
    upstream: 'alexbers/mtprotoproxy',
    version: '1.1.2',
    archIndependent: true,
    // Upstream attaches NO files to its releases — all fifteen of them — so the
    // artefact is GitHub's generated source tarball. That is the only thing
    // there is to pin, and it is worth saying what the pin is and is not worth:
    // GitHub has changed how it compresses these before, and if it does again
    // this sum stops matching. The failure lands at PANEL BUILD, loudly, on the
    // sha256 check — not on a node, and never as an unexpected file. Re-pin
    // then, after reading the diff.
    //
    // The tag tarball and the same commit's tarball differ in bytes (45103 vs
    // 45108) purely because the directory inside is named differently, so the
    // two are not interchangeable. Measured 2026-09-02.
    urlTemplate: 'https://github.com/alexbers/mtprotoproxy/archive/refs/tags/v{version}/{file}',
    assets: {
      // Pure Python: one artefact, no architecture. It is listed under each
      // arch with the same sum rather than given a special case, so the fetch
      // step, the serving route and the node's verification stay exactly as
      // they are for every other core — an arch-independent core is a property
      // of this entry, not a second code path.
      amd64: {
        file: 'v1.1.2.tar.gz',
        sha256: '4082ea3875fa524b6c8f3d08208938cdf867a79c2bf99ceda85d57dece868702',
      },
      arm64: {
        file: 'v1.1.2.tar.gz',
        sha256: '4082ea3875fa524b6c8f3d08208938cdf867a79c2bf99ceda85d57dece868702',
      },
      armv7: {
        file: 'v1.1.2.tar.gz',
        sha256: '4082ea3875fa524b6c8f3d08208938cdf867a79c2bf99ceda85d57dece868702',
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

/**
 * Where the panel downloaded an artefact from, for the build and for a report.
 *
 * `null` for an architecture upstream does not publish, AND for a core this
 * image compiles: there is no published binary to point at, and answering with
 * a URL that 404s would be worse than saying so. `coreSourceUrl` is the
 * question to ask about those.
 */
export function coreAssetUrl(name: CoreName, arch: CoreArch): string | null {
  const core = CORE_BINARIES[name] as CoreBinary;
  if (core.source) return null;
  const asset = core.assets[arch];
  if (!asset) return null;
  return core.urlTemplate.replace('{version}', core.version).replace('{file}', asset.file);
}

/** Where the source of a compiled core comes from; null for a downloaded one. */
export function coreSourceUrl(name: CoreName): string | null {
  const core = CORE_BINARIES[name] as CoreBinary;
  if (!core.source) return null;
  return core.source.urlTemplate.replace('{version}', core.version);
}

/**
 * Which pinned core actually runs a protocol.
 *
 * The node installer knows this — it is the `case "$PROTOCOL"` that decides
 * which artefact to fetch — and the panel needs the same answer to say "this
 * node runs sing-box 1.13.19, the panel carries 1.13.19". Written down once
 * rather than twice, because the two would drift and the panel's copy is the
 * one an operator reads.
 *
 * `null` means no artefact this panel pins: amneziawg drives the kernel module
 * and awg-quick, wireguard comes from apt, and naive's Caddy is compiled on the
 * node by xcaddy. Those are absences with reasons, not gaps.
 */
/**
 * The artefact behind an ENGINE, as the node names it in `CoreStatus.engine`.
 *
 * Separate from PROTOCOL_CORE because the two answer different questions.
 * PROTOCOL_CORE says which core a protocol runs on NATIVELY; this says which
 * core is running it on a given node, which the node alone knows — the
 * sing-box engine registers an adapter for `xray` and for `hysteria` too, and
 * pinning those to xray's and hysteria's versions is how a healthy node came
 * to report drift.
 *
 * Engine names are the strings `core.CoreAdapter.Engine()` returns on the
 * agent. `amneziawg`/`wireguard`/`naive` map to null for the same reason they
 * do below: the panel carries no artefact for them.
 */
export const ENGINE_CORE: Record<string, CoreName | null> = {
  xray: 'xray',
  singbox: 'sing-box',
  hysteria: 'hysteria',
  mtproto: 'mtg',
  // Two engines serve the mtproto protocol and they are different programs, so
  // they pin different artefacts. Missing this line, the cores view fell through
  // to PROTOCOL_CORE['mtproto'] and printed mtg's pinned 2.2.8 beside the
  // mtprotoproxy row — an operator reading "should be" saw another core's
  // number. It did not show as drift only because this adapter reports no
  // version of its own (upstream states one nowhere) and drift needs both.
  mtprotoproxy: 'mtprotoproxy',
  mieru: 'mita',
  naive: null,
  amneziawg: null,
  wireguard: null,
};

export const PROTOCOL_CORE: Record<string, CoreName | null> = {
  xray: 'xray',
  // SS2022 multi-user runs inside xray-core, so it reports xray's version.
  shadowsocks: 'xray',
  hysteria: 'hysteria',
  mtproto: 'mtg',
  mieru: 'mita',
  tuic: 'sing-box',
  anytls: 'sing-box',
  shadowtls: 'sing-box',
  amneziawg: null,
  wireguard: null,
  naive: null,
};

