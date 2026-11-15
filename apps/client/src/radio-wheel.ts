import { LOGOS } from './audio/logos';
import { stationLabel, type StationId } from './audio/stations';
import { WHEEL_SLOTS } from './audio/wheel-control';

/**
 * The radio wheel overlay (hold R in the car): four logo segments around a hub, the highlighted one lit gold,
 * the playing one marked with a dot. Built once; render() only touches classes and text when something changed.
 */
export class RadioWheel {
  private readonly box: HTMLDivElement;
  private readonly slots: HTMLDivElement[];
  private readonly hubName: HTMLDivElement;
  private open = false;
  private highlighted: StationId | null | undefined = undefined;
  private current: StationId | null | undefined = undefined;

  constructor(root: HTMLElement) {
    this.box = div('nn-wheel', root);
    div('nn-wheel-disc', this.box);
    div('nn-wheel-sector', this.box);
    this.slots = WHEEL_SLOTS.map((id, i) => {
      const slot = div(`nn-wheel-slot nn-wheel-slot-${i}`, this.box);
      div('nn-wheel-logo', slot).innerHTML = LOGOS[id ?? 'off'];
      const name = div('nn-wheel-name', slot);
      div('nn-wheel-dot', name);
      name.append(stationLabel(id));
      return slot;
    });
    const hub = div('nn-wheel-hub', this.box);
    div('nn-wheel-title', hub).textContent = 'Radio';
    this.hubName = div('nn-wheel-hub-name', hub);
  }

  render(s: { open: boolean; highlighted: StationId | null; current: StationId | null }): void {
    if (s.open !== this.open) {
      this.open = s.open;
      this.box.classList.toggle('nn-open', s.open);
    }
    if (s.highlighted !== this.highlighted) {
      this.highlighted = s.highlighted;
      const i = WHEEL_SLOTS.indexOf(s.highlighted);
      this.slots.forEach((el, j) => el.classList.toggle('nn-hl', j === i));
      this.box.style.setProperty('--nn-sector', `${i * 90}deg`);
      this.hubName.textContent = stationLabel(s.highlighted);
    }
    if (s.current !== this.current) {
      this.current = s.current;
      const i = WHEEL_SLOTS.indexOf(s.current);
      this.slots.forEach((el, j) => el.classList.toggle('nn-on', j === i));
    }
  }
}

function div(cls: string, parent: HTMLElement): HTMLDivElement {
  const e = document.createElement('div');
  e.className = cls;
  parent.append(e);
  return e;
}
