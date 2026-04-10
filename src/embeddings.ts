/**
 * Embeddings module
 *
 * Handles text embedding generation using OpenAI or a local Ollama model.
 * Set EMBEDDING_PROVIDER=ollama in .env to use local embeddings.
 */

import { getConfig } from "./config.js";
import OpenAI from "openai";

let openaiClient: OpenAI | null = null;

function getOpenAIClient(): OpenAI {
  if (!openaiClient) {
    const config = getConfig();
    if (!config.openaiApiKey) {
      throw new Error("OPENAI_API_KEY is required when EMBEDDING_PROVIDER=openai");
    }
    openaiClient = new OpenAI({ apiKey: config.openaiApiKey });
  }
  return openaiClient;
}

async function embedWithOpenAI(texts: string[]): Promise<number[][]> {
  const client = getOpenAIClient();
  const embeddings: number[][] = [];
  const BATCH_SIZE = 100;

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const response = await client.embeddings.create({
      model: "text-embedding-3-small",
      input: batch,
    });
    for (const item of response.data) {
      embeddings.push(item.embedding);
    }
  }

  return embeddings;
}

async function embedWithOllama(texts: string[]): Promise<number[][]> {
  const config = getConfig();
  const url = `${config.ollamaUrl}/api/embed`;

  // Truncate texts exceeding the configured context limit.
  // Set OLLAMA_MAX_CHARS in .env to tune this (default: 1000).
  const truncated = texts.map(t =>
    t.length > config.ollamaMaxChars ? t.slice(0, config.ollamaMaxChars) : t
  );

  const maxLen = Math.max(...truncated.map(t => t.length));
  const totalLen = truncated.reduce((sum, t) => sum + t.length, 0);
  console.error(`[embedWithOllama] texts=${texts.length} maxLen=${maxLen} totalLen=${totalLen} ollamaMaxChars=${config.ollamaMaxChars}`);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: config.ollamaEmbedModel, input: truncated }),
    });
  } catch (err: any) {
    const reason = err?.cause?.code === "ECONNREFUSED"
      ? "connection refused — is Ollama running?"
      : err?.cause?.message ?? err?.message ?? String(err);
    throw new Error(`Ollama unreachable at ${url}: ${reason}`);
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Ollama embed failed (HTTP ${response.status}) for model "${config.ollamaEmbedModel}": ${body}`);
  }

  const data = await response.json() as { embeddings: number[][] };

  if (!data.embeddings || data.embeddings.length === 0) {
    throw new Error(`Ollama returned no embeddings for model "${config.ollamaEmbedModel}" — is the model pulled? Run: ollama pull ${config.ollamaEmbedModel}`);
  }

  return data.embeddings;
}

/**
 * Generate an embedding for a single text.
 */
export async function embedText(text: string): Promise<number[]> {
  const [embedding] = await embedTexts([text]);
  return embedding;
}

/**
 * Generate embeddings for multiple texts (batch processing).
 */
export async function embedTexts(texts: string[], onProgress?: (current: number, total: number) => void): Promise<number[][]> {
  const config = getConfig();

  if (config.embeddingProvider === "ollama") {
    // Send one text at a time — some Ollama models reject batches that together
    // exceed the context window, even though each text individually fits.
    const embeddings: number[][] = [];

    for (let i = 0; i < texts.length; i++) {
      const [embedding] = await embedWithOllama([texts[i]]);
      embeddings.push(embedding);

      if (onProgress) {
        onProgress(i + 1, texts.length);
      }
    }

    return embeddings;
  }

  // Default: OpenAI
  const embeddings = await embedWithOpenAI(texts);
  if (onProgress) onProgress(texts.length, texts.length);
  return embeddings;
}

/**
 * Split a long document into chunks.
 */
export function chunkText(text: string, chunkSize: number = 500, overlap: number = 50): string[] {
  if (!text || text.trim().length === 0) {
    return [];
  }

  const chunks: string[] = [];
  const words = text.split(/\s+/);
  let currentChunk: string[] = [];
  let currentLength = 0;

  for (const word of words) {
    currentLength += word.length + 1;

    if (currentLength > chunkSize && currentChunk.length > 0) {
      chunks.push(currentChunk.join(" "));

      const overlapWords = currentChunk.slice(-Math.floor(overlap / 5)).join(" ");
      currentChunk = overlapWords ? [overlapWords, word] : [word];
      currentLength = overlapWords.length + word.length + 1;
    } else {
      currentChunk.push(word);
    }
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk.join(" "));
  }

  return chunks;
}
