import { useRoute } from './state';
import Home from './pages/home';
import Join from './pages/join';
import Play from './pages/play';
import Host from './pages/host';
import Edit from './pages/edit';
import { AdminPage } from './admin';
import { Wordmark } from './ui';

export default function App() {
  const route = useRoute();
  const [path, query] = route.split('?');
  const seg = (path ?? '/').split('/').filter(Boolean);
  const params = new URLSearchParams(query ?? '');
  const key = seg[0] ?? '';

  switch (key) {
    case '':
      return <Home />;
    case 'join':
      return <Join code={seg[1] ?? ''} />;
    case 'play':
      return <Play code={seg[1] ?? ''} />;
    case 'host':
      return <Host code={seg[1] ?? ''} hostToken={params.get('h') ?? ''} quizId={params.get('q') ?? ''} />;
    case 'edit':
      return <Edit id={seg[1] ?? ''} token={params.get('token') ?? ''} />;
    case 'admin':
      return <AdminPage />;
    default:
      return (
        <div class="center-page">
          <Wordmark />
          <p class="muted">Page not found.</p>
        </div>
      );
  }
}
