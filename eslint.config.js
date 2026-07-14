const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  js.configs.recommended,
  {
    files: ['**/*.js'],
    ignores: ['zoom-extension/**'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        // Node globals buat top-level script, plus browser globals karena
        // banyak callback page.evaluate() di sini jalan di context browser
        // (referensi document/Node/dsb di dalam callback itu valid).
        ...globals.node,
        ...globals.browser,
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['zoom-extension/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: {
        ...globals.browser,
        ...globals.webextensions,
      },
    },
  },
];
