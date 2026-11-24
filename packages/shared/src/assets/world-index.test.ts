import { describe, expect, it } from 'vitest';
import { objectKey, parseWorldIndex, worldFileUrl, worldObjectKey } from './world-index';

const H = 'ab'.repeat(16);

describe('world index', () => {
  it('objectKey keeps the extension and fans out by the first two characters', () => {
    expect(objectKey('chunk_0_1.glb', 'ab12cd34ab12cd34ab12cd34ab12cd34')).toBe(
      'objects/ab/ab12cd34ab12cd34ab12cd34ab12cd34.glb',
    );
    expect(objectKey('transit-collision.bin', 'ff00'.repeat(8))).toBe(`objects/ff/${'ff00'.repeat(8)}.bin`);
  });

  it('objectKey adds no extension for a name without a dot', () => {
    expect(objectKey('LICENSE', H)).toBe(`objects/ab/${H}`);
  });

  it('worldFileUrl: bucket when worldUrl is set, /world/<name> otherwise', () => {
    const index = { version: 1 as const, files: { 'map.json': { hash: H, bytes: 3 } } };
    expect(worldFileUrl(index, 'https://b.example/', 'map.json')).toBe(`https://b.example/objects/ab/${H}.json`);
    expect(worldFileUrl(index, 'https://b.example', 'map.json')).toBe(`https://b.example/objects/ab/${H}.json`);
    expect(worldFileUrl(index, null, 'map.json')).toBe('/world/map.json');
  });

  it('worldFileUrl throws for a name the index does not have, with or without worldUrl', () => {
    const index = { version: 1 as const, files: {} };
    expect(() => worldFileUrl(index, 'https://b.example/', 'x.glb')).toThrow(/x\.glb/);
    expect(() => worldFileUrl(index, null, 'x.glb')).toThrow(/x\.glb/);
  });

  it('parseWorldIndex accepts a valid index', () => {
    const raw = { version: 1, files: { 'a.glb': { hash: H, bytes: 0 } } };
    expect(parseWorldIndex(raw)).toEqual(raw);
  });

  it('parseWorldIndex rejects a wrong version, a non-hex or short hash, negative bytes', () => {
    const file = { hash: H, bytes: 1 };
    expect(() => parseWorldIndex({ version: 2, files: {} })).toThrow();
    expect(() => parseWorldIndex(null)).toThrow();
    expect(() => parseWorldIndex({ version: 1 })).toThrow();
    expect(() => parseWorldIndex({ version: 1, files: { a: { ...file, hash: 'zz'.repeat(16) } } })).toThrow();
    expect(() => parseWorldIndex({ version: 1, files: { a: { ...file, hash: 'AB'.repeat(16) } } })).toThrow();
    expect(() => parseWorldIndex({ version: 1, files: { a: { ...file, hash: 'ab'.repeat(8) } } })).toThrow();
    expect(() => parseWorldIndex({ version: 1, files: { a: { ...file, bytes: -1 } } })).toThrow();
    expect(() => parseWorldIndex({ version: 1, files: { a: { ...file, bytes: 1.5 } } })).toThrow();
  });

  it('worldObjectKey', () => expect(worldObjectKey('0123456789ab')).toBe('worlds/0123456789ab.json'));
});
