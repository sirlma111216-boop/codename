import { defineConfig, devices } from '@playwright/test';

// 실제 Workers 런타임(wrangler dev, 로컬 workerd + Durable Object)에 독립 browser context 여러 개로 붙는다.
// localStorage 를 공유하는 가짜 멀티플레이가 아니다 — context 마다 쿠키·저장소가 따로다.
const PORT = 8788;

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    ...devices['Desktop Chrome'],
    locale: 'ko-KR',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `npm run build && npx wrangler dev --port ${PORT} --ip 127.0.0.1 --persist-to .wrangler/e2e-state`,
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
