import { render } from 'preact';
import App from './app';
import { ThemeToggle } from './ui';

// IBM Plex families per the WBasic design identity: Sans + Sans Thai for
// interface text, Sans JP for the Japanese wordmark, Mono for codes and
// values. Per-subset imports keep the bundle to the glyphs we actually
// render (latin + thai + japanese); rare scripts fall back to system fonts.
import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-500.css';
import '@fontsource/ibm-plex-sans/latin-600.css';
import '@fontsource/ibm-plex-sans/latin-700.css';
import '@fontsource/ibm-plex-sans-thai/thai-400.css';
import '@fontsource/ibm-plex-sans-thai/thai-500.css';
import '@fontsource/ibm-plex-sans-thai/thai-600.css';
import '@fontsource/ibm-plex-sans-thai/thai-700.css';
import '@fontsource/ibm-plex-sans-jp/600.css';
import '@fontsource/ibm-plex-mono/latin-400.css';
import '@fontsource/ibm-plex-mono/latin-500.css';
import '@fontsource/ibm-plex-mono/latin-600.css';
import './styles.css';

render(
  <>
    <App />
    <ThemeToggle />
  </>,
  document.getElementById('app')!,
);
