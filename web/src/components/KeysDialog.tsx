import { KEYS, KEYS_DIALOG } from '../keys.ts';
import styles from './KeysDialog.module.css';

export function toggleKeys() {
  const dialog = document.getElementById(KEYS_DIALOG) as HTMLDialogElement | null;
  if (!dialog) return;
  if (dialog.open) return dialog.close();
  dialog.showModal();
  dialog.focus();
}

export function KeysDialog() {
  return (
    <dialog id={KEYS_DIALOG} closedby="any" tabIndex={-1} aria-labelledby="keys-title" className={styles.dialog}>
      <header>
        <h2 id="keys-title">Keys</h2>
        <button type="button" commandfor={KEYS_DIALOG} command="close">
          Close <kbd>Esc</kbd>
        </button>
      </header>
      <dl className={styles.rows}>
        {KEYS.map((row) => (
          <div key={row.keys} className={styles.row}>
            <dt><kbd>{row.keys}</kbd></dt>
            <dd>{row.help}</dd>
          </div>
        ))}
      </dl>
    </dialog>
  );
}
