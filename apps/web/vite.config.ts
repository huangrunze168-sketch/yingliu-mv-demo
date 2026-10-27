import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: '/yingliu-demo/',
  plugins: [react()],
  server: {
    watch: {
      ignored: ['**/.*.tmpdir', '**/.*.tmpdir/**'],
    },
    proxy: {
      '/yingliu-demo-api': {
        target: 'http://127.0.0.1:8791',
        changeOrigin: true,
        rewrite: path => path.replace(/^\/yingliu-demo-api/, ''),
      },
      '/api': {
        target: 'http://127.0.0.1:43121',
        changeOrigin: true,
      },
    },
  },
});
