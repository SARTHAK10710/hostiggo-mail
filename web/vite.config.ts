import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// Dev: the dashboard runs on :5173 and proxies API calls to the backend on :4000.
const api = 'http://localhost:4000';
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: { '/v1': api, '/oauth': api, '/u/': api, '/webhooks': api, '/health': api },
  },
});
