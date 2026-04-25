import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  base: '/HaberUygulamasi/', // GitHub Pages repo adi
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return;

          if (id.includes('firebase')) return 'firebase';
          if (id.includes('react-router-dom')) return 'router';
          if (id.includes('react-dom') || id.includes('react')) return 'react-vendor';
          if (id.includes('lucide-react') || id.includes('date-fns')) return 'ui-vendor';

          return 'vendor';
        },
      },
    },
  },
})
