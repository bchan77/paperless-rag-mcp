/**
 * Centralized configuration module
 *
 * Reads environment variables once at startup and exports
 * validated config for the rest of the application.
 */

export interface Config {
  // Required for Paperless integration
  paperlessUrl: string;
  paperlessToken: string;

  // Optional: Qdrant vector database (defaults to LanceDB if not set)
  qdrantUrl: string | undefined;
  qdrantCollection: string;

  // Optional: LanceDB storage path (defaults to ./data/lancedb)
  lancedbPath: string;

  // Optional: OpenAI API key (required when RAG features are used)
  openaiApiKey: string | undefined;
}

interface ConfigError {
  variable: string;
  feature: string;
  hint: string;
}

/**
 * Validates required environment variables and returns a config object.
 * Throws a descriptive error if required variables are missing.
 */
export function loadConfig(): Config {
  const errors: ConfigError[] = [];

  const paperlessUrl = process.env.PAPERLESS_URL;
  const paperlessToken = process.env.PAPERLESS_API_KEY;
  const qdrantUrl = process.env.QDRANT_URL;
  const qdrantCollection = process.env.QDRANT_COLLECTION || "paperless_documents";
  const lancedbPath = process.env.LANCEDB_PATH || "./data/lancedb";
  const openaiApiKey = process.env.OPENAI_API_KEY;

  // Validate required variables
  if (!paperlessUrl) {
    errors.push({
      variable: "PAPERLESS_URL",
      feature: "Paperless-ngx integration",
      hint: "Set to your Paperless-ngx instance URL (e.g., http://paperless.local:8000)",
    });
  }

  if (!paperlessToken) {
    errors.push({
      variable: "PAPERLESS_TOKEN",
      feature: "Paperless-ngx integration",
      hint: "Generate an API token in Paperless-ngx under Settings > API Tokens",
    });
  }

  if (errors.length > 0) {
    const errorMessages = errors
      .map(
        (e) =>
          `  - ${e.variable}: required for ${e.feature}\n    Hint: ${e.hint}`
      )
      .join("\n\n");

    throw new Error(
      `Missing required environment variables:\n\n${errorMessages}\n\n` +
        `To fix: Copy .env.example to .env and fill in the values.`
    );
  }

  return {
    paperlessUrl: paperlessUrl!,
    paperlessToken: paperlessToken!,
    qdrantUrl,
    qdrantCollection,
    lancedbPath,
    openaiApiKey,
  };
}

/**
 * Returns the storage mode based on config.
 * - "qdrant" if QDRANT_URL is set
 * - "lancedb" otherwise (default)
 */
export function getStorageMode(config: Config): "qdrant" | "lancedb" {
  return config.qdrantUrl ? "qdrant" : "lancedb";
}

// Singleton config instance, initialized at startup
let _config: Config | null = null;

/**
 * Gets the validated config. Must call loadConfig() first during startup.
 * Throws if config hasn't been initialized.
 */
export function getConfig(): Config {
  if (!_config) {
    throw new Error(
      "Config not initialized. Call loadConfig() during startup."
    );
  }
  return _config;
}

/**
 * Initializes the config singleton. Call this once at application startup.
 * Returns the config for immediate use.
 */
export function initConfig(): Config {
  _config = loadConfig();
  return _config;
}
