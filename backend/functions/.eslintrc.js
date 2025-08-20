module.exports = {
  root: true,
  env: {
    node: true,
    es2021: true,
  },
  parserOptions: {
    ecmaVersion: "latest", // allow optional chaining, numeric separators, etc.
    sourceType: "script",
  },
  extends: [
    "eslint:recommended",
  ],
  rules: {
    // Do not block deploys for style-only issues during migration
    "no-unused-vars": ["warn", { "argsIgnorePattern": "^_", "varsIgnorePattern": "^_" }],
    "quotes": "off",
  },
  overrides: [
    {
      files: ["**/*.spec.*"],
      env: { mocha: true },
      rules: {},
    },
  ],
};
