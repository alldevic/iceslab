/**
 * G2 - v2ray/xray geosite.dat & geoip.dat codec (protobuf wire format), ported
 * from geo-svc/internal/build (Go protowire) to dependency-free TS. Parses the
 * full upstream .dat into per-category maps and re-encodes a MINIMAL .dat with
 * only the selected categories - the compile step behind the geo builder.
 *
 * Schema (v2ray):
 *   GeoSiteList { repeated GeoSite entry = 1 }
 *   GeoSite     { string country_code = 1; repeated Domain domain = 2 }
 *   Domain      { Type type = 1; string value = 2 }   // Type: 0 plain/keyword,
 *                                                     // 1 regex, 2 domain/suffix, 3 full
 *   GeoIPList   { repeated GeoIP entry = 1 }
 *   GeoIP       { string country_code = 1; repeated CIDR cidr = 2 }
 *   CIDR        { bytes ip = 1; uint32 prefix = 2 }
 *
 * Only wire types varint (0) and length-delimited (2) appear; others are skipped
 * so unknown/future fields (e.g. Domain.attribute) are tolerated on parse and
 * simply dropped on the minimal re-encode.
 */

export interface Domain {
  /** 0 plain(keyword) | 1 regex | 2 domain(suffix) | 3 full */
  type: number;
  value: string;
}

export interface CIDR {
  ip: Uint8Array; // 4 bytes (v4) or 16 (v6)
  prefix: number;
}

const utf8 = new TextDecoder();
const enc = new TextEncoder();

// ───── wire reader ─────
class Reader {
  pos = 0;
  constructor(private buf: Uint8Array) {}
  get eof(): boolean {
    return this.pos >= this.buf.length;
  }
  /** LEB128 varint as a JS number (safe: our values are < 2^53). */
  varint(): number {
    let result = 0;
    let shift = 1; // multiplier 128^i, kept as a float to dodge 32-bit `<<` overflow on lengths
    let b: number;
    do {
      b = this.buf[this.pos++]!;
      result += (b & 0x7f) * shift;
      shift *= 128;
    } while (b & 0x80);
    return result;
  }
  tag(): { field: number; wire: number } {
    const t = this.varint();
    return { field: Math.floor(t / 8), wire: t & 7 };
  }
  /** Length-delimited payload (no copy - a view into the backing buffer). */
  lenDelim(): Uint8Array {
    const len = this.varint();
    const out = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }
  skip(wire: number): void {
    if (wire === 0) this.varint();
    else if (wire === 2) this.pos += this.varint();
    else if (wire === 5) this.pos += 4;
    else if (wire === 1) this.pos += 8;
    else throw new Error(`geo.dat: unsupported wire type ${wire}`);
  }
}

// ───── wire writer ─────
// Backed by a growable Uint8Array, NOT a number[]: a real geo artifact is tens
// of MB, and pushing that many elements into a JS array trips a V8 fatal
// ("invalid size error", uncatchable, exit 133) around ~113MB - BELOW the 128MB
// fetchDat cap, so a large-but-valid source .dat could crash the whole panel
// process. A typed array with doubling growth stays off-heap and bounded by the
// input size.
class Writer {
  private buf = new Uint8Array(1024);
  private len = 0;
  private ensure(extra: number): void {
    const need = this.len + extra;
    if (need <= this.buf.length) return;
    let cap = this.buf.length;
    while (cap < need) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }
  private pushByte(b: number): void {
    this.ensure(1);
    this.buf[this.len++] = b;
  }
  varint(v: number): void {
    let n = v;
    while (n > 0x7f) {
      this.pushByte((n & 0x7f) | 0x80);
      n = Math.floor(n / 128);
    }
    this.pushByte(n & 0x7f);
  }
  tag(field: number, wire: number): void {
    this.varint(field * 8 + wire);
  }
  varintField(field: number, v: number): void {
    this.tag(field, 0);
    this.varint(v);
  }
  bytesField(field: number, payload: Uint8Array): void {
    this.tag(field, 2);
    this.varint(payload.length);
    this.ensure(payload.length);
    this.buf.set(payload, this.len);
    this.len += payload.length;
  }
  stringField(field: number, s: string): void {
    this.bytesField(field, enc.encode(s));
  }
  finish(): Uint8Array {
    // Copy to a right-sized buffer so the cached artifact doesn't pin up to 2x
    // its size (the growth buffer's slack).
    return this.buf.slice(0, this.len);
  }
}

// ───── parse ─────
// Entry-count cap. A source .dat is fetched over the network from an operator-
// configured but UNTRUSTED host (up to MAX_DAT_BYTES = 128MB). Parsing builds one
// JS object per domain/CIDR; a hostile 128MB file of minimal (2-byte) entries
// would push ~64M objects into an array and OOM-crash the whole panel (an
// uncatchable V8 fatal, and a persisted bad source turns boot warm-up into a
// crash-loop). Real geosite/geoip data is well under 4M total entries, so this
// cap is generous headroom; exceeding it throws, and the orchestrator records
// the source as failed and skips it (the build degrades instead of dying).
// Counts what is MATERIALISED, not what the file contains: a filtered parse
// builds only the categories asked for, and the cap exists to bound the objects
// in memory rather than to judge the file.
const MAX_GEO_ENTRIES = 8_000_000;

/**
 * The country code of one entry, read WITHOUT materialising its contents.
 *
 * Skipping a length-delimited field is pointer arithmetic — no object is built,
 * no string is decoded — so this pass is what makes a filtered parse cheap. It is
 * a separate pass rather than a check inside the main loop because protobuf does
 * not promise field order: relying on country_code arriving before the domains
 * would work on every generator anyone has shipped and fail silently on the one
 * that does not, by parsing everything into a category nobody asked for.
 */
function entryCategory(payload: Uint8Array): string {
  const r = new Reader(payload);
  while (!r.eof) {
    const f = r.tag();
    if (f.field === 1 && f.wire === 2) return utf8.decode(r.lenDelim()).toUpperCase();
    r.skip(f.wire);
  }
  return '';
}

/** The filter as a set, or null for "everything". */
function wantedSet(only: Iterable<string> | undefined): Set<string> | null {
  if (!only) return null;
  return new Set([...only].map((c) => c.toUpperCase()));
}

/**
 * Parse geosite.dat into UPPERCASED category -> domains (matches how xray and
 * geo-svc key lookups).
 *
 * `only` narrows what is BUILT, not what is read. Parsing is how categories are
 * enumerated, so it used to happen in full whenever a build ran at all: on the
 * runetfreedom sources that is 3.15M domains and 1.23M networks, measured at
 * 590 MB of heap and 762 MB RSS — on a build with no custom categories, whose
 * whole output is a copy of the bytes we already hold. Under the image's own
 * `--max-old-space-size=512` that is a fatal heap error, and with GEO_SELF_HOST
 * on it made the panel's start-up warm-up a crash loop.
 *
 * Every caller knows which categories it wants: a category spec names its
 * sources and their categories, and the .srs step compiles a fixed list. Passing
 * that list makes the cost proportional to what is used rather than to the size
 * of the upstream database.
 */
export function parseGeoSite(data: Uint8Array, only?: Iterable<string>): Map<string, Domain[]> {
  const out = new Map<string, Domain[]>();
  const wanted = wantedSet(only);
  const r = new Reader(data);
  let total = 0;
  while (!r.eof) {
    const { field, wire } = r.tag();
    if (field !== 1 || wire !== 2) {
      r.skip(wire);
      continue;
    }
    const payload = r.lenDelim();
    if (wanted && !wanted.has(entryCategory(payload))) continue;
    const entry = new Reader(payload);
    let cc = '';
    const doms: Domain[] = [];
    while (!entry.eof) {
      const f = entry.tag();
      if (f.field === 1 && f.wire === 2) cc = utf8.decode(entry.lenDelim());
      else if (f.field === 2 && f.wire === 2) {
        const dm = new Reader(entry.lenDelim());
        let type = 0;
        let value = '';
        while (!dm.eof) {
          const df = dm.tag();
          if (df.field === 1 && df.wire === 0) type = dm.varint();
          else if (df.field === 2 && df.wire === 2) value = utf8.decode(dm.lenDelim());
          else dm.skip(df.wire);
        }
        if (++total > MAX_GEO_ENTRIES) {
          throw new Error(`geosite.dat: too many domain entries (> ${MAX_GEO_ENTRIES})`);
        }
        doms.push({ type, value });
      } else entry.skip(f.wire);
    }
    if (cc) out.set(cc.toUpperCase(), doms);
  }
  return out;
}

/** Parse geoip.dat into UPPERCASED category -> CIDRs. `only` narrows what is
 *  built; see parseGeoSite for why that matters. */
export function parseGeoIP(data: Uint8Array, only?: Iterable<string>): Map<string, CIDR[]> {
  const out = new Map<string, CIDR[]>();
  const wanted = wantedSet(only);
  const r = new Reader(data);
  let total = 0;
  while (!r.eof) {
    const { field, wire } = r.tag();
    if (field !== 1 || wire !== 2) {
      r.skip(wire);
      continue;
    }
    const payload = r.lenDelim();
    if (wanted && !wanted.has(entryCategory(payload))) continue;
    const entry = new Reader(payload);
    let cc = '';
    const cidrs: CIDR[] = [];
    while (!entry.eof) {
      const f = entry.tag();
      if (f.field === 1 && f.wire === 2) cc = utf8.decode(entry.lenDelim());
      else if (f.field === 2 && f.wire === 2) {
        const cm = new Reader(entry.lenDelim());
        let ip = new Uint8Array(0);
        let prefix = 0;
        while (!cm.eof) {
          const cf = cm.tag();
          if (cf.field === 1 && cf.wire === 2) ip = Uint8Array.from(cm.lenDelim());
          else if (cf.field === 2 && cf.wire === 0) prefix = cm.varint();
          else cm.skip(cf.wire);
        }
        if (++total > MAX_GEO_ENTRIES) {
          throw new Error(`geoip.dat: too many CIDR entries (> ${MAX_GEO_ENTRIES})`);
        }
        cidrs.push({ ip, prefix });
      } else entry.skip(f.wire);
    }
    if (cc) out.set(cc.toUpperCase(), cidrs);
  }
  return out;
}

// ───── encode ─────
export function encodeGeoSite(m: Map<string, Domain[]>): Uint8Array {
  const top = new Writer();
  for (const [cc, doms] of m) {
    const gs = new Writer();
    gs.stringField(1, cc);
    for (const d of doms) {
      const dm = new Writer();
      dm.varintField(1, d.type);
      dm.stringField(2, d.value);
      gs.bytesField(2, dm.finish());
    }
    top.bytesField(1, gs.finish());
  }
  return top.finish();
}

export function encodeGeoIP(m: Map<string, CIDR[]>): Uint8Array {
  const top = new Writer();
  for (const [cc, cidrs] of m) {
    const gi = new Writer();
    gi.stringField(1, cc);
    for (const c of cidrs) {
      const cm = new Writer();
      cm.bytesField(1, c.ip);
      cm.varintField(2, c.prefix);
      gi.bytesField(2, cm.finish());
    }
    top.bytesField(1, gi.finish());
  }
  return top.finish();
}
