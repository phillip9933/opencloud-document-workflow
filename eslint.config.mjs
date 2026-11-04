// SPDX-License-Identifier: AGPL-3.0-only
import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import vue from 'eslint-plugin-vue'

export default [
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'draft-dist/**',
      'artifacts/**',
      'outputs/**',
      'coverage/**',
      'public/**'
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...vue.configs['flat/essential'],
  { languageOptions: { globals: { ...globals.node, ...globals.browser } } },
  { files: ['**/*.vue'], languageOptions: { parserOptions: { parser: tseslint.parser } } },
  {
    files: ['**/*.{mjs,ts,vue}'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'none',
          ignoreRestSiblings: true
        }
      ],
      // Safety checks first; complexity reductions are separate from formatting.
      // These expressions intentionally reject control characters in untrusted input.
      'no-control-regex': 'off',
      '@typescript-eslint/no-unused-expressions': ['error', { allowTernary: true }],
      'no-constant-binary-expression': 'error',
      'no-unreachable': 'error',
      'no-dupe-else-if': 'error'
    }
  },
  // Existing dynamic Vue/API test fixtures are typed incrementally; domain TS
  // retains the no-explicit-any rule. This is not a claim of backend type safety.
  { files: ['**/*.vue', 'tests/**/*.ts'], rules: { '@typescript-eslint/no-explicit-any': 'off' } },
  {
    files: ['companion/**/*.mjs', 'src/**/*.{ts,vue}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Error']",
          message: 'Use WorkflowError with an explicit code; unknown failures are internal errors.'
        },
        {
          selector: "ThrowStatement > CallExpression[callee.name='Error']",
          message: 'Use WorkflowError with an explicit code.'
        }
      ]
    }
  },
  // Bound orchestration growth while allowing explicit boundary validation branches.
  {
    files: ['companion/**/*.mjs', 'src/state/**/*.ts', 'src/views/**/*.vue'],
    rules: { complexity: ['error', 25] }
  },
  // Keep the newly separated recovery and operation paths small as they evolve.
  {
    files: [
      'companion/backup-storage.mjs',
      'companion/automatic-fields.mjs',
      'companion/operations.mjs'
    ],
    rules: { complexity: ['error', 15] }
  },
  {
    files: ['companion/automation.mjs', 'companion/conversions.mjs', 'companion/duplicates.mjs'],
    rules: { complexity: ['error', 20] }
  },
  {
    files: ['companion/*-routes.mjs', 'companion/draft-api.mjs'],
    rules: { complexity: ['error', 25] }
  },
  { files: ['src/views/*.vue'], rules: { 'vue/multi-word-component-names': 'off' } }
]
