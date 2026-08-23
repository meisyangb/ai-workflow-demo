/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
    // 使用 happy-dom 作为按需 DOM 模拟环境（测试文件用 @vitest-environment happy-dom 注释声明），
    // happy-dom 对 Node 20.18 没有 ESM 链 ERR_REQUIRE_ESM 问题；
    // 此段只作用于 npm run test，与 Vercel 的 vite build 无关。
  },
});
