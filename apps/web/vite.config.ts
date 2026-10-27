import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: '/yingliu-demo/',
  plugins: [react()],
  build: {
    // 现代浏览器演示版无需二次降级转译，避免 Windows 上 esbuild 临时二进制被安全软件锁定。
    target: 'esnext',
    minify: false,
  },
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
