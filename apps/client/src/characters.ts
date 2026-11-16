import type { Object3D } from 'three';
import { CHARACTER_VARIANTS, type CharacterVariant } from '@nn/shared';

/** localStorage key of the chosen player character (a per-viewer convenience; missing storage = the first one). */
const CHARACTER_KEY = 'nn.character';

export function storedCharacter(): CharacterVariant {
  try {
    const v = localStorage.getItem(CHARACTER_KEY);
    if (v && (CHARACTER_VARIANTS as readonly string[]).includes(v)) return v as CharacterVariant;
  } catch {
    // storage blocked: default
  }
  return CHARACTER_VARIANTS[0];
}

export function storeCharacter(v: CharacterVariant): void {
  try {
    localStorage.setItem(CHARACTER_KEY, v);
  } catch {
    // storage blocked: the choice just is not remembered
  }
}

/** Character model templates, each downloaded on first request (only the shown one is needed at start). */
export class CharacterModels {
  private readonly cache = new Map<CharacterVariant, Promise<Object3D>>();

  constructor(private readonly files: ReadonlyMap<CharacterVariant, string>, private readonly fetchModel: (file: string) => Promise<Object3D>) {}

  /** Variants that have a model, in CHARACTER_VARIANTS order. */
  get variants(): CharacterVariant[] {
    return CHARACTER_VARIANTS.filter((v) => this.files.has(v));
  }

  load(v: CharacterVariant): Promise<Object3D> {
    let p = this.cache.get(v);
    if (!p) {
      const file = this.files.get(v);
      p = file ? this.fetchModel(file) : Promise.reject(new Error(`no character model ${v}`));
      p.catch(() => this.cache.delete(v)); // a failed download may be retried with the next switch
      this.cache.set(v, p);
    }
    return p;
  }
}
