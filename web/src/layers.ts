import type { SyntheticEvent } from 'react';

// The `popover` attribute of each open popover. A select's open picker light-dismisses as an auto popover does, and
// counts as one.
export const openPopovers = () => [
  ...[...document.querySelectorAll<HTMLElement>(':popover-open')].map((p) => p.popover ?? 'auto'),
  ...(document.querySelector('select:open') ? ['auto'] : []),
];

// The ⋯ menu and New task's repository picker are the light-dismiss (auto) layers; toasts and hover cards are manual
// or hint popovers.
export const menuOpen = () => openPopovers().includes('auto');

// C draws a transparent catcher under the ⋯ menu and under New task's repository picker, so a press beside either
// closes only it. Here the press closes the layer by light dismiss, and its click is swallowed, which would press
// whatever lies where C's catcher is: an option of the card, a tile, Terminal. Inside a layer, on its own toggle and on
// the toasts above it, a press works as usual. Its mousedown goes through: a cancelled one makes the light dismiss of a
// dialog around the layer uncancellable, so keepUnderLayer could not keep the dialog open.
let caught = false;

function beside(target: EventTarget | null) {
  if (!menuOpen()) return false;
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

// A double click is aimed at one thing. When its first click took that away, as an Undo takes its toast or its send
// capsule, the clicks after it would press whatever came under the pointer, a peek or another capsule, so they are
// swallowed.
let firstClick: Element | null = null;
addEventListener('click', (e) => {
  if (e.detail > 1 && firstClick && !firstClick.isConnected) {
    e.preventDefault();
    e.stopPropagation();
  } else if (e.detail <= 1) {
    firstClick = e.target instanceof Element ? e.target : null;
  }
}, true);
