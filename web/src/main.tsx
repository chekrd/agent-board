import './renamed.ts';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/bricolage-grotesque/opsz.css';
import '@fontsource-variable/hanken-grotesk';
import './theme.ts';
import './tokens.css';
import './deck.css';
import { App } from './App.tsx';
import { openLinksOutside } from './outside.ts';

openLinksOutside();

createRoot(document.getElementById('root')!).render(<App />);
