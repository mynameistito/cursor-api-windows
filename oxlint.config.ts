import { defineConfig } from "oxlint";
import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";
import { jsPluginSettings, selectJsPlugins } from "ultracite/oxlint/js-plugins";
import vitest from "ultracite/oxlint/vitest";

export const baseJsPlugins = selectJsPlugins([
  "github",
  "jsdoc-js",
  "sonarjs",
  "tsdoc",
]);

export default defineConfig({
  extends: [core, vitest, antiSlop, baseJsPlugins],
  ignorePatterns: core.ignorePatterns,
  jsPlugins: baseJsPlugins.jsPlugins,
  overrides: [
    {
      files: ["apps/**"],
      rules: {
        "no-restricted-imports": [
          "error",
          {
            patterns: [
              {
                message: "Use the @/* alias for imports between apps modules.",
                regex: "^\\.\\./",
              },
            ],
          },
        ],
      },
    },
  ],
  settings: jsPluginSettings,
});
