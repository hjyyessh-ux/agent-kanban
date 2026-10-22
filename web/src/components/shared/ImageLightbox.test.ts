import { describe, expect, test } from 'bun:test';
import { MAX_ZOOM, MIN_ZOOM, stepZoom } from './ImageLightbox';

describe('stepZoom', () => {
  test('steps in and out by 25%', () => {
    expect(stepZoom(1, 1)).toBe(1.25);
    expect(stepZoom(1, -1)).toBe(0.8);
  });

  test('clamps to the zoom range', () => {
    expect(stepZoom(MAX_ZOOM, 1)).toBe(MAX_ZOOM);
    expect(stepZoom(MIN_ZOOM, -1)).toBe(MIN_ZOOM);
  });
});
