import js from '@eslint/js';
import svelte from 'eslint-plugin-svelte';
import globals from 'globals';
import ts from 'typescript-eslint';

export default ts.config(
  js.configs.recommended,
  ...ts.configs.recommended,
  ...svelte.configs['flat/recommended'],
  {
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node
      }
    }
  },
  {
    files: ['**/*.svelte'],
    languageOptions: {
      parserOptions: {
        parser: ts.parser
      }
    }
  },
  {
    rules: {
      // keyboard is the backbone — outline:none alone is banned (UI-SPEC §9).
      // Enforced via CSS review; lint keeps a11y rules from svelte recommended.
    }
  },
  {
    ignores: [
      'build/',
      '.svelte-kit/',
      'dist/',
      'node_modules/',
      'spikes/',
      'bin/',
      'docs/',
      'static/',
      'src/lib/styles/tokens/'
    ]
  }
);
