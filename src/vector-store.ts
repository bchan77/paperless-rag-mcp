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
    
    // Check if table exists, create if not
    const tableNames = await this.db.tableNames();
    if (!tableNames.includes("documents")) {
      this.table = await this.db.createTable("documents", [
        {
          name: "id",
          type: "vector",
          vectorType: "float32",
          dimension: 1536,
        },
        {
          name: "document_id",
          type: "int32",
        },
        {
          name: "chunk_id",
          type: "string",
        },
        {
          name: "content",
          type: "string",
        },
        {
          name: "title",
          type: "string",
        },
        {
          name: "source",
          type: "string",
        },
        {
          name: "page",
          type: "int32",
        },
        {
          name: "created",
          type: "string",
        },
      ]);
    } else {
      this.table = await this.db.openTable("documents");
    }
  }
  
  async addDocuments(chunks: DocumentChunk[]): Promise<void> {
    if (!this.table) {
      throw new Error("Vector store not initialized. Call initialize() first.");
    }
    
    const rows = chunks.map((chunk) => ({
      id: chunk.embedding || new Array(1536).fill(0),
      document_id: chunk.documentId,
      chunk_id: chunk.id,
      content: chunk.content,
      title: chunk.metadata.title,
      source: chunk.metadata.source,
      page: chunk.metadata.page || 0,
      created: chunk.metadata.created || "",
    }));
    
    await this.table.add(rows);
  }
  
  async search(queryEmbedding: number[], limit: number = 5): Promise<SearchResult[]> {
    if (!this.table) {
      throw new Error("Vector store not initialized. Call initialize() first.");
    }
    
    // Note: LanceDB search requires actual vectors
    // For now, return empty results until embeddings are implemented
    console.log("LanceDB search called - embeddings not yet implemented");
    return [];
  }
  
  async deleteDocument(documentId: number): Promise<void> {
    if (!this.table) {
      throw new Error("Vector store not initialized. Call initialize() first.");
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
