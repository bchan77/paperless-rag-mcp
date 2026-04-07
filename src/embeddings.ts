/**
 * Embeddings module
 * 
 * Handles text embedding generation using OpenAI or local models.
 */

import { getConfig } from "./config.js";
import OpenAI from "openai";

let openaiClient: OpenAI | null = null;

function getOpenAIClient(): OpenAI {
  if (!openaiClient) {
    const config = getConfig();
    if (!config.openaiApiKey) {
      throw new Error("OPENAI_API_KEY is required for embeddings");
    }
    openaiClient = new OpenAI({ apiKey: config.openaiApiKey });
  }
  return openaiClient;
}

/**
 * Generate an embedding for a single text using OpenAI
 */
export async function embedText(text: string): Promise<number[]> {
  const client = getOpenAIClient();
  
  const response = await client.embeddings.create({
    model: "text-embedding-3-small",
    input: text,
  });
  
  return response.data[0].embedding;
}

/**
 * Generate embeddings for multiple texts (batch processing)
 * Uses OpenAI's batch API to process multiple texts in a single request
 */
export async function embedTexts(texts: string[], onProgress?: (current: number, total: number) => void): Promise<number[][]> {
  const client = getOpenAIClient();
  const embeddings: number[][] = [];

  // OpenAI supports up to 2048 inputs per request, but we use smaller batches
  // to avoid timeouts and memory issues
  const BATCH_SIZE = 100;

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const batchEnd = Math.min(i + BATCH_SIZE, texts.length);

    if (onProgress) {
      onProgress(batchEnd, texts.length);
    }

    const response = await client.embeddings.create({
      model: "text-embedding-3-small",
      input: batch,
    });

    // OpenAI returns embeddings in the same order as inputs
    for (const item of response.data) {
      embeddings.push(item.embedding);
    }
  }

  return embeddings;
}

/**
 * Split a long document into chunks
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
      // Push current chunk
      chunks.push(currentChunk.join(" "));
      
      // Start new chunk with overlap
      const overlapWords = currentChunk.slice(-Math.floor(overlap / 5)).join(" ");
      currentChunk = overlapWords ? [overlapWords, word] : [word];
      currentLength = overlapWords.length + word.length + 1;
    } else {
      currentChunk.push(word);
    }
  }
  
  // Push final chunk
  if (currentChunk.length > 0) {
    chunks.push(currentChunk.join(" "));
  }
  
  return chunks;
}
