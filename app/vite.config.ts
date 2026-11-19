import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The app talks to a relative /graphql, proxied here in dev so the token never
// crosses origins. /sso and /api/auth are the two legs of an OIDC sign-in,
// which the server answers over plain HTTP. In production the server serves dist/ from the same origin.
// Point S3AM_SERVER_URL elsewhere to develop against a remote server.
const SERVER_URL = process.env.S3AM_SERVER_URL ?? 'http://localhost:3005';

/**
 * Every interface, so dev on a VM or a remote docker host is reachable, and a fixed port: 3001,
 * beside Engrafo's 3000. `strictPort` fails when it is taken rather than moving on quietly.
 */
const LISTEN = { host: '0.0.0.0', port: 3001, strictPort: true };

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    dedupe: ['react', 'react-dom'],
  },
  server: {
    ...LISTEN,
    proxy: {
      '/graphql': SERVER_URL,
      '/sso': SERVER_URL,
      '/api/auth': SERVER_URL,
    },
  },
  preview: LISTEN,
});
