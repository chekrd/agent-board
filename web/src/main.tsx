import { createRoot } from 'react-dom/client';
import '@fontsource-variable/bricolage-grotesque/opsz.css';
import '@fontsource-variable/hanken-grotesk';
import './tokens.css';
import { App } from './App.tsx';

createRoot(document.getElementById('root')!).render(<App />);
