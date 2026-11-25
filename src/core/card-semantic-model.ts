export const CARD_EMBEDDING_DIMENSIONS = 384;
export const CARD_EMBEDDING_REVISION = '761b726dd34fb83930e26aab4e9ac3899aa1fa78';
export const CARD_EMBEDDING_VERSION = `e5-small:${CARD_EMBEDDING_REVISION}:int8:mean-v1`;
export const CARD_EMBEDDING_FILES = {
  'tokenizer.json': '0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39',
  'tokenizer_config.json': 'a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b',
  'onnx/model_int8.onnx': '4d24e2bc01a447951524466ef533e52944bf48509e6552810bcee1a2711cb02c',
} as const;
