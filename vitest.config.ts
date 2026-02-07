import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    mockReset: true,
    restoreMocks: true,
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      exclude: [
        "node_modules/",
        "src/main.ts",
        "src/scripts/",
        "**/*.test.ts",
      ],
    },
  },
});
