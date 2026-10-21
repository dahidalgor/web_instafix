import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import './styles/index.css';
import { applyTheme, watchSystemTheme } from './lib/theme';

applyTheme();
watchSystemTheme();
const root = createRoot(document.getElementById('root')!);
const isAdminHost =
  window.location.hostname === 'admin.localhost' ||
  window.location.hostname === import.meta.env.VITE_ADMIN_HOST;
// La interfaz se carga bajo demanda; la autorización real está en cada endpoint de la API.
if (isAdminHost) {
  import('./features/admin/Admin').then(({ default: Admin }) => {
    root.render(
      <StrictMode>
        <Admin />
      </StrictMode>,
    );
  });
} else
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
