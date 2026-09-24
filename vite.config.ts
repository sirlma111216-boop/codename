import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// 화면(React)만 빌드한다. Worker 는 wrangler 가 src/server/index.ts 에서 따로 번들한다.
export default defineConfig({
  plugins: [react()],
  publicDir: 'public',
  build: {
    outDir: 'dist/client',
    // Vite 번들은 /static/ (해시 파일, 장기 캐시), 일러스트는 /assets/ (public/assets)
    assetsDir: 'static',
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
  },
});
