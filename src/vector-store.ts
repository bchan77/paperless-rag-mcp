/**
 * Vector Store Module
 * 
 * Provides a unified interface for vector storage.
 * Uses LanceDB by default (local file-based), or Qdrant if QDRANT_URL is configured.
 */

import { getConfig, getStorageMode } from "./config.js";

export interface DocumentChunk {
  id: string;
  documentId: number;
  content: string;
  metadata: {
    title: string;
    source: string;
    page?: number;
    created?: string;
    [key: string]: unknown;
  };
  embedding?: number[];
}

export interface SearchResult {
  id: string;
  documentId: number;
  content: string;
  metadata: Record<string, unknown>;
  score?: number;
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
}

// LanceDB implementation
import { connect, Table } from "@lancedb/lancedb";

class LanceDBVectorStore implements VectorStore {
  private db: Awaited<ReturnType<typeof connect>> | null = null;
  private table: Table | null = null;
  private readonly dbPath: string;
  
  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }
  
  async initialize(): Promise<void> {
    this.db = await connect(this.dbPath);

    // Check if table exists, open it if so
    // Table will be created on first addDocuments call with actual data
    const tableNames = await this.db.tableNames();
    if (tableNames.includes("documents")) {
      this.table = await this.db.openTable("documents");
    }
    // If table doesn't exist, this.table stays null until addDocuments is called
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
      // Create table with first batch of data - LanceDB infers schema from data
      this.table = await this.db.createTable("documents", rows);
    } else {
      await this.table.add(rows);
    }
  }
  
  async search(queryEmbedding: number[], limit: number = 5): Promise<SearchResult[]> {
    if (!this.table) {
      // No documents indexed yet
      return [];
    }

    // Note: LanceDB search requires actual vectors
    // For now, return empty results until embeddings are implemented
    console.log("LanceDB search called - embeddings not yet implemented");
    return [];
  }
  
  async deleteDocument(documentId: number): Promise<void> {
    if (!this.table) {
      // No documents indexed yet, nothing to delete
      return;
    }

    await this.table.delete(`document_id = ${documentId}`);
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
      // No documents indexed yet
      return [];
    }

    // Get all rows - let LanceDB handle the schema
    let results: any[];
    if (documentId !== undefined) {
      results = await this.table.query().where(`document_id = ${documentId}`).limit(limit).toArray();
    } else {
      results = await this.table.query().limit(limit).toArray();
    }
    
    return results.map((row: any) => {
      // Handle different possible field names (snake_case vs camelCase)
      const docId = row.document_id ?? row.documentId ?? row.id;
      const chunkId = row.chunk_id ?? row.chunkId ?? row.id;
      const contentField = row.content ?? row.text ?? row.page_content ?? "";
      
      return {
        chunk_id: chunkId,
        document_id: docId,
        title: row.title ?? "",
        content_preview: (contentField || "").substring(0, 200) + ((contentField || "").length > 200 ? "..." : ""),
        source: row.source ?? "",
        page: row.page ?? null,
        created: row.created ?? null,
      };
    });
  }
}

// Qdrant implementation
import { QdrantClient } from "@qdrant/js-client-rest";

class QdrantVectorStore implements VectorStore {
  private client: QdrantClient | null = null;
  private readonly url: string;
  private readonly collection: string;
  
  constructor(url: string, collection: string) {
    this.url = url;
    this.collection = collection;
  }
  
  async initialize(): Promise<void> {
    this.client = new QdrantClient({ url: this.url });
    
    // Create collection if it doesn't exist
    const collections = await this.client.getCollections();
    const collectionNames = collections.collections.map(c => c.name);
    
    if (!collectionNames.includes(this.collection)) {
      await this.client.createCollection(this.collection, {
        vectors: {
          size: 1536, // OpenAI embedding dimension
          distance: "Cosine",
        },
      });
    }
  }
  
  async addDocuments(chunks: DocumentChunk[]): Promise<void> {
    if (!this.client) {
      throw new Error("Vector store not initialized. Call initialize() first.");
    }
    
    const points = chunks.map((chunk, index) => ({
      id: chunk.id,
      vector: chunk.embedding || new Array(1536).fill(0),
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
    
    await this.client.upsert(this.collection, { points });
  }
  
  async search(queryEmbedding: number[], limit: number = 5): Promise<SearchResult[]> {
    if (!this.client) {
      throw new Error("Vector store not initialized. Call initialize() first.");
    }
    
    const results = await this.client.search(this.collection, {
      vector: queryEmbedding,
      limit,
    });
    
    return results.map((result) => ({
      id: String(result.id),
      documentId: result.payload?.document_id as number,
      content: result.payload?.content as string,
      metadata: result.payload as Record<string, unknown>,
      score: result.score,
    }));
  }
  
  async deleteDocument(documentId: number): Promise<void> {
    if (!this.client) {
      throw new Error("Vector store not initialized. Call initialize() first.");
    }
    
    await this.client.delete(this.collection, {
      filter: {
        must: [{ key: "document_id", match: { value: documentId } }],
      },
    });
  }
  
  async stats(): Promise<{ count: number; storageMode: "qdrant" | "lancedb" }> {
    if (!this.client) {
      return { count: 0, storageMode: "qdrant" };
    }
    
    const info = await this.client.getCollection(this.collection);
    return { count: info.points_count || 0, storageMode: "qdrant" };
  }
  
  async inspect(limit: number = 10, documentId?: number): Promise<ChunkInfo[]> {
    if (!this.client) {
      throw new Error("Vector store not initialized. Call initialize() first.");
    }
    
    const results = await this.client.scroll(this.collection, {
      limit,
      filter: documentId !== undefined ? {
        must: [{ key: "document_id", match: { value: documentId } }],
      } : undefined,
    });
    
    return results.points.map((point: any) => ({
      chunk_id: point.payload?.chunk_id || String(point.id),
      document_id: point.payload?.document_id,
      title: point.payload?.title || "",
      content_preview: ((point.payload?.content as string) || "").substring(0, 200) + (((point.payload?.content as string) || "").length > 200 ? "..." : ""),
      source: point.payload?.source || "",
      page: point.payload?.page || null,
      created: point.payload?.created || null,
    }));
  }
}

// Factory function to create the appropriate vector store
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
