import { defineConfig, devices } from '@playwright/test';

// 기본: 실제 Workers 런타임(wrangler dev, 로컬 workerd + Durable Object)에 독립 browser context 여러 개로 붙는다.
// localStorage 를 공유하는 가짜 멀티플레이가 아니다 — context 마다 쿠키·저장소가 따로다.
// E2E_BASE_URL 을 주면 로컬 서버를 띄우지 않고 그 주소(staging/production)를 검사한다.
//   예) E2E_BASE_URL=https://codename-staging.<계정>.workers.dev npm run test:e2e
const PORT = 8788;
const remote = process.env.E2E_BASE_URL;

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  expect: { timeout: remote ? 15_000 : 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  // 원격에서는 서버 재시작 테스트를 할 수 없다
  testIgnore: remote ? ['**/restart.spec.ts', '**/class-restart.spec.ts'] : [],
  use: {
    baseURL: remote ?? `http://127.0.0.1:${PORT}`,
    ...devices['Desktop Chrome'],
    locale: 'ko-KR',
    trace: 'retain-on-failure',
  },
  webServer: remote
    ? undefined
    : {
        command: `npm run build && npx wrangler dev --port ${PORT} --ip 127.0.0.1 --persist-to .wrangler/e2e-state`,
        url: `http://127.0.0.1:${PORT}/api/health`,
        reuseExistingServer: false,
        timeout: 120_000,
        stdout: 'ignore',
        stderr: 'pipe',
      },
});
