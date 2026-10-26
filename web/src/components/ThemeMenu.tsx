import { setTheme, useTheme, type Theme } from '../theme.ts';
import { Icon } from './Icon.tsx';
import menu from './SessionMenu.module.css';
import styles from './ThemeMenu.module.css';

const THEMES: { theme: Theme; label: string; note: string }[] = [
  { theme: 'system', label: 'System', note: 'Follows the light or dark setting of macOS' },
  { theme: 'light', label: 'Light', note: 'Always light' },
  { theme: 'dark', label: 'Dark', note: 'Always dark' },
];

const ICONS = { system: 'monitor', light: 'sun', dark: 'moon' } as const;

export function ThemeMenu() {
  const theme = useTheme();
  const label = `Theme: ${THEMES.find((t) => t.theme === theme)!.label}`;
  return (
    <>
      <button type="button" className={styles.button} popoverTarget="theme-menu" aria-label={label} title={label} data-theme-button>
        <Icon name={ICONS[theme]} size={17} />
      </button>
      <div id="theme-menu" popover="auto" className={`${menu.menu} ${styles.menu}`} role="menu" aria-label="Theme">
        {THEMES.map((t) => (
          <button
            key={t.theme}
            type="button"
            role="menuitemradio"
            aria-checked={t.theme === theme}
            className={`${menu.item} ${styles.item}`}
            data-theme-option={t.theme}
            onClick={() => {
              document.getElementById('theme-menu')?.hidePopover();
              setTheme(t.theme);
            }}
          >
            <span className={menu.label}>{t.label}</span>
            <span className={menu.note}>{t.note}</span>
          </button>
        ))}
      </div>
    </>
  );
}
