import { useEffect, useEffectEvent } from 'react';
import { stepFile } from './components/DiffView.tsx';
import { toggleKeys } from './components/KeysDialog.tsx';
import { openNewTask } from './components/NewTaskForm.tsx';
import { keyAction, KEYS_DIALOG, LOCK_MS, SHEET_DIALOG, typingLock, type Action, type Card, type KeyContext, type Target } from './keys.ts';
import { openPopovers } from './layers.ts';
import { queue } from './queue.ts';
import { go, showTab, viewPath, type Route } from './router.ts';
import { undo } from './sends.ts';

// The reply box's paperclip counts as part of its field: focus on it is still writing a reply.
const EDITABLE = 'textarea, select, [contenteditable]:not([contenteditable="false"]), input:not([type="checkbox"], [type="radio"], [type="button"], [type="submit"])';
const CONTROL = 'button, a[href], input, select, summary';

// An open picker puts focus on one of its options.
export const isEditable = (el: EventTarget | null) => el instanceof Element && !!el.closest(EDITABLE);

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
    // A dialog fades out with focus still in it when there is nowhere to give it back to, and keys typed meanwhile
    // would land in a field that is going away.
    const onClose = (e: Event) => {
      const el = document.activeElement;
      if (el instanceof HTMLElement && e.target instanceof Element && e.target.contains(el)) el.blur();
    };
    addEventListener('focusin', onFocusIn, true);
    addEventListener('focusout', onFocusOut, true);
    addEventListener('keydown', onKeyDown);
    addEventListener('pointerdown', onPointerDown, true);
    addEventListener('close', onClose, true);
    return () => {
      removeEventListener('focusin', onFocusIn, true);
      removeEventListener('focusout', onFocusOut, true);
      removeEventListener('keydown', onKeyDown);
      removeEventListener('pointerdown', onPointerDown, true);
      removeEventListener('close', onClose, true);
    };
  }, []);
}

// The card the queue shows, with what its keys do. The queue sets it while a card is on screen.
export interface Front {
  card: Card;
  act: (action: Action, e: KeyboardEvent) => void;
}

let front: Front | null = null;

export function useFront(value: Front | null) {
  useEffect(() => {
    front = value;
    return () => {
      if (front === value) front = null;
    };
  }, [value]);
}

// The board's keys: switching views, New task, the Keys dialog, Undo and the sheet's tabs and files here, and the
// card's keys through the front the queue sets.
export function useBoardKeys({ route, deck, repos, artifacts }: { route: Route; deck: number; repos: boolean; artifacts: boolean }) {
  useKeys(
    () => ({
      view: route.view,
      sheet: route.sheet ? { tab: route.sheet.tab, artifacts } : null,
      card: front?.card ?? null,
      deck,
      guarded: queue.guarded(),
      repos,
    }),
    (action, e) => {
      if (action.type === 'view') go(viewPath(action.to));
      else if (action.type === 'new-task') openNewTask();
      else if (action.type === 'keys') toggleKeys();
      else if (action.type === 'undo') undo();
      else if (action.type === 'tab') showTab(action.tab);
      else if (action.type === 'file') stepFile(action.step);
      else front?.act(action, e);
    },
  );
}
