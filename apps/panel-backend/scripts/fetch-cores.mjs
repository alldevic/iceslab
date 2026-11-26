// Downloads every core artifact the manifest lists and keeps it, checked, in a
// directory: what the panel image hands to its nodes (modules/cores). Runs in
// the Dockerfile's `cores` stage, under plain node, so it reads the manifest
// source directly (Node strips the types) and shares nothing else with the app.
//
//   node fetch-cores.mjs <manifest.ts> <outDir> "<arches>"
//
// A sha256 that differs from the manifest's stops the build: the image must
// never carry a file the manifest does not vouch for.
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';

const [manifestPath, outDir, archesArg] = process.argv.slice(2);
if (!manifestPath || !outDir || archesArg === undefined) {
  console.error('usage: fetch-cores.mjs <manifest.ts> <outDir> "<arches>"');
  process.exit(2);
}
const m = await import(pathToFileURL(manifestPath).href);

const arches = archesArg.split(/[\s,]+/).filter(Boolean);
const known = [...m.CORE_ARCHES];
for (const a of arches) {
  if (!known.includes(a)) {
    console.error(`CORE_ARCHES: '${a}' is not an architecture (${known.join(', ')})`);
    process.exit(2);
  }
}

const jobs = [
  ...m.coreArtifacts(arches),
  ...m.CORE_SCRIPT_NAMES.map((n) => {
    const s = m.CORE_SCRIPTS[n];
    return { stored: m.coreScriptName(n, s), url: m.coreScriptUrl(s), sha256: s.sha256 };
  }),
];

async function fetchOne(job) {
  const final = join(outDir, job.stored);
  const part = `${final}.part`;
  let lastErr;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await fetch(job.url, { redirect: 'follow', signal: AbortSignal.timeout(300_000) });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const hash = createHash('sha256');
      const out = createWriteStream(part);
      await pipeline(
        Readable.fromWeb(res.body),
        async function* (src) {
          for await (const chunk of src) {
            hash.update(chunk);
            yield chunk;
          }
        },
        out,
      );
      const got = hash.digest('hex');
      if (got !== job.sha256) {
        // Not retried: the same URL answers the same bytes.
        await rm(part, { force: true });
        console.error(`sha256 mismatch for ${job.url}\n  got      ${got}\n  manifest ${job.sha256}`);
        process.exit(1);
      }
      await rename(part, final);
      console.log(`ok ${job.stored} ${got}`);
      return;
    } catch (err) {
      lastErr = err;
      await rm(part, { force: true });
      console.error(`attempt ${attempt} for ${job.url} failed: ${err.message}`);
      await new Promise((r) => setTimeout(r, attempt * 3000));
    }
  }
  console.error(`giving up on ${job.url}: ${lastErr?.message}`);
  process.exit(1);
}

await mkdir(outDir, { recursive: true });
// Four at a time: GitHub is the bottleneck and the set is ~30 files.
const queue = [...jobs];
await Promise.all(
  Array.from({ length: 4 }, async () => {
    for (let job = queue.shift(); job; job = queue.shift()) await fetchOne(job);
  }),
);
console.log(`${jobs.length} artifacts in ${outDir}`);
