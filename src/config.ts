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
  qdrantRetryMax: number;
  qdrantRetryDelayMs: number;
  qdrantRetryMaxDelayMs: number;

  // Optional: LanceDB storage path (defaults to ./data/lancedb)
  lancedbPath: string;

  // Embedding provider: "openai" (default) or "ollama"
  embeddingProvider: "openai" | "ollama";

  // OpenAI: required when embeddingProvider is "openai"
  openaiApiKey: string | undefined;
  openaiApiUrl: string | undefined;
  openaiModel: string;

  // Ollama: used when embeddingProvider is "ollama"
  ollamaUrl: string;
  ollamaEmbedModel: string;
  ollamaMaxChars: number;
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
  const paperlessToken = process.env.PAPERLESS_TOKEN;
  const qdrantUrl = process.env.QDRANT_URL;
  const qdrantCollection = process.env.QDRANT_COLLECTION || "paperless_documents";
  const qdrantRetryMax = parseInt(process.env.QDRANT_RETRY_MAX || "15", 10);
  const qdrantRetryDelayMs = parseInt(process.env.QDRANT_RETRY_DELAY_MS || "2000", 10);
  const qdrantRetryMaxDelayMs = parseInt(process.env.QDRANT_RETRY_MAX_DELAY_MS || "60000", 10);
  const lancedbPath = process.env.LANCEDB_PATH || "./data/lancedb";
  const embeddingProvider = (process.env.EMBEDDING_PROVIDER || "openai") as "openai" | "ollama";
  const openaiApiKey = process.env.OPENAI_API_KEY;
  const openaiApiUrl = process.env.OPENAI_API_URL;
  const ollamaUrl = process.env.OLLAMA_URL || "http://localhost:11434";
  const ollamaEmbedModel = process.env.OLLAMA_EMBED_MODEL || "nomic-embed-text";
  const ollamaMaxChars = parseInt(process.env.OLLAMA_MAX_CHARS || "1000", 10);
  const openaiModel = process.env.OPENAI_MODEL || "gpt-4o-mini";

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

  if (embeddingProvider === "openai" && !openaiApiKey && !openaiApiUrl) {
    errors.push({
      variable: "OPENAI_API_KEY",
      feature: "OpenAI embeddings",
      hint: "Set your OpenAI API key, or use EMBEDDING_PROVIDER=ollama, or set OPENAI_API_URL for a proxy",
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
    qdrantRetryMax,
    qdrantRetryDelayMs,
    qdrantRetryMaxDelayMs,
    lancedbPath,
    embeddingProvider,
    openaiApiKey,
    openaiApiUrl,
    openaiModel,
    ollamaUrl,
    ollamaEmbedModel,
    ollamaMaxChars,
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
