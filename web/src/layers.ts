import { useRef, type SyntheticEvent } from 'react';

// The `popover` attribute of each open popover.
export const openPopovers = () => [...document.querySelectorAll<HTMLElement>(':popover-open')].map((p) => p.popover ?? 'auto');

// The ⋯ menu is the one light-dismiss (auto) popover; toasts and hover cards are manual or hint popovers.
export const menuOpen = () => openPopovers().includes('auto');

// A click beside a dialog that any click closes, while the ⋯ menu or a select's picker is open in it, closes only that,
// as C's catcher does. By the time the click asks the dialog to close the menu has closed already, so the press notes
// whether one was open.
export function useOuterClick() {
  const layered = useRef(false);
  const release = () => setTimeout(() => (layered.current = false));
  return {
    onPointerDownCapture: () => {
      layered.current = menuOpen() || !!document.querySelector('select:open');
    },
    onPointerUp: release,
    onPointerCancel: release,
    onCancel: (e: SyntheticEvent) => {
      if (layered.current) e.preventDefault();
    },
  };
}
