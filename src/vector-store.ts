/**
 * Vector Store Module
 * 
 * Provides a unified interface for vector storage.
 * Uses LanceDB by default (local file-based), or Qdrant if QDRANT_URL is configured.
 * 
 * Features:
 * - Stores document chunks with embeddings
 * - Tracks indexed documents for delta sync
 * - Supports LanceDB (default) and Qdrant
 */

import { createHash } from "crypto";
import { getConfig, getStorageMode } from "./config.js";
import { getEmbeddingDimension } from "./embeddings.js";

/**
 * Convert a string ID to a valid UUID format for Qdrant.
 * Uses SHA-256 hash to generate a deterministic UUID from the chunk ID.
 */
function toQdrantUUID(id: string): string {
  const hash = createHash("sha256").update(id).digest("hex");
  // Format as UUID: 8-4-4-4-12
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

/**
 * Logger function for retry operations.
 * Can be overridden via setRetryLogger for custom logging (e.g., sync-worker).
 */
let retryLogger: (message: string) => void = (msg) => console.error(msg);

export function setRetryLogger(logger: (message: string) => void): void {
  retryLogger = logger;
}

/**
 * Retry helper for Qdrant operations.
 * Retries on connection errors with exponential backoff.
 */
async function withRetry<T>(
  operation: () => Promise<T>,
  options: { maxRetries?: number; baseDelayMs?: number; maxDelayMs?: number; operationName?: string } = {}
): Promise<T> {
  const config = getConfig();
  const {
    maxRetries = config.qdrantRetryMax,
    baseDelayMs = config.qdrantRetryDelayMs,
    maxDelayMs = config.qdrantRetryMaxDelayMs,
    operationName = "operation"
  } = options;
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error: any) {
      lastError = error;
      const errorMsg = (error.message || "").toLowerCase();
      const errorStr = String(error).toLowerCase();
      const causeMsg = (error.cause?.message || "").toLowerCase();

      const isRetryable =
        // Connection errors
        errorMsg.includes("fetch failed") ||
        errorMsg.includes("econnrefused") ||
        errorMsg.includes("econnreset") ||
        errorMsg.includes("enetunreach") ||
        errorMsg.includes("etimedout") ||
        errorMsg.includes("socket hang up") ||
        errorMsg.includes("network") ||
        causeMsg.includes("econnrefused") ||
        causeMsg.includes("econnreset") ||
        error.code === "ECONNREFUSED" ||
        error.code === "ECONNRESET" ||
        error.code === "ENETUNREACH" ||
        error.code === "ETIMEDOUT" ||
        // HTTP errors that indicate temporary unavailability
        errorMsg.includes("service unavailable") ||
        errorMsg.includes("bad gateway") ||
        errorMsg.includes("gateway timeout") ||
        errorMsg.includes("unavailable") ||
        errorStr.includes("503") ||
        errorStr.includes("502") ||
        errorStr.includes("504") ||
        error.status === 502 ||
        error.status === 503 ||
        error.status === 504 ||
        error.statusCode === 502 ||
        error.statusCode === 503 ||
        error.statusCode === 504;

      if (!isRetryable || attempt === maxRetries) {
        throw error;
      }

      const delayMs = Math.min(baseDelayMs * Math.pow(2, attempt - 1), maxDelayMs);
      retryLogger(`[Qdrant] ${operationName} failed (attempt ${attempt}/${maxRetries}): ${error.message}. Retrying in ${delayMs}ms...`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  throw lastError;
}

export interface DocumentChunk {
  id: string;
  documentId: number;
  content: string;
  metadata: {
    title: string;
    source: string;
    page?: number;
    created?: string;
    modified?: string;  // Paperless document modification time
    [key: string]: unknown;
  };
  embedding?: number[];
}

export interface SearchResult {
  id: string;
  documentId: number;
  content: string;
  metadata: Record<string, unknown>;
  score: number;        // 0-1 similarity (1 = identical)
  match_percent: number; // 0-100 rounded percentage
}

export interface ChunkInfo {
  chunk_id: string;
  document_id: number;
  title: string;
  content_preview: string;
  source: string;
  page: number | null;
  created: string | null;
}

// Indexed document tracking
export interface IndexedDocument {
  document_id: number;
  last_modified: string;
  indexed_at: string;
  chunk_count: number;
}

export interface SyncStatus {
  total_indexed: number;
  documents: IndexedDocument[];
  last_sync: string | null;
}

export interface VectorStore {
  /**
   * Initialize the vector store (create tables/collections if needed)
   */
  initialize(): Promise<void>;
  
  /**
   * Add document chunks to the vector store
   */
  addDocuments(chunks: DocumentChunk[]): Promise<void>;
  
  /**
   * Search for similar documents
   */
  search(queryEmbedding: number[], limit?: number): Promise<SearchResult[]>;
  
  /**
   * Delete all chunks for a document
   */
  deleteDocument(documentId: number): Promise<void>;
  
  /**
   * Get stats about the vector store
   */
  stats(): Promise<{ count: number; storageMode: "qdrant" | "lancedb" }>;
  
  /**
   * Inspect chunks (for debugging)
   */
  inspect(limit?: number, documentId?: number): Promise<ChunkInfo[]>;
  
  /**
   * Get sync status - list of indexed documents with timestamps
   */
  getSyncStatus(): Promise<SyncStatus>;
  
  /**
   * Check if documents need syncing (new or modified since last index)
   * Returns list of document IDs that need to be re-indexed
   */
  getDocumentsNeedingSync(documents: Array<{ id: number; modified: string }>): Promise<number[]>;
  
  /**
   * Mark documents as indexed (update tracking info)
   */
  markDocumentsIndexed(documentId: number, lastModified: string, chunkCount: number): Promise<void>;
}

// LanceDB implementation
import { connect, Table } from "@lancedb/lancedb";

class LanceDBVectorStore implements VectorStore {
  private db: Awaited<ReturnType<typeof connect>> | null = null;
  private table: Table | null = null;
  private indexedTable: Table | null = null;
  private readonly dbPath: string;
  
  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }
  
  async initialize(): Promise<void> {
    this.db = await connect(this.dbPath);

    const tableNames = await this.db.tableNames();
    
    // Open or create documents table
    if (tableNames.includes("documents")) {
      try {
        this.table = await this.db.openTable("documents");
      } catch {
        // Table metadata exists but files are missing/corrupt — treat as empty
        this.table = null;
      }
    }

    // Open indexed_documents tracking table if it exists
    // Table will be created on first markDocumentsIndexed call with actual data
    if (tableNames.includes("indexed_documents")) {
      try {
        this.indexedTable = await this.db.openTable("indexed_documents");
      } catch {
        this.indexedTable = null;
      }
    }
  }
  
  async addDocuments(chunks: DocumentChunk[]): Promise<void> {
    if (!this.db) {
      throw new Error("Vector store not initialized. Call initialize() first.");
    }

    const rows = chunks.map((chunk) => ({
      vector: chunk.embedding || new Array(1536).fill(0),
      document_id: chunk.documentId,
      chunk_id: chunk.id,
      content: chunk.content,
      title: chunk.metadata.title,
      source: chunk.metadata.source,
      page: chunk.metadata.page || 0,
      created: chunk.metadata.created || "",
    }));

    if (!this.table) {
      this.table = await this.db.createTable("documents", rows);
    } else {
      await this.table.add(rows);
    }
  }
  
  async search(queryEmbedding: number[], limit: number = 5): Promise<SearchResult[]> {
    if (!this.table) {
      return [];
    }

    try {
      // Search using vector similarity
      // Pass the vector directly as the query
      const vectorArray = Float32Array.from(queryEmbedding);
      const results = await this.table.search(vectorArray).limit(limit).toArray();

      return results.map((row: any) => ({
        id: row.chunk_id || String(row.id),
        documentId: row.document_id,
        content: row.content,
        metadata: {
          title: row.title,
          source: row.source,
          page: row.page,
          created: row.created,
        },
        // _distance is L2 distance (0=identical, 2=opposite for normalized vectors).
        // Convert to 0-1 similarity: 1 - distance/2
        score: row._distance != null ? Math.max(0, 1 - row._distance / 2) : (row.score ?? 0),
        match_percent: row._distance != null ? Math.round(Math.max(0, 1 - row._distance / 2) * 100) : Math.round((row.score ?? 0) * 100),
      }));
    } catch (error) {
      console.error("LanceDB search error:", error);
      return [];
    }
  }
  
  async deleteDocument(documentId: number): Promise<void> {
    if (this.table) {
      await this.table.delete(`document_id = ${documentId}`);
    }
    if (this.indexedTable) {
      await this.indexedTable.delete(`document_id = ${documentId}`);
    }
  }
  
  async stats(): Promise<{ count: number; storageMode: "qdrant" | "lancedb" }> {
    if (!this.table) {
      return { count: 0, storageMode: "lancedb" };
    }
    
    const count = await this.table.countRows();
    return { count, storageMode: "lancedb" };
  }
  
  async inspect(limit: number = 10, documentId?: number): Promise<ChunkInfo[]> {
    if (!this.table) {
      return [];
    }
    
    let results: any[];
    if (documentId !== undefined) {
      results = await this.table.query().where(`document_id = ${documentId}`).limit(limit).toArray();
    } else {
      results = await this.table.query().limit(limit).toArray();
    }
    
    return results.map((row: any) => ({
      chunk_id: row.chunk_id,
      document_id: row.document_id,
      title: row.title || "",
      content_preview: (row.content || "").substring(0, 200) + ((row.content || "").length > 200 ? "..." : ""),
      source: row.source || "",
      page: row.page || null,
      created: row.created || null,
    }));
  }

  async getSyncStatus(): Promise<SyncStatus> {
    if (!this.indexedTable) {
      return { total_indexed: 0, documents: [], last_sync: null };
    }
    
    const results = await this.indexedTable.query().toArray();
    
    const documents: IndexedDocument[] = results.map((row: any) => ({
      document_id: row.document_id,
      last_modified: row.last_modified,
      indexed_at: row.indexed_at,
      chunk_count: row.chunk_count,
    }));
    
    const lastSync = documents.length > 0 
      ? documents.reduce((latest, doc) => doc.indexed_at > latest ? doc.indexed_at : latest, documents[0].indexed_at)
      : null;
    
    return {
      total_indexed: documents.length,
      documents,
      last_sync: lastSync,
    };
  }

  async getDocumentsNeedingSync(documents: Array<{ id: number; modified: string }>): Promise<number[]> {
    if (!this.indexedTable) {
      // No tracking, sync everything
      return documents.map(d => d.id);
    }
    
    const results = await this.indexedTable.query().toArray();
    const indexed = new Map<number, { last_modified: string }>();
    
    results.forEach((row: any) => {
      indexed.set(row.document_id, { last_modified: row.last_modified });
    });
    
    const needsSync: number[] = [];
    
    for (const doc of documents) {
      const existing = indexed.get(doc.id);
      if (!existing) {
        // New document
        needsSync.push(doc.id);
      } else if (doc.modified > existing.last_modified) {
        // Document was modified
        needsSync.push(doc.id);
      }
    }
    
    return needsSync;
  }

  async markDocumentsIndexed(documentId: number, lastModified: string, chunkCount: number): Promise<void> {
    if (!this.db) {
      throw new Error("Vector store not initialized. Call initialize() first.");
    }

    const indexedAt = new Date().toISOString();
    const row = {
      document_id: documentId,
      last_modified: lastModified,
      indexed_at: indexedAt,
      chunk_count: chunkCount,
    };

    if (!this.indexedTable) {
      // Create table with first entry - LanceDB infers schema from data
      this.indexedTable = await this.db.createTable("indexed_documents", [row]);
    } else {
      // Delete existing entry if any, then add new one
      await this.indexedTable.delete(`document_id = ${documentId}`);
      await this.indexedTable.add([row]);
    }
  }
}

// Qdrant implementation
import { QdrantClient } from "@qdrant/js-client-rest";

class QdrantVectorStore implements VectorStore {
  private client: QdrantClient | null = null;
  private readonly host: string;
  private readonly port: number;
  private readonly https: boolean;
  private readonly collection: string;
  private readonly indexedCollection: string;

  constructor(url: string, collection: string) {
    // Parse URL to extract host, port, and protocol
    // QdrantClient requires host and port separately - it ignores port in url parameter
    const parsed = new URL(url);
    this.host = parsed.hostname;
    this.https = parsed.protocol === 'https:';
    // URL.port returns empty string for default ports (80 for http, 443 for https)
    // Default to protocol's standard port, not Qdrant's 6333
    const defaultPort = this.https ? 443 : 80;
    this.port = parsed.port ? parseInt(parsed.port, 10) : defaultPort;
    this.collection = collection;
    this.indexedCollection = `${collection}_indexed`;
  }

  async initialize(): Promise<void> {
    this.client = new QdrantClient({
      host: this.host,
      port: this.port,
      https: this.https,
    });

    await withRetry(async () => {
      // Create main collection if not exists
      const collections = await this.client!.getCollections();
      const collectionNames = collections.collections.map(c => c.name);
      const vectorDimension = getEmbeddingDimension();

      if (!collectionNames.includes(this.collection)) {
        await this.client!.createCollection(this.collection, {
          vectors: { size: vectorDimension, distance: "Cosine" },
        });
      }

      // Create indexed tracking collection if not exists
      if (!collectionNames.includes(this.indexedCollection)) {
        await this.client!.createCollection(this.indexedCollection, {
          vectors: { size: 1, distance: "Dot" },  // Dummy vector for tracking
        });
      }
    }, { operationName: "initialize" });
  }
  
  async addDocuments(chunks: DocumentChunk[]): Promise<void> {
    if (!this.client) {
      throw new Error("Vector store not initialized. Call initialize() first.");
    }

    const vectorDimension = getEmbeddingDimension();
    const points = chunks.map((chunk) => ({
      id: toQdrantUUID(chunk.id),
      vector: chunk.embedding || new Array(vectorDimension).fill(0),
      payload: {
        document_id: chunk.documentId,
        chunk_id: chunk.id,
        content: chunk.content,
        title: chunk.metadata.title,
        source: chunk.metadata.source,
        page: chunk.metadata.page,
        created: chunk.metadata.created,
      },
    }));

    await withRetry(
      () => this.client!.upsert(this.collection, { points }),
      { operationName: "addDocuments" }
    );
  }
  
  async search(queryEmbedding: number[], limit: number = 5): Promise<SearchResult[]> {
    if (!this.client) {
      throw new Error("Vector store not initialized. Call initialize() first.");
    }

    const results = await withRetry(
      () => this.client!.search(this.collection, { vector: queryEmbedding, limit }),
      { operationName: "search" }
    );

    return results.map((result) => ({
      id: String(result.id),
      documentId: result.payload?.document_id as number,
      content: result.payload?.content as string,
      metadata: result.payload as Record<string, unknown>,
      score: result.score,
      match_percent: Math.round(result.score * 100),
    }));
  }
  
  async deleteDocument(documentId: number): Promise<void> {
    if (!this.client) {
      return;
    }

    await withRetry(async () => {
      await this.client!.delete(this.collection, {
        filter: {
          must: [{ key: "document_id", match: { value: documentId } }],
        },
      });

      await this.client!.delete(this.indexedCollection, {
        filter: {
          must: [{ key: "document_id", match: { value: documentId } }],
        },
      });
    }, { operationName: "deleteDocument" });
  }
  
  async stats(): Promise<{ count: number; storageMode: "qdrant" | "lancedb" }> {
    if (!this.client) {
      return { count: 0, storageMode: "qdrant" };
    }

    const info = await withRetry(
      () => this.client!.getCollection(this.collection),
      { operationName: "stats" }
    );
    return { count: info.points_count || 0, storageMode: "qdrant" };
  }
  
  async inspect(limit: number = 10, documentId?: number): Promise<ChunkInfo[]> {
    if (!this.client) {
      return [];
    }

    const results = await withRetry(
      () => this.client!.scroll(this.collection, {
        limit,
        filter: documentId !== undefined ? {
          must: [{ key: "document_id", match: { value: documentId } }],
        } : undefined,
      }),
      { operationName: "inspect" }
    );

    return results.points.map((point: any) => ({
      chunk_id: point.payload?.chunk_id || String(point.id),
      document_id: point.payload?.document_id,
      title: point.payload?.title || "",
      content_preview: ((point.payload?.content as string) || "").substring(0, 200),
      source: point.payload?.source || "",
      page: point.payload?.page || null,
      created: point.payload?.created || null,
    }));
  }

  async getSyncStatus(): Promise<SyncStatus> {
    if (!this.client) {
      return { total_indexed: 0, documents: [], last_sync: null };
    }

    const results = await withRetry(
      () => this.client!.scroll(this.indexedCollection, { limit: 10000 }),
      { operationName: "getSyncStatus" }
    );

    const documents: IndexedDocument[] = results.points.map((point: any) => ({
      document_id: point.payload?.document_id,
      last_modified: point.payload?.last_modified || "",
      indexed_at: point.payload?.indexed_at || "",
      chunk_count: point.payload?.chunk_count || 0,
    }));

    const lastSync = documents.length > 0
      ? documents.reduce((latest, doc) => doc.indexed_at > latest ? doc.indexed_at : latest, documents[0].indexed_at)
      : null;

    return {
      total_indexed: documents.length,
      documents,
      last_sync: lastSync,
    };
  }

  async getDocumentsNeedingSync(documents: Array<{ id: number; modified: string }>): Promise<number[]> {
    if (!this.client) {
      return documents.map(d => d.id);
    }

    const results = await withRetry(
      () => this.client!.scroll(this.indexedCollection, { limit: 10000 }),
      { operationName: "getDocumentsNeedingSync" }
    );
    const indexed = new Map<number, { last_modified: string }>();

    results.points.forEach((point: any) => {
      indexed.set(point.payload?.document_id, { last_modified: point.payload?.last_modified });
    });

    const needsSync: number[] = [];

    for (const doc of documents) {
      const existing = indexed.get(doc.id);
      if (!existing) {
        needsSync.push(doc.id);
      } else if (doc.modified > existing.last_modified) {
        needsSync.push(doc.id);
      }
    }

    return needsSync;
  }

  async markDocumentsIndexed(documentId: number, lastModified: string, chunkCount: number): Promise<void> {
    if (!this.client) {
      return;
    }

    const indexedAt = new Date().toISOString();

    await withRetry(async () => {
      // Delete existing
      await this.client!.delete(this.indexedCollection, {
        filter: { must: [{ key: "document_id", match: { value: documentId } }] },
      });

      // Add new entry
      await this.client!.upsert(this.indexedCollection, {
        points: [{
          id: toQdrantUUID(`doc_${documentId}`),
          vector: [1],  // Dummy vector
          payload: {
            document_id: documentId,
            last_modified: lastModified,
            indexed_at: indexedAt,
            chunk_count: chunkCount,
          },
        }],
      });
    }, { operationName: "markDocumentsIndexed" });
  }
}

// Factory function
let vectorStore: VectorStore | null = null;

export async function getVectorStore(): Promise<VectorStore> {
  if (vectorStore) {
    return vectorStore;
  }
  
  const config = getConfig();
  const mode = getStorageMode(config);
  
  if (mode === "qdrant" && config.qdrantUrl) {
    vectorStore = new QdrantVectorStore(config.qdrantUrl, config.qdrantCollection);
  } else {
    vectorStore = new LanceDBVectorStore(config.lancedbPath);
  }
  
  await vectorStore.initialize();
  return vectorStore;
}

export function getStorageModeLabel(): "qdrant" | "lancedb" {
  return getStorageMode(getConfig());
}
