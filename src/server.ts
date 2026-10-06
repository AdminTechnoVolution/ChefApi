import { buildApp } from "./app.js";
import { AppKeyVerifier } from "./auth/clientVerifier.js";
import { loadConfig } from "./config.js";
import { createGenerator } from "./llm/createGenerator.js";
import { createExtractor } from "./extract/createExtractor.js";
import { createScanner } from "./scan/createScanner.js";
import { createSuggester } from "./suggest/createSuggester.js";

async function main(): Promise<void> {
  const config = loadConfig();

  const app = await buildApp({
    config,
    verifier: new AppKeyVerifier(config.CHEF_APP_KEY),
    generator: (log) => createGenerator(config, log),
    scanner: (log) => createScanner(config, log),
    suggester: (log) => createSuggester(config, log),
    extractor: (log) => createExtractor(config, log),
  });

  // Finish in-flight requests before the process stops (platforms send SIGTERM on restart/scale-in).
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      app.log.info({ signal }, "shutting down");
      app.close().then(
        () => process.exit(0),
        (error: unknown) => {
          app.log.error({ err: error }, "error during shutdown");
          process.exit(1);
        },
      );
    });
  }

  await app.listen({ port: config.PORT, host: config.HOST });
}

main().catch((error: unknown) => {
  console.error(`Chef proxy failed to start: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
