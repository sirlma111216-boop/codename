import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'node_modules', '.wrangler', 'test-results', 'playwright-report', 'src/server/worker-configuration.d.ts'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx,js,mjs}'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    files: ['src/client/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // 원본 키 카드·콘텐츠 원본·서버 코드는 클라이언트 번들로 들어가면 안 된다.
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['**/content/**', '**/content/registry*'], message: '콘텐츠 원본(키 카드 포함)은 서버 전용입니다.' },
            { group: ['**/server/**'], message: '서버 코드는 클라이언트에서 import 하지 않습니다.' },
            { group: ['**/game/setup*', '**/game/content*', '**/game/engine*', '**/game/projection*'], message: '판정·준비 로직은 서버에서만 실행합니다.' },
          ],
        },
      ],
    },
  },
);
