import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@qiyin/contracts': fileURLToPath(new URL('./packages/contracts/src/index.ts', import.meta.url)),
      '@qiyin/domain': fileURLToPath(new URL('./packages/domain/src/index.ts', import.meta.url)),
      '@qiyin/spatial-control': fileURLToPath(new URL('./packages/spatial-control/src/index.ts', import.meta.url)),
      '@qiyin/frontkernel-adapter': fileURLToPath(new URL('./packages/frontkernel-adapter/src/index.ts', import.meta.url)),
      '@qiyin/kernel-service': fileURLToPath(new URL('./packages/kernel-service/src/index.ts', import.meta.url)),
      '@qiyin/canvas-adapter': fileURLToPath(new URL('./packages/canvas-adapter/src/index.ts', import.meta.url)),
      '@qiyin/generation-service': fileURLToPath(new URL('./packages/generation-service/src/index.ts', import.meta.url)),
      '@qiyin/generation-backend': fileURLToPath(new URL('./packages/generation-backend/src/index.ts', import.meta.url)),
      '@qiyin/generation-backends': fileURLToPath(new URL('./packages/generation-backends/src/index.ts', import.meta.url)),
      '@qiyin/imagegen-adapter': fileURLToPath(new URL('./packages/imagegen-adapter/src/index.ts', import.meta.url)),
      '@qiyin/videogen-adapter': fileURLToPath(new URL('./packages/videogen-adapter/src/index.ts', import.meta.url)),
      '@qiyin/update-service': fileURLToPath(new URL('./packages/update-service/src/index.ts', import.meta.url)),
      '@qiyin/plugin-host': fileURLToPath(new URL('./packages/plugin-host/src/index.ts', import.meta.url)),
      '@qiyin/provider-auth': fileURLToPath(new URL('./packages/provider-auth/src/index.ts', import.meta.url)),
      '@qiyin/local-backend-host': fileURLToPath(new URL('./apps/local-backend-host/src/index.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    /* 收尾时清理测试自建的临时目录（见 tests/global-setup.ts 的说明） */
    globalSetup: ['./tests/global-setup.ts'],
  },
});
