export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/out/**",
      "**/build/**",
      "**/coverage/**",
      "artifacts/**"
    ]
  },
  {
    files: ["**/*.{js,mjs,ts,tsx}"],
    rules: {
      eqeqeq: ["error", "always"],
      "no-eval": "error",
      "no-implied-eval": "error"
    }
  }
];
