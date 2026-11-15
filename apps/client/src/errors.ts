/** A world asset request answered with a non-ok HTTP status. */
export class FetchError extends Error {
  constructor(readonly url: string, readonly status: number) {
    super(`fetch ${url} failed: HTTP ${status}`);
    this.name = 'FetchError';
  }
}

/** The browser could not create a WebGL context. */
export class NoWebGLError extends Error {
  constructor(message = 'WebGL is not available') {
    super(message);
    this.name = 'NoWebGLError';
  }
}
