import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { CARD_EMBEDDING_FILES, CARD_EMBEDDING_REVISION } from '../src/core/card-semantic-model';

if (process.argv.length !== 3) throw Error('Usage: bun scripts/fetch-card-semantic-model.ts <model-directory>');
const root = resolve(process.argv[2]);
for (const [name, sha] of Object.entries(CARD_EMBEDDING_FILES)) {
  const path = join(root, name);
  const file = Bun.file(path);
  if (await file.exists()) {
    if (Bun.CryptoHasher.hash('sha256', new Uint8Array(await file.arrayBuffer()), 'hex') === sha) continue;
    throw Error(`Existing model file hash does not match: ${name}`);
  }
  const response = await fetch(`https://huggingface.co/Xenova/multilingual-e5-small/resolve/${CARD_EMBEDDING_REVISION}/${name}`,
    { signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw Error(`Model download failed: ${name} (${response.status})`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (Bun.CryptoHasher.hash('sha256', bytes, 'hex') !== sha) throw Error(`Model hash does not match: ${name}`);
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, bytes);
  console.log(`Verified ${name}`);
}
