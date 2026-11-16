import { describe, expect, it } from 'vitest';
import { classifyJoinError } from './connection';

describe('classifyJoinError', () => {
  it('maps the server answers', () => {
    expect(classifyJoinError({ code: 409, message: 'version' })).toEqual({ kind: 'version' });
    expect(classifyJoinError({ code: 400, message: 'chars' })).toEqual({ kind: 'name', code: 'chars' });
    expect(classifyJoinError({ code: 429, message: 'rate' })).toEqual({ kind: 'rate' });
    expect(classifyJoinError({ code: 521, message: 'no rooms found' })).toEqual({ kind: 'full' });
  });

  it('treats everything else as unreachable', () => {
    expect(classifyJoinError(new TypeError('Failed to fetch'))).toEqual({ kind: 'unreachable' });
    expect(classifyJoinError({ code: 502, message: 'Bad Gateway' })).toEqual({ kind: 'unreachable' });
    expect(classifyJoinError({ code: 400, message: 'something else' })).toEqual({ kind: 'unreachable' });
    expect(classifyJoinError(undefined)).toEqual({ kind: 'unreachable' });
  });
});
