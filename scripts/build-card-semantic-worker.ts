import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const outdirs = process.argv.slice(2);
if (!outdirs.length) throw Error('Specify one or more worker output directories');
const wasm = ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm'];
for (const outdir of outdirs) {
  await mkdir(outdir, { recursive: true });
  const build = await Bun.build({ entrypoints: ['src/plugin/card-semantic-worker.ts', 'src/plugin/card-semantic-scope-worker.ts'], outdir, target: 'bun' });
  if (!build.success) throw new AggregateError(build.logs, 'Card semantic worker build failed');
  await Promise.all(wasm.map(file => copyFile(join('node_modules/onnxruntime-web/dist', file), join(outdir, file))));
}
