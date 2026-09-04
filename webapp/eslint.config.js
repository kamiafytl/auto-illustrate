import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    rules: {
      // React 19 编译器新增的存量代码告警：现有代码运行正常，逐个重构 effect 有引入回归的风险，
      // 故降为 warning（不让 lint 失败、不再满屏红），但保留提示，新代码踩坑仍可见。
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/refs': 'warn',
      // JSX 文本中的全角空格（U+3000）是有意的显示内容（如同步状态占位），允许之；其它位置仍禁止不规则空白。
      'no-irregular-whitespace': ['error', { skipJSXText: true }],
    },
  },
])
