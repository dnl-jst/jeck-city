// Chromium flags for the headless checks: hardware WebGL through ANGLE on the host GPU (EGL) by default;
// NN_SOFTWARE_GL=1 falls back to SwiftShader (CPU) on machines without a usable GPU, e.g. CI.
export const browserArgs = process.env.NN_SOFTWARE_GL === '1'
  ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']
  : ['--use-angle=gl-egl', '--enable-gpu', '--ignore-gpu-blocklist'];
