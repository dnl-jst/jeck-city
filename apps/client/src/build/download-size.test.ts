import { describe, expect, it } from 'vitest';
import { startWorldFiles } from './download-size';

describe('startWorldFiles', () => {
  const manifest = {
    chunkSize: 200,
    spawn: { x: 100, z: 100 },
    chunks: [
      { key: '0_0', x: 0, z: 0, file: 'chunk_0_0.glb' },
      { key: '9_9', x: 1800, z: 1800, file: 'chunk_9_9.glb' },
    ],
    models: [
      { chunk: '0_0', file: 'model_near.glb' },
      { chunk: '9_9', file: 'model_far.glb' },
    ],
  };

  it('takes the chunks near the spawn, their models and every non-chunk file', () => {
    const files = ['manifest.json', 'collision.bin', 'car_x.glb', 'chunk_0_0.glb', 'chunk_9_9.glb', 'model_near.glb', 'model_far.glb'];
    expect([...startWorldFiles(manifest, files)].sort()).toEqual(['car_x.glb', 'chunk_0_0.glb', 'collision.bin', 'manifest.json', 'model_near.glb']);
  });
});
