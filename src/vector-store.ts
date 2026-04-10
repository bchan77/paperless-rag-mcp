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
        score: row.score || (row._distance ? 1 - row._distance : 0), // LanceDB may include distance
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
  private readonly url: string;
  private readonly collection: string;
  private readonly indexedCollection: string;
  
  constructor(url: string, collection: string) {
    this.url = url;
    this.collection = collection;
    this.indexedCollection = `${collection}_indexed`;
  }
  
  async initialize(): Promise<void> {
    this.client = new QdrantClient({ url: this.url });
    
    // Create main collection if not exists
    const collections = await this.client.getCollections();
    const collectionNames = collections.collections.map(c => c.name);
    
    if (!collectionNames.includes(this.collection)) {
      await this.client.createCollection(this.collection, {
        vectors: { size: 1536, distance: "Cosine" },
      });
    }
    
    // Create indexed tracking collection if not exists
    if (!collectionNames.includes(this.indexedCollection)) {
      await this.client.createCollection(this.indexedCollection, {
        vectors: { size: 1, distance: "Dot" },  // Dummy vector for tracking
      });
    }
  }
  
  async addDocuments(chunks: DocumentChunk[]): Promise<void> {
    if (!this.client) {
      throw new Error("Vector store not initialized. Call initialize() first.");
    }
    
    const points = chunks.map((chunk) => ({
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
      return;
    }
    
    await this.client.delete(this.collection, {
      filter: {
        must: [{ key: "document_id", match: { value: documentId } }],
      },
    });
    
    await this.client.delete(this.indexedCollection, {
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
      return [];
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
    
    const results = await this.client.scroll(this.indexedCollection, { limit: 10000 });
    
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
    
    const results = await this.client.scroll(this.indexedCollection, { limit: 10000 });
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
    
    // Delete existing
    await this.client.delete(this.indexedCollection, {
      filter: { must: [{ key: "document_id", match: { value: documentId } }] },
    });
    
    // Add new entry
    await this.client.upsert(this.indexedCollection, {
      points: [{
        id: `doc_${documentId}`,
        vector: [1],  // Dummy vector
        payload: {
          document_id: documentId,
          last_modified: lastModified,
          indexed_at: indexedAt,
          chunk_count: chunkCount,
        },
      }],
    });
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
