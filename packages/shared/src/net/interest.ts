import { INTEREST_RADIUS, INTEREST_RELEASE } from './constants';

export type InterestEntity = { key: string; x: number; z: number };

/**
 * Per-client interest set with hysteresis: an entity enters within INTEREST_RADIUS of the focus and stays until it is
 * farther than INTEREST_RELEASE (so entities at the edge do not flicker in and out). Keys: p<slot>, c<id>, l<i>.
 */
export class Interest {
  private inside = new Set<string>();

  /** Recomputes and returns the set of keys currently of interest; entities not passed in drop out. */
  update(focus: { x: number; z: number }, entities: Iterable<InterestEntity>): Set<string> {
    const next = new Set<string>();
    for (const e of entities) {
      const d = Math.hypot(e.x - focus.x, e.z - focus.z);
      if (d <= INTEREST_RADIUS || (d <= INTEREST_RELEASE && this.inside.has(e.key))) next.add(e.key);
    }
    this.inside = next;
    return next;
  }
}
