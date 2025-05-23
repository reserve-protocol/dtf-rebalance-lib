import { defineConfig } from 'vite'
import viteTsconfigPaths from 'vite-tsconfig-paths'
import path from 'path'
import { lingui } from '@lingui/vite-plugin'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    viteTsconfigPaths(),
    lingui(),
  ],
  build: {
    outDir: 'build',
    sourcemap: true,
  },
  resolve: {
    alias: {
      components: path.resolve('src/components/'),
      types: path.resolve('src/types/'),
      utils: path.resolve('src/utils/'),
      '@': path.resolve(__dirname, './src'),
    },
  },
  optimizeDeps: { exclude: ['ts-node'] },
  server: {
    port: 3000,
  },
  test: {
    include: ['test/**/*.test.{ts,tsx}'],
    globals: true,
    environment: 'node',
  },
}) 