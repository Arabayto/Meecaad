import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development run `npm run pages:dev` (API + D1) and point the Vite proxy at it.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': { target: process.env.VITE_DEV_API_ORIGIN || 'http://localhost:8788' } },
  },
});
