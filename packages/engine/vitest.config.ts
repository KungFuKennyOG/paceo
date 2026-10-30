import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    reporters: ["default", "./test/ci-annotations-reporter.ts"],
  },
});
