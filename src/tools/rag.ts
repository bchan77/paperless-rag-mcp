import { getVectorStore, getStorageModeLabel } from "../vector-store.js";
import { PaperlessAPI } from "@baruchiro/paperless-mcp/build/api/PaperlessAPI.js";
import { getConfig } from "../config.js";
import { embedText, embedTexts, chunkText } from "../embeddings.js";
import type { Tool } from "./types.js";

/**
 * RAG tools - vector storage and search
 * Uses LanceDB as default, can fall back to Qdrant if configured
 * Supports delta sync - only indexes new/modified documents
 */

// Create Paperless API client using config
function getPaperlessAPI(): PaperlessAPI {
  const config = getConfig();
  return new PaperlessAPI(config.paperlessUrl, config.paperlessToken);
}

export const ragTools: Tool[] = [
  {
    name: "rag_query",
    description: "Query documents using natural language. Returns relevant document chunks.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The search query in natural language",
        },
        limit: {
          type: "number",
          description: "Maximum number of results to return",
          default: 5,
        },
      },
      required: ["query"],
    },
    handler: async (args: Record<string, unknown>) => {
      // TODO: Implement actual vector search with embeddings
      return {
        message: "rag_query not yet implemented with embeddings",
        query: args.query,
        results: [],
        storage_mode: getStorageModeLabel(),
        note: "Embeddings need to be implemented first",
      };
    },
  },
  {
    name: "rag_summarize",
    description: "Summarize a document or set of documents",
    inputSchema: {
      type: "object",
      properties: {
        document_id: {
          type: "number",
          description: "Document ID from Paperless",
        },
        max_length: {
          type: "number",
          description: "Maximum summary length in words",
          default: 200,
        },
      },
      required: ["document_id"],
    },
    handler: async (args: Record<string, unknown>) => {
      // TODO: Implement actual summarization with LLM
      return {
        message: "rag_summarize not yet implemented",
        document_id: args.document_id,
        summary: "",
        storage_mode: getStorageModeLabel(),
      };
    },
  },
  {
    name: "rag_sync",
    description: "Sync documents from Paperless to the vector store. Uses delta sync - only indexes new or modified documents.",
    inputSchema: {
      type: "object",
      properties: {
        document_ids: {
          type: "array",
          items: { type: "number" },
          description: "Specific document IDs to sync, or omit to sync all (uses delta sync)",
        },
        force: {
          type: "boolean",
          description: "Force re-indexing of ALL documents (ignore delta sync)",
          default: false,
        },
        chunk_size: {
          type: "number",
          description: "Maximum chunk size in characters",
          default: 500,
        },
      },
    },
    handler: async (args: Record<string, unknown>) => {
      const startTime = Date.now();
      const config = getConfig();
      const store = await getVectorStore();
      const paperless = getPaperlessAPI();
      
      console.error("[rag_sync] Starting document sync...");
      console.error(`[rag_sync] Storage mode: ${getStorageModeLabel()}`);
      console.error(`[rag_sync] Chunk size: ${args.chunk_size || 500} characters`);
      
      if (args.force) {
        console.error("[rag_sync] Force mode: RE-INDEXING all documents");
      }
      
      try {
        // Step 1: Get all documents from Paperless with modification times
        console.error("[rag_sync] Fetching documents from Paperless...");
        let paperlessDocs;
        
        if (args.document_ids && Array.isArray(args.document_ids) && args.document_ids.length > 0) {
          // Fetch specific documents
          paperlessDocs = [];
          for (const docId of args.document_ids as number[]) {
            try {
              const doc = await paperless.getDocument(docId);
              paperlessDocs.push(doc);
            } catch (err) {
              console.error(`[rag_sync] Failed to fetch document ${docId}: ${err}`);
            }
          }
          console.error(`[rag_sync] Fetched ${paperlessDocs.length} specific documents`);
        } else {
          // Fetch all documents
          const response = await paperless.getDocuments();
          paperlessDocs = response.results;
          console.error(`[rag_sync] Fetched ${paperlessDocs.length} total documents from Paperless`);
        }
        
        if (paperlessDocs.length === 0) {
          console.error("[rag_sync] No documents to sync");
          return {
            status: "completed",
            documents_processed: 0,
            chunks_created: 0,
            documents_skipped: 0,
            time_seconds: ((Date.now() - startTime) / 1000).toFixed(2),
          };
        }
        
        // Step 2: Determine which documents need syncing (delta sync)
        let docsToSync: typeof paperlessDocs;
        
        if (args.force) {
          docsToSync = paperlessDocs;
          console.error(`[rag_sync] Force mode: will re-index all ${docsToSync.length} documents`);
        } else {
          // Delta sync - check which docs are new or modified
          const docsWithModTime = paperlessDocs.map(d => ({
            id: d.id,
            modified: d.modified || d.created || "",
          }));
          
          const needsSyncIds = await store.getDocumentsNeedingSync(docsWithModTime);
          docsToSync = paperlessDocs.filter(d => needsSyncIds.includes(d.id));
          
          const skipped = paperlessDocs.length - docsToSync.length;
          console.error(`[rag_sync] Delta sync: ${docsToSync.length} need update, ${skipped} are up-to-date`);
        }
        
        if (docsToSync.length === 0) {
          console.error("[rag_sync] All documents are up-to-date, nothing to sync");
          return {
            status: "completed",
            documents_processed: 0,
            chunks_created: 0,
            documents_skipped: paperlessDocs.length,
            time_seconds: ((Date.now() - startTime) / 1000).toFixed(2),
          };
        }
        
        // Step 3: Process documents and create chunks
        console.error("[rag_sync] Processing documents and creating chunks...");
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const chunks: any[] = [];
        const chunkSize = (args.chunk_size as number) || 500;
        const docChunkCounts: Map<number, number> = new Map();
        
        for (let i = 0; i < docsToSync.length; i++) {
          const doc = docsToSync[i];
          
          // Get document content
          const content = doc.content || "";
          
          if (!content.trim()) {
            console.error(`[rag_sync] Document ${doc.id} (${doc.title || 'untitled'}) - skipping (no content)`);
            continue;
          }
          
          // Chunk the document
          const textChunks = chunkText(content, chunkSize);
          docChunkCounts.set(doc.id, textChunks.length);
          console.error(`[rag_sync] [${i + 1}/${docsToSync.length}] ${doc.title || `Doc ${doc.id}`} - ${textChunks.length} chunks`);
          
          // Create chunks with metadata
          for (let j = 0; j < textChunks.length; j++) {
            chunks.push({
              id: `${doc.id}-chunk-${j}`,
              documentId: doc.id,
              content: textChunks[j],
              metadata: {
                title: doc.title || `Document ${doc.id}`,
                source: config.paperlessUrl,
                page: j + 1,
                created: doc.created,
                modified: doc.modified,
              },
            } as any);
          }
        }
        
        console.error(`[rag_sync] Created ${chunks.length} total chunks from ${docsToSync.length} documents`);
        
        if (chunks.length === 0) {
          console.error("[rag_sync] No chunks to index");
          return {
            status: "completed",
            documents_processed: docsToSync.length,
            chunks_created: 0,
            documents_skipped: paperlessDocs.length - docsToSync.length,
            time_seconds: ((Date.now() - startTime) / 1000).toFixed(2),
          };
        }
        
        // Step 4: Generate embeddings
        console.error("[rag_sync] Generating embeddings...");
        const contents = chunks.map((c: any) => c.content);
        
        let embeddings: number[][];
        try {
          embeddings = await embedTexts(contents, (current, total) => {
            if (current % 10 === 0 || current === total) {
              const pct = Math.round(current / total * 100);
              console.error(`[rag_sync] Embedding: ${current}/${total} (${pct}%)`);
            }
          });
        } catch (err) {
          console.error(`[rag_sync] ERROR generating embeddings: ${err}`);
          throw err;
        }
        
        // Step 5: Add embeddings to chunks
        for (let i = 0; i < chunks.length; i++) {
          (chunks[i] as any).embedding = embeddings[i];
        }
        
        // Step 6: Delete old chunks for docs being re-indexed
        if (!args.force) {
          console.error("[rag_sync] Removing old chunks for re-indexed documents...");
          for (const docId of docsToSync.map(d => d.id)) {
            await store.deleteDocument(docId);
          }
        }
        
        // Step 7: Store in vector database
        console.error("[rag_sync] Storing chunks in vector database...");
        await store.addDocuments(chunks);
        
        // Step 8: Mark documents as indexed
        console.error("[rag_sync] Updating sync tracking...");
        for (const doc of docsToSync) {
          const chunkCount = docChunkCounts.get(doc.id) || 0;
          await store.markDocumentsIndexed(doc.id, doc.modified || doc.created || new Date().toISOString(), chunkCount);
        }
        
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
        console.error(`[rag_sync] === SYNC COMPLETED ===`);
        console.error(`[rag_sync] Documents processed: ${docsToSync.length}`);
        console.error(`[rag_sync] Chunks created: ${chunks.length}`);
        console.error(`[rag_sync] Documents skipped (up-to-date): ${paperlessDocs.length - docsToSync.length}`);
        console.error(`[rag_sync] Time elapsed: ${elapsed}s`);
        
        return {
          status: "completed",
          documents_processed: docsToSync.length,
          chunks_created: chunks.length,
          documents_skipped: paperlessDocs.length - docsToSync.length,
          time_seconds: parseFloat(elapsed),
        };
        
      } catch (error) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
        console.error(`[rag_sync] ERROR: ${error instanceof Error ? error.message : String(error)}`);
        
        return {
          status: "error",
          error: error instanceof Error ? error.message : String(error),
          documents_processed: 0,
          chunks_created: 0,
          documents_skipped: 0,
          time_seconds: parseFloat(elapsed),
        };
      }
    },
  },
  {
    name: "rag_sync_status",
    description: "Get the status of the vector store sync - shows which documents are indexed and when they were last synced.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    handler: async () => {
      try {
        const store = await getVectorStore();
        const syncStatus = await store.getSyncStatus();
        const stats = await store.stats();
        
        return {
          storage_mode: getStorageModeLabel(),
          total_indexed_documents: syncStatus.total_indexed,
          total_chunks: stats.count,
          last_sync: syncStatus.last_sync,
          indexed_documents: syncStatus.documents.map(d => ({
            document_id: d.document_id,
            last_modified: d.last_modified,
            indexed_at: d.indexed_at,
            chunk_count: d.chunk_count,
          })),
        };
      } catch (error) {
        return {
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  },
  {
    name: "rag_stats",
    description: "Get statistics about the vector store",
    inputSchema: {
      type: "object",
      properties: {},
    },
    handler: async () => {
      try {
        const store = await getVectorStore();
        const stats = await store.stats();
        return {
          total_documents: stats.count,
          storage_mode: stats.storageMode,
          status: "initialized",
        };
      } catch (error) {
        return {
          total_documents: 0,
          storage_mode: getStorageModeLabel(),
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  },
  {
    name: "rag_debug",
    description: "Debug tool to inspect vector store contents (for development only)",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Maximum number of chunks to show",
          default: 10,
        },
        document_id: {
          type: "number",
          description: "Filter by specific document ID",
        },
      },
    },
    handler: async (args: Record<string, unknown>) => {
      try {
        const store = await getVectorStore();
        const stats = await store.stats();
        const limit = (args.limit as number) || 10;
        const documentId = args.document_id as number | undefined;
        
        const chunks = await store.inspect(limit, documentId);
        
        return {
          storage_mode: stats.storageMode,
          total_indexed_chunks: stats.count,
          chunks,
          config: {
            lancedb_path: process.env.LANCEDB_PATH || "./data/lancedb",
            qdrant_url: process.env.QDRANT_URL || null,
            qdrant_collection: process.env.QDRANT_COLLECTION || "paperless_documents",
          },
        };
      } catch (error) {
        return {
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  },
];
