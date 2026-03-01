import { startBackendForTests } from "./lib/harness.mjs";
import { readdir } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function loadTests() {
  const casesDir = path.resolve(__dirname, "cases");
  const entries = await readdir(casesDir, { withFileTypes: true });

  const fileNames = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.mjs"))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  const modules = await Promise.all(
    fileNames.map(async (fileName) => {
      const modulePath = path.resolve(casesDir, fileName);
      const testModule = await import(pathToFileURL(modulePath).href);

      if (
        typeof testModule?.name !== "string" ||
        typeof testModule?.run !== "function"
      ) {
        throw new Error(
          `Invalid test module ${fileName}. Expected exports: name (string), run (function)`,
        );
      }

      return testModule;
    }),
  );

  return modules;
}

async function main() {
  const tests = await loadTests();
  const backend = await startBackendForTests();
  let failed = 0;

  try {
    // eslint-disable-next-line no-console
    console.log(
      `Running ${tests.length} backend regression test(s) on ${backend.baseUrl}`,
    );

    for (const testCase of tests) {
      const startedAt = Date.now();

      try {
        await testCase.run({ baseUrl: backend.baseUrl });
        const elapsedMs = Date.now() - startedAt;
        // eslint-disable-next-line no-console
        console.log(`✓ ${testCase.name} (${elapsedMs}ms)`);
      } catch (error) {
        failed += 1;
        // eslint-disable-next-line no-console
        console.error(`✗ ${testCase.name}`);
        // eslint-disable-next-line no-console
        console.error(error?.stack || error?.message || String(error));
      }
    }
  } finally {
    await backend.stop();
  }

  if (failed > 0) {
    process.exitCode = 1;
    // eslint-disable-next-line no-console
    console.error(`\n${failed} test(s) failed`);
    return;
  }

  // eslint-disable-next-line no-console
  console.log("\nAll backend regression tests passed");
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
