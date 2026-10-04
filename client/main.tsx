import { render } from 'preact';
import App from './app';

// Design system v1.2.0 (design/tokens.json): Questrial for Latin display and
// interface text (single 400 weight — hierarchy comes from size), Poppins as
// the Latin fallback, Noto Sans Thai / JP for รู้มั้ย? / 知ってる？.
import '@fontsource/questrial/400.css';
import '@fontsource/poppins/latin-400.css';
import '@fontsource/poppins/latin-500.css';
import '@fontsource/noto-sans-thai/thai-400.css';
import '@fontsource/noto-sans-thai/thai-600.css';
import '@fontsource/noto-sans-jp/600.css';
import './styles.css';

render(<App />, document.getElementById('app')!);
