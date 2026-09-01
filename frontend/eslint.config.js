// Flat config (ESLint 9). Type-aware rules via typescript-eslint so `npm run
// lint` actually enforces the strictness the tsconfig already asks for.
import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // Playwright and the Vitest config live outside tsconfig.app.json; the e2e
  // suite is linted by Playwright's own tooling.
  { ignores: ['dist', 'node_modules', 'coverage', 'e2e/**', 'playwright.config.ts', 'vitest.config.ts', 'vite.config.ts', 'eslint.config.js'] },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      // Strict-TS seams we care about most.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-unnecessary-type-assertion': 'error',
      // Promise handling in event handlers is pervasive in React; keep these as
      // warnings so they guide rather than block.
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-misused-promises': ['warn', { checksVoidReturn: { attributes: false } }],
    },
  },
  {
    // Tests are excluded from tsconfig.app.json, so lint them without
    // type-aware rules rather than failing to resolve a project for them.
    files: ['**/*.test.{ts,tsx}', 'src/test/**'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { parserOptions: { projectService: false, project: null } },
    rules: { '@typescript-eslint/no-floating-promises': 'off' },
  },
);
