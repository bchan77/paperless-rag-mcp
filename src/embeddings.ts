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
  const response = await fetch(`${config.ollamaUrl}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: config.ollamaEmbedModel, input: texts }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Ollama embed failed (${response.status}): ${body}`);
  }

  const data = await response.json() as { embeddings: number[][] };
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
    // Ollama handles batches natively; process in chunks to avoid overloading
    const BATCH_SIZE = 50;
    const embeddings: number[][] = [];

    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE);
      const batchEmbeddings = await embedWithOllama(batch);
      embeddings.push(...batchEmbeddings);

      if (onProgress) {
        onProgress(Math.min(i + BATCH_SIZE, texts.length), texts.length);
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
