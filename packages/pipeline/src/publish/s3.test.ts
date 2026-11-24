import { describe, expect, it } from 'vitest';
import { s3Store } from './s3.js';

const env = {
  S3_ENDPOINT: 'https://s3.invalid',
  S3_REGION: 'nbg1',
  S3_BUCKET: 'bucket',
  S3_ACCESS_KEY_ID: 'key-id-value',
  S3_SECRET_ACCESS_KEY: 'secret-value',
};

describe('s3Store', () => {
  it('throws naming each missing variable, never a value', () => {
    expect(() => s3Store({})).toThrow(/S3_ENDPOINT.*S3_SECRET_ACCESS_KEY/);
    const { S3_SECRET_ACCESS_KEY: _, ...noSecret } = env;
    let message = '';
    try {
      s3Store(noSecret);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/S3_SECRET_ACCESS_KEY/);
    expect(message).not.toMatch(/S3_REGION|key-id-value|s3\.invalid/);
  });

  it('builds a store (no request) when every variable is set', () => {
    expect(Object.keys(s3Store(env)).sort()).toEqual(['delete', 'get', 'list', 'put']);
  });
});
