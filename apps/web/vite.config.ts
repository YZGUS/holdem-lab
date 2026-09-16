import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

function normalizeBasePath(value: string | undefined) {
  if (!value || value === '/') return '/';
  return `/${value.replace(/^\/+|\/+$/g, '')}/`;
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', 'VITE_');
  const base = normalizeBasePath(env.VITE_BASE_PATH);
  const prefix = base === '/' ? '' : base.slice(0, -1);
  const stripPrefix = (path: string) => prefix && path.startsWith(prefix) ? path.slice(prefix.length) || '/' : path;

  return {
    base,
    plugins: [react()],
    server: {
      proxy: {
        [`${prefix}/ws`]: { target: 'ws://127.0.0.1:8787', ws: true, rewrite: stripPrefix },
        [`${prefix}/health`]: { target: 'http://127.0.0.1:8787', rewrite: stripPrefix },
        [`${prefix}/api`]: { target: 'http://127.0.0.1:8787', rewrite: stripPrefix },
      },
    },
  };
});
