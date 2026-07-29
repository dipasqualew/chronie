/**
 * The static checks that read TypeScript as TypeScript rather than as text.
 *
 * `tsc` already says whether the annotations agree with each other; nothing it does says
 * whether an effect lists what it reads. That gap is what this file is for, and it is why the
 * rule that matters most here is `react-hooks/exhaustive-deps` — the tree carried eight
 * suppressions for it while no pass enforced it anywhere, which is a comment claiming a check
 * that was not running.
 *
 * One config for the whole repository. The three TypeScript trees — the app, the browser suite
 * and this repository's own scripts — differ only in which globals they may reach for, so they
 * are `languageOptions` blocks under one set of rules rather than three configurations that
 * would drift apart.
 *
 *     bun run lint          # what `scripts/check-frontend.sh` runs
 *     bun run lint --fix
 */

import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // Nothing generated, nothing built, and nothing anybody here wrote. `bindings.ts` is
  // tauri-specta's output and `scripts/check-rust.sh` is what holds it to its source.
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/target/**",
      "**/test-results/**",
      "**/playwright-report/**",
      "apps/desktop/src/bindings.ts",
    ],
  },

  js.configs.recommended,
  tseslint.configs.recommended,

  {
    // A `// eslint-disable` for a rule that reports nothing is the thing this issue was
    // opened about, so the tool is asked to fail on one rather than to mention it. It is the
    // only check that can tell a suppression that is load-bearing from one that is a fossil.
    linterOptions: { reportUnusedDisableDirectives: "error" },

    // `_` in front of an argument or a caught error is this tree's existing way of saying the
    // binding is there for its position rather than its value, and the rule should read it the
    // same way rather than asking for the position to be spelled some other way.
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },

  {
    // The React rules only make sense over the app: the browser suite drives a page from
    // outside it and the scripts have no components at all.
    //
    // The two classic rules, named rather than taken from the plugin's `recommended`. That
    // preset is the React Compiler's whole ruleset now — `refs`, `purity`, `immutability`,
    // `set-state-in-effect` and the rest — and turning it on here reports 38 places, nearly
    // all of them deliberate: the grids keep their pictures outside React on purpose, and
    // `characterFigure` holds a WebGL context across renders because that is what a context
    // is for. Every one of those is a real design question and none of them is this issue,
    // which asked for effect-dependency checking. Adopting the preset means answering all 38,
    // and an allow list carrying 38 findings is how a new one goes unnoticed.
    files: ["apps/desktop/src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      // Ships as a warning, and a warning is what let eight suppressions accumulate.
      "react-hooks/exhaustive-deps": "error",
    },
  },

  {
    files: ["apps/desktop/e2e/**/*.ts", "scripts/**/*.ts", "**/*.config.ts"],
    languageOptions: { globals: { ...globals.node } },
  },
);
