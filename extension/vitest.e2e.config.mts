import { defineConfig } from 'vitest/config';

// End-to-end check of the orchestration core against a temporary git copy of samples/ImpactSample.
// Needs the .NET SDK, git, NuGet access (first restore) and a built analyzer.
export default defineConfig({
  test: {
    include: ['test/e2e/**/*.test.ts'],
    environment: 'node',
    testTimeout: 600000,
    hookTimeout: 600000,
    fileParallelism: false,
  },
});
