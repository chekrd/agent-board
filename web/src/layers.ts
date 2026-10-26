import type { SyntheticEvent } from 'react';

// The `popover` attribute of each open popover.
export const openPopovers = () => [...document.querySelectorAll<HTMLElement>(':popover-open')].map((p) => p.popover ?? 'auto');

// The ⋯ menu is the one light-dismiss (auto) popover; toasts and hover cards are manual or hint popovers.
export const menuOpen = () => openPopovers().includes('auto');

// C draws a transparent catcher under the ⋯ menu and under New task's repository picker, so a press beside either
// closes only it. Here the press closes the layer by light dismiss, and its click is swallowed, which would press
// whatever lies where C's catcher is: an option of the card, a tile, Terminal. Inside a layer, on its own toggle and on
// the toasts above it, a press works as usual. Its mousedown goes through: a cancelled one makes the light dismiss of a
// dialog around the layer uncancellable, so keepUnderLayer could not keep the dialog open.
let caught = false;

function beside(target: EventTarget | null) {
  if (!menuOpen() && !document.querySelector('select:open')) return false;
  const el = target instanceof Element ? target : null;
  if (el?.closest(':popover-open, select:open')) return false;
  return !el?.closest('button')?.popoverTargetElement?.matches(':popover-open');
}

const swallow = (e: Event) => {
  if (!caught) return;
  e.preventDefault();
  e.stopPropagation();
};
// Once the press's click has run.
const release = () => setTimeout(() => (caught = false));

addEventListener('pointerdown', (e) => (caught = beside(e.target)), true);
for (const type of ['click', 'auxclick']) addEventListener(type, swallow, true);
addEventListener('pointerup', release, true);
addEventListener('pointercancel', release, true);

// For a dialog that any click closes: the press the catcher took closed only the layer in it, so the dialog stays.
export function keepUnderLayer(e: SyntheticEvent) {
  if (caught) e.preventDefault();
}
