import { createAccountsFromConfig } from "./accounts/createAccounts.js";
import { buildApp } from "./app.js";
import { AppKeyVerifier, type ClientVerifier } from "./auth/clientVerifier.js";
import { JwtVerifier } from "./auth/jwtVerifier.js";
import { loadConfig } from "./config.js";
import { createGenerator } from "./llm/createGenerator.js";
import { createExtractor } from "./extract/createExtractor.js";
import { createScanner } from "./scan/createScanner.js";
import { createSuggester } from "./suggest/createSuggester.js";

async function main(): Promise<void> {
  const config = loadConfig();

  // Accounts need the database before the app can serve; without them the shared key is all there is.
  const accounts = await createAccountsFromConfig(config, {
    info: (fields, message) => console.log(message, JSON.stringify(fields)),
    warn: (message) => console.warn(message),
  });
  const verifier: ClientVerifier = accounts ? new JwtVerifier(accounts.runtime.tokens) : new AppKeyVerifier(config.CHEF_APP_KEY);

  const app = await buildApp({
    config,
    verifier,
    accounts: accounts?.runtime,
    generator: (log) => createGenerator(config, log),
    scanner: (log) => createScanner(config, log),
    suggester: (log) => createSuggester(config, log),
    extractor: (log) => createExtractor(config, log),
  });

  // Finish in-flight requests before the process stops (platforms send SIGTERM on restart/scale-in).
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      app.log.info({ signal }, "shutting down");
      app
        .close()
        .then(() => accounts?.close())
        .then(
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
