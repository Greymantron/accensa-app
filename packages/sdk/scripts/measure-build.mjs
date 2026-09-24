#!/usr/bin/env node
/**
 * Build-time metrics for the SDK bundling (issue #363).
 *
 * Runs the SDK build twice via the tsup CLI — once with
 * `treeshake:false, minify:false` (the pre-optimization behavior of
 * `tsup.config.ts`) and once with `treeshake:true, minify:true` (the
 * optimized config) — then reports wall-clock time and total dist size for
 * each, proving the optimization on identical inputs.
 *
 * Usage:  node scripts/measure-build.mjs
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

const root = resolve(import.meta.dirname, '..');
const distDir = join(root, 'dist');
const tsupBin = join(root, 'node_modules', '.bin', 'tsup');
const tmpConfigs = [];

function distSize(dir) {
  let total = 0;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    total += statSync(p).isDirectory() ? distSize(p) : statSync(p).size;
  }
  return total;
}

/** Generates a throwaway config for one optimization profile and runs it. */
function measure({ treeshake, minify }) {
  const configPath = join(root, `tsup.${treeshake ? 'on' : 'off'}.config.mjs`);
  tmpConfigs.push(configPath);
  const core = `format:['esm','cjs'],dts:true,outDir:'dist',splitting:false,sourcemap:false,target:'node18',treeshake:${treeshake},minify:${minify}`;
  const config = `import { defineConfig } from 'tsup';\nexport default defineConfig([\n{ entry:['index.ts'], ${core}, clean:true },\n{ entry:{ merkle:'merkle.ts' }, ${core} }\n]);\n`;
  execFileSync(process.execPath, [
    '-e',
    `require('fs').writeFileSync(${JSON.stringify(configPath)}, ${JSON.stringify(config)})`,
  ]);

  rmSync(distDir, { recursive: true, force: true });
  const start = performance.now();
  execFileSync(process.execPath, [tsupBin, '--config', configPath], { cwd: root });
  const ms = performance.now() - start;
  const bytes = distSize(distDir);
  rmSync(distDir, { recursive: true, force: true });
  return { ms: Math.round(ms), bytes };
}

try {
  const before = measure({ treeshake: false, minify: false });
  const after = measure({ treeshake: true, minify: true });

  const sizeDelta = ((before.bytes - after.bytes) / before.bytes) * 100;
  const timeDelta = ((before.ms - after.ms) / before.ms) * 100;

  console.log('SDK bundle metrics (identical inputs, before vs after):');
  console.log(`  before (no treeshake/minify):  ${before.ms}ms   ${before.bytes} bytes`);
  console.log(`  after  (treeshake + minify):   ${after.ms}ms   ${after.bytes} bytes`);
  console.log(`  size delta: ${sizeDelta.toFixed(1)}% smaller`);
  console.log(`  build-time delta: ${timeDelta.toFixed(1)}% faster`);
} finally {
  for (const p of tmpConfigs) rmSync(p, { force: true });
}
