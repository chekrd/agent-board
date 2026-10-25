import { useEffect, useEffectEvent } from 'react';
import { keyAction, KEYS_DIALOG, LOCK_MS, SHEET_DIALOG, typingLock, type Action, type KeyContext, type Target } from './keys.ts';

const EDITABLE = 'textarea, select, [contenteditable]:not([contenteditable="false"]), input:not([type="checkbox"], [type="radio"], [type="button"], [type="submit"], [type="file"])';
const CONTROL = 'button, a[href], input, select, summary';

export const isEditable = (el: EventTarget | null) => el instanceof Element && el.matches(EDITABLE);

const openPopovers = () => [...document.querySelectorAll<HTMLElement>(':popover-open')].map((p) => p.popover ?? 'auto');

// The ⋯ menu is the one light-dismiss (auto) popover; toasts and hover cards are manual or hint popovers.
export const menuOpen = () => openPopovers().includes('auto');

function target(el: EventTarget | null): Target {
  const at = el instanceof Element ? el : null;
  return {
    editable: isEditable(at),
    control: !!at?.closest(CONTROL),
    option: !!at?.closest('[data-option]'),
    resizer: !!at?.closest('[role="separator"]'),
  };
}

function dom(e: KeyboardEvent): Pick<KeyContext, 'target' | 'modal' | 'popovers'> {
  const modal = document.querySelector(`dialog:modal:not(#${SHEET_DIALOG})`);
  return {
    target: target(e.target),
    modal: modal ? (modal.id === KEYS_DIALOG ? 'keys' : 'other') : null,
    popovers: openPopovers(),
  };
}

// The board's one keydown listener. `context` gives what the app knows (view, sheet, front card, guard); the DOM
// gives the rest. A field that unmounts while typed in leaves focus on the page, and the typing lock takes the keys
// that follow until the typing stops.
export function useKeys(context: () => Omit<KeyContext, 'target' | 'modal' | 'popovers'>, dispatch: (action: Action, e: KeyboardEvent) => void) {
  const press = useEffectEvent((e: KeyboardEvent) => {
    const action = keyAction({ ...context(), ...dom(e) }, e);
    if (!action) return;
    e.preventDefault();
    dispatch(action, e);
  });

  useEffect(() => {
    const lock = typingLock();
    let field: Element | null = null;
    let typedAt = 0;
    const onPage = () => !document.activeElement || document.activeElement === document.body;
    const lost = (typing: boolean) => {
      if (!field || field.isConnected) return;
      field = null;
      if (typing && onPage()) lock.start();
    };
    const onFocusIn = (e: FocusEvent) => {
      field = isEditable(e.target) ? (e.target as Element) : null;
    };
    // Chrome also fires focusout when a focused field is removed; for a browser that does not, the next key finds
    // the field gone.
    const onFocusOut = (e: FocusEvent) => {
      const left = e.target;
      if (left !== field) return;
      queueMicrotask(() => {
        if (!field || field !== left) return;
        if (field.isConnected) field = null;
        else lost(true);
      });
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isEditable(e.target)) {
        typedAt = Date.now();
        return;
      }
      lost(Date.now() - typedAt < LOCK_MS);
      if (lock.takes(e)) {
        e.preventDefault();
        return;
      }
      press(e);
    };
    const onPointerDown = () => lock.end();
    addEventListener('focusin', onFocusIn, true);
    addEventListener('focusout', onFocusOut, true);
    addEventListener('keydown', onKeyDown);
    addEventListener('pointerdown', onPointerDown, true);
    return () => {
      removeEventListener('focusin', onFocusIn, true);
      removeEventListener('focusout', onFocusOut, true);
      removeEventListener('keydown', onKeyDown);
      removeEventListener('pointerdown', onPointerDown, true);
    };
  }, []);
}
