import { defineConfig } from "oxlint";
import { selectJsPlugins } from "ultracite/oxlint/js-plugins";
import react from "ultracite/oxlint/react";
import shadcn from "ultracite/oxlint/shadcn";
import tanstack from "ultracite/oxlint/tanstack";
import tanstackJsPlugins from "ultracite/oxlint/tanstack/js-plugins";

import baseConfig, { baseJsPlugins } from "../../oxlint.config.ts";

const reactDoctor = selectJsPlugins(["react-doctor"]);

export default defineConfig({
  extends: [
    baseConfig,
    react,
    tanstack,
    shadcn,
    tanstackJsPlugins,
    reactDoctor,
  ],
  jsPlugins: [
    ...baseJsPlugins.jsPlugins,
    ...reactDoctor.jsPlugins,
    ...shadcn.jsPlugins,
  ],
  overrides: [
    {
      files: ["src/routes/**/*.tsx"],
      rules: {
        "react-doctor/only-export-components": "off",
      },
    },
    {
      files: ["worker-configuration.d.ts"],
      rules: {
        "unicorn/no-abusive-eslint-disable": "off",
      },
    },
  ],
});
