/** Catalogue of the game's CC0 recordings in `public/audio/` (sources and licences: `public/audio/CREDITS.md`). */
export type FileSoundId =
  | 'step1' | 'step2' | 'step3' | 'step4' | 'land'
  | 'doorOpen' | 'doorClose' | 'engineStart' | 'engineStop'
  | 'engineIdle' | 'engineMid' | 'engineHigh'
  | 'skid' | 'impact1' | 'impact2' | 'impact3'
  | 'ambience' | 'tramBell' | 'static' | 'rain';
/** Sounds synthesised in the browser (bike, see bike-sound.ts; car horn, see horn.ts; underground train, see train-sound.ts); the mixer generates them on unlock. */
export type SynthSoundId = 'bikeTick' | 'bikeBell' | 'carHorn' | 'trainRoll' | 'trainMotor' | 'trainDoorOpen' | 'trainDoorClose' | 'trainChime';
export type SoundId = FileSoundId | SynthSoundId;

export interface SoundDef {
  /** File name inside `public/audio/` (served at `/audio/<file>`). */
  file: string;
  /** Seamless loop (cut on a sample-continuous seam). */
  loop: boolean;
  /** Engine speed the loop was recorded at (estimated from the firing frequency). */
  rpm?: number;
}

export const SOUNDS: Record<FileSoundId, SoundDef> = {
  step1: { file: 'step-1.ogg', loop: false },
  step2: { file: 'step-2.ogg', loop: false },
  step3: { file: 'step-3.ogg', loop: false },
  step4: { file: 'step-4.ogg', loop: false },
  land: { file: 'land.ogg', loop: false },
  doorOpen: { file: 'door-open.ogg', loop: false },
  doorClose: { file: 'door-close.ogg', loop: false },
  engineStart: { file: 'engine-start.ogg', loop: false },
  engineStop: { file: 'engine-stop.ogg', loop: false },
  engineIdle: { file: 'engine-idle.ogg', loop: true, rpm: 1030 },
  engineMid: { file: 'engine-mid.ogg', loop: true, rpm: 2560 },
  engineHigh: { file: 'engine-high.ogg', loop: true, rpm: 6200 },
  skid: { file: 'skid.ogg', loop: true },
  impact1: { file: 'impact-1.ogg', loop: false },
  impact2: { file: 'impact-2.ogg', loop: false },
  impact3: { file: 'impact-3.ogg', loop: false },
  ambience: { file: 'ambience.ogg', loop: true },
  tramBell: { file: 'tram-bell.ogg', loop: false },
  static: { file: 'static.ogg', loop: true },
  rain: { file: 'rain.ogg', loop: true },
};

/** Engine loops present in the set, ascending by `rpm` (all from the same car). */
export const ENGINE_LOOPS: FileSoundId[] = ['engineIdle', 'engineMid', 'engineHigh'];
