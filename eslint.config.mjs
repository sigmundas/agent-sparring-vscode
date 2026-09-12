import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "out/**", "node_modules/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "no-restricted-imports": [
        "error",
        {
          paths: [{ name: "child_process", importNames: ["exec", "execSync"], message: "Spawn with argument arrays and shell:false." }],
        },
      ],
    },
  },
  {
    // The core is deliberately free of the vscode API so it can be unit-tested under plain Node.
    files: ["src/core/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { paths: [{ name: "vscode", message: "core must not depend on vscode" }] }],
    },
  },
);
