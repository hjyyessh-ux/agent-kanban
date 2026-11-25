import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Tokenizer } from '@huggingface/tokenizers';
import { env, InferenceSession, Tensor } from 'onnxruntime-web/wasm';
import { CARD_EMBEDDING_DIMENSIONS as dim, CARD_EMBEDDING_FILES } from '../core/card-semantic-model';

export type CardEmbeddingRequest =
  | { id: number; type: 'init'; modelDir: string; wasmDir: string }
  | { id: number; type: 'index'; texts: string[] }
  | { id: number; type: 'search'; text: string; vectors: Float32Array };

let tokenizer: Tokenizer;
let session: InferenceSession;

async function loadModel(modelDir: string, wasmDir: string) {
  const files = await Promise.all(Object.entries(CARD_EMBEDDING_FILES).map(async ([name, expected]) => {
    const bytes = new Uint8Array(await Bun.file(join(modelDir, name)).arrayBuffer());
    if (Bun.CryptoHasher.hash('sha256', bytes, 'hex') !== expected) throw Error('Invalid model asset');
    return bytes;
  }));
  const decoder = new TextDecoder();
  tokenizer = new Tokenizer(JSON.parse(decoder.decode(files[0])), JSON.parse(decoder.decode(files[1])));
  env.wasm.numThreads = 1;
  env.wasm.wasmPaths = {
    mjs: pathToFileURL(join(wasmDir, 'ort-wasm-simd-threaded.mjs')).href,
  };
  env.wasm.wasmBinary = await Bun.file(join(wasmDir, 'ort-wasm-simd-threaded.wasm')).arrayBuffer();
  session = await InferenceSession.create(files[2], { executionProviders: ['wasm'] });
  await embed(['query: 모델 준비']);
}

async function embed(texts: string[]): Promise<Float32Array[]> {
  const inputs = texts.map(text => {
    const ids = tokenizer.encode(text, { add_special_tokens: true }).ids;
    return ids.length > 512 ? [...ids.slice(0, 511), ids[ids.length - 1]] : ids;
  });
  const width = Math.max(...inputs.map(ids => ids.length));
  const shape = [inputs.length, width];
  const tokens = new BigInt64Array(inputs.length * width).fill(1n);
  const mask = new BigInt64Array(tokens.length);
  inputs.forEach((ids, i) => ids.forEach((id, j) => {
    const pos = i * width + j;
    tokens[pos] = BigInt(id);
    mask[pos] = 1n;
  }));
  const output = await session.run({
    input_ids: new Tensor('int64', tokens, shape),
    attention_mask: new Tensor('int64', mask, shape),
    token_type_ids: new Tensor('int64', new BigInt64Array(tokens.length), shape),
  });
  const data = output.last_hidden_state.data;
  if (!(data instanceof Float32Array) || data.length !== tokens.length * dim) throw Error('Invalid embedding output');
  return inputs.map((ids, i) => {
    const vector = new Float32Array(dim);
    for (let j = 0; j < ids.length; j++) {
      const offset = (i * width + j) * dim;
      for (let k = 0; k < dim; k++) vector[k] += data[offset + k];
    }
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    if (!Number.isFinite(norm) || norm === 0) throw Error('Invalid embedding norm');
    return vector.map(value => value / norm);
  });
}

function rank(query: Float32Array, vectors: Float32Array): number[] {
  const top: { row: number; score: number }[] = [];
  for (let offset = 0; offset < vectors.length; offset += dim) {
    let score = 0;
    for (let i = 0; i < dim; i++) score += query[i] * vectors[offset + i];
    if (score <= 0 || (top.length === 50 && score <= top[49].score)) continue;
    const at = top.findIndex(hit => hit.score < score);
    top.splice(at < 0 ? top.length : at, 0, { row: offset / dim, score });
    if (top.length > 50) top.pop();
  }
  return top.map(hit => hit.row);
}

self.onmessage = async ({ data }: MessageEvent<CardEmbeddingRequest>) => {
  try {
    if (data.type === 'init') {
      await loadModel(data.modelDir, data.wasmDir);
      postMessage({ id: data.id, ok: true });
    } else if (data.type === 'index') {
      const vectors = await embed(data.texts.map(text => `passage: ${text}`));
      postMessage({ id: data.id, ok: true, vectors });
    } else {
      const [query] = await embed([`query: ${data.text}`]);
      postMessage({ id: data.id, ok: true, ranked: rank(query, data.vectors) });
    }
  } catch {
    postMessage({ id: data.id, ok: false });
  }
};
