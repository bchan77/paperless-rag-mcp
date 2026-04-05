import { getVectorStore, getStorageModeLabel, type DocumentChunk } from "../vector-store.js";
import { PaperlessAPI } from "@baruchiro/paperless-mcp/build/api/PaperlessAPI.js";
import { getConfig } from "../config.js";
import { embedText, embedTexts, chunkText } from "../embeddings.js";
import type { Tool } from "./types.js";

/**
 * RAG tools - vector storage and search
 * Uses LanceDB as default, can fall back to Qdrant if configured
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
    description: "Sync documents from Paperless to the vector store. Indexes documents with embeddings for RAG.",
    inputSchema: {
      type: "object",
      properties: {
        document_ids: {
          type: "array",
          items: { type: "number" },
          description: "Specific document IDs to sync, or omit to sync all",
        },
        force: {
          type: "boolean",
          description: "Force re-indexing even if already indexed",
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
      
      try {
        // Step 1: Get documents from Paperless
        console.error("[rag_sync] Fetching documents from Paperless...");
        let documents;
        
        if (args.document_ids && Array.isArray(args.document_ids) && args.document_ids.length > 0) {
          // Fetch specific documents
          documents = [];
          for (const docId of args.document_ids) {
            try {
              const doc = await paperless.getDocument(docId as number);
              documents.push(doc);
            } catch (err) {
              console.error(`[rag_sync] Failed to fetch document ${docId}: ${err}`);
            }
          }
          console.error(`[rag_sync] Fetched ${documents.length} specific documents`);
        } else {
          // Fetch all documents
          const response = await paperless.getDocuments();
          documents = response.results;
          console.error(`[rag_sync] Fetched ${documents.length} documents from Paperless`);
        }
        
        if (documents.length === 0) {
          console.error("[rag_sync] No documents to sync");
          return {
            status: "completed",
            documents_processed: 0,
            chunks_created: 0,
            time_seconds: ((Date.now() - startTime) / 1000).toFixed(2),
          };
        }
        
        // Step 2: Process documents and create chunks
        console.error("[rag_sync] Processing documents and creating chunks...");
        const chunks: DocumentChunk[] = [];
        const chunkSize = (args.chunk_size as number) || 500;
        
        for (let i = 0; i < documents.length; i++) {
          const doc = documents[i];
          
          // Get document content (may be null for some docs)
          const content = doc.content || "";
          
          if (!content.trim()) {
            console.error(`[rag_sync] Document ${doc.id} (${doc.title || 'untitled'}) - skipping (no content)`);
            continue;
          }
          
          // Chunk the document
          const textChunks = chunkText(content, chunkSize);
          console.error(`[rag_sync] Document ${doc.id} (${doc.title || 'untitled'}) - ${textChunks.length} chunks`);
          
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
              },
            });
          }
        }
        
        console.error(`[rag_sync] Created ${chunks.length} total chunks from ${documents.length} documents`);
        
        if (chunks.length === 0) {
          console.error("[rag_sync] No chunks to index");
          return {
            status: "completed",
            documents_processed: documents.length,
            chunks_created: 0,
            time_seconds: ((Date.now() - startTime) / 1000).toFixed(2),
          };
        }
        
        // Step 3: Generate embeddings
        console.error("[rag_sync] Generating embeddings (this may take a while)...");
        const contents = chunks.map(c => c.content);
        
        let embeddings: number[][];
        try {
          embeddings = await embedTexts(contents, (current, total) => {
            if (current % 10 === 0 || current === total) {
              console.error(`[rag_sync] Embedding progress: ${current}/${total} (${Math.round(current/total*100)}%)`);
            }
          });
        } catch (err) {
          console.error(`[rag_sync] ERROR generating embeddings: ${err}`);
          throw err;
        }
        
        console.error("[rag_sync] Embeddings generated successfully");
        
        // Step 4: Add embeddings to chunks
        for (let i = 0; i < chunks.length; i++) {
          chunks[i].embedding = embeddings[i];
        }
        
        // Step 5: Store in vector database
        console.error("[rag_sync] Storing chunks in vector database...");
        await store.addDocuments(chunks);
        
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
        console.error(`[rag_sync] === SYNC COMPLETED ===`);
        console.error(`[rag_sync] Documents processed: ${documents.length}`);
        console.error(`[rag_sync] Chunks created: ${chunks.length}`);
        console.error(`[rag_sync] Time elapsed: ${elapsed}s`);
        
        return {
          status: "completed",
          documents_processed: documents.length,
          chunks_created: chunks.length,
          time_seconds: parseFloat(elapsed),
        };
        
      } catch (error) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
        console.error(`[rag_sync] ERROR: ${error instanceof Error ? error.message : String(error)}`);
        console.error(`[rag_sync] Failed after ${elapsed}s`);
        
        return {
          status: "error",
          error: error instanceof Error ? error.message : String(error),
          documents_processed: 0,
          chunks_created: 0,
          time_seconds: parseFloat(elapsed),
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
