import { getVectorStore, getStorageModeLabel } from "../vector-store.js";
import { PaperlessAPI } from "@baruchiro/paperless-mcp/build/api/PaperlessAPI.js";
import { getConfig } from "../config.js";
import { embedTexts, chunkText } from "../embeddings.js";
import { createSyncJob, getJob, updateJobProgress, completeJob, failJob, listJobs } from "../jobs.js";
import type { Tool } from "./types.js";

/**
 * RAG tools - vector storage and search
 * Uses LanceDB by default, can fall back to Qdrant if configured
 * Supports delta sync and background jobs for large document sets
 */

function getPaperlessAPI(): PaperlessAPI {
  const config = getConfig();
  return new PaperlessAPI(config.paperlessUrl, config.paperlessToken);
}

// Background sync worker
async function runSyncInBackground(
  jobId: string,
  options: {
    document_ids?: number[];
    force?: boolean;
    chunk_size?: number;
  }
): Promise<void> {
  const startTime = Date.now();
  const config = getConfig();
  const store = await getVectorStore();
  const paperless = getPaperlessAPI();
  const chunkSize = options.chunk_size || 500;
  
  try {
    updateJobProgress(jobId, 0, 100, "Fetching documents from Paperless...");
    
    let paperlessDocs;
    
    if (options.document_ids && options.document_ids.length > 0) {
      paperlessDocs = [];
      for (const docId of options.document_ids) {
        try {
          const doc = await paperless.getDocument(docId);
          paperlessDocs.push(doc);
        } catch (err) {
          console.error(`[rag_sync:${jobId}] Failed to fetch document ${docId}`);
        }
      }
    } else {
      const response = await paperless.getDocuments();
      paperlessDocs = response.results;
    }
    
    if (paperlessDocs.length === 0) {
      completeJob(jobId, {
        status: "completed",
        documents_processed: 0,
        chunks_created: 0,
        documents_skipped: 0,
        time_seconds: ((Date.now() - startTime) / 1000).toFixed(2),
      });
      return;
    }
    
    let docsToSync: typeof paperlessDocs;
    
    if (options.force) {
      docsToSync = paperlessDocs;
    } else {
      const docsWithModTime = paperlessDocs.map(d => ({
        id: d.id,
        modified: d.modified || d.created || "",
      }));
      const needsSyncIds = await store.getDocumentsNeedingSync(docsWithModTime);
      docsToSync = paperlessDocs.filter(d => needsSyncIds.includes(d.id));
    }
    
    if (docsToSync.length === 0) {
      completeJob(jobId, {
        status: "completed",
        documents_processed: 0,
        chunks_created: 0,
        documents_skipped: paperlessDocs.length,
        time_seconds: ((Date.now() - startTime) / 1000).toFixed(2),
      });
      return;
    }
    
    const chunks: any[] = [];
    const docChunkCounts: Map<number, number> = new Map();
    
    for (let i = 0; i < docsToSync.length; i++) {
      const doc = docsToSync[i];
      const content = doc.content || "";
      
      if (!content.trim()) {
        continue;
      }
      
      const textChunks = chunkText(content, chunkSize);
      docChunkCounts.set(doc.id, textChunks.length);
      
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
        });
      }
      
      updateJobProgress(
        jobId,
        Math.round((i + 1) / docsToSync.length * 50),
        100,
        `Processing: ${doc.title || `Doc ${doc.id}`} (${i + 1}/${docsToSync.length})`
      );
    }
    
    if (chunks.length === 0) {
      completeJob(jobId, {
        status: "completed",
        documents_processed: docsToSync.length,
        chunks_created: 0,
        documents_skipped: paperlessDocs.length - docsToSync.length,
        time_seconds: ((Date.now() - startTime) / 1000).toFixed(2),
      });
      return;
    }
    
    const contents = chunks.map(c => c.content);
    
    for (let i = 0; i < contents.length; i += 10) {
      const batch = contents.slice(i, i + 10);
      const batchEmbeddings = await embedTexts(batch);
      
      for (let j = 0; j < batchEmbeddings.length; j++) {
        chunks[i + j].embedding = batchEmbeddings[j];
      }
      
      updateJobProgress(
        jobId,
        50 + Math.round((i + batch.length) / contents.length * 40),
        100,
        `Generating embeddings: ${Math.min(i + batch.length, contents.length)}/${contents.length}`
      );
    }
    
    if (!options.force) {
      for (const docId of docsToSync.map(d => d.id)) {
        await store.deleteDocument(docId);
      }
    }
    
    await store.addDocuments(chunks);
    
    for (const doc of docsToSync) {
      const chunkCount = docChunkCounts.get(doc.id) || 0;
      await store.markDocumentsIndexed(
        doc.id,
        doc.modified || doc.created || new Date().toISOString(),
        chunkCount
      );
    }
    
    updateJobProgress(jobId, 100, 100, "Completed");
    
    completeJob(jobId, {
      status: "completed",
      documents_processed: docsToSync.length,
      chunks_created: chunks.length,
      documents_skipped: paperlessDocs.length - docsToSync.length,
      time_seconds: ((Date.now() - startTime) / 1000).toFixed(2),
    });
    
  } catch (error) {
    console.error(`[rag_sync:${jobId}] Error: ${error}`);
    failJob(jobId, error instanceof Error ? error.message : String(error));
  }
}

export const ragTools: Tool[] = [
  {
    name: "rag_query",
    description: "Query documents using natural language. Returns relevant document chunks.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number", default: 5 },
      },
      required: ["query"],
    },
    handler: async (args) => ({
      message: "rag_query not yet implemented with embeddings",
      query: args.query,
      results: [],
      storage_mode: getStorageModeLabel(),
    }),
  },
  {
    name: "rag_summarize",
    description: "Summarize a document",
    inputSchema: {
      type: "object",
      properties: {
        document_id: { type: "number" },
        max_length: { type: "number", default: 200 },
      },
      required: ["document_id"],
    },
    handler: async (args) => ({
      message: "rag_summarize not yet implemented",
      document_id: args.document_id,
      summary: "",
      storage_mode: getStorageModeLabel(),
    }),
  },
  {
    name: "rag_sync",
    description: "Sync documents from Paperless. Runs in background - use rag_sync_status to check progress.",
    inputSchema: {
      type: "object",
      properties: {
        document_ids: { type: "array", items: { type: "number" } },
        force: { type: "boolean", default: false },
        chunk_size: { type: "number", default: 500 },
      },
    },
    handler: async (args) => {
      const job = createSyncJob();
      console.error(`[rag_sync] Started background job: ${job.id}`);
      
      runSyncInBackground(job.id, {
        document_ids: args.document_ids as number[] | undefined,
        force: args.force as boolean,
        chunk_size: args.chunk_size as number,
      });
      
      return {
        status: "started",
        job_id: job.id,
        message: `Sync started. Use rag_sync_status(job_id="${job.id}") to check progress.`,
      };
    },
  },
  {
    name: "rag_sync_status",
    description: "Check sync job status. Returns progress and results when complete.",
    inputSchema: {
      type: "object",
      properties: {
        job_id: { type: "string" },
      },
      required: ["job_id"],
    },
    handler: async (args) => {
      const job = getJob(args.job_id as string);
      if (!job) {
        return { status: "error", error: `Job ${args.job_id} not found` };
      }
      return {
        job_id: job.id,
        status: job.status,
        progress: job.progress,
        total: job.total,
        message: job.message,
        result: job.result,
        error: job.error,
        started_at: job.started_at,
        completed_at: job.completed_at,
      };
    },
  },
  {
    name: "rag_sync_list",
    description: "List all sync jobs (recent first, last 24 hours).",
    inputSchema: { type: "object", properties: {} },
    handler: async () => ({
      jobs: listJobs().map(job => ({
        job_id: job.id,
        status: job.status,
        progress: job.progress,
        total: job.total,
        message: job.message,
        started_at: job.started_at,
        completed_at: job.completed_at,
      })),
    }),
  },
  {
    name: "rag_sync_status_all",
    description: "Get status of all documents (shows which are indexed and up-to-date).",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      try {
        const store = await getVectorStore();
        const syncStatus = await store.getSyncStatus();
        return {
          storage_mode: getStorageModeLabel(),
          total_indexed_documents: syncStatus.total_indexed,
          last_sync: syncStatus.last_sync,
          indexed_documents: syncStatus.documents,
        };
      } catch (error) {
        return { status: "error", error: error instanceof Error ? error.message : String(error) };
      }
    },
  },
  {
    name: "rag_stats",
    description: "Get vector store statistics.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      try {
        const store = await getVectorStore();
        const stats = await store.stats();
        return { total_documents: stats.count, storage_mode: stats.storageMode, status: "initialized" };
      } catch (error) {
        return { total_documents: 0, storage_mode: getStorageModeLabel(), status: "error", error: error instanceof Error ? error.message : String(error) };
      }
    },
  },
  {
    name: "rag_debug",
    description: "Debug tool to inspect vector store contents.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", default: 10 },
        document_id: { type: "number" },
      },
    },
    handler: async (args) => {
      try {
        const store = await getVectorStore();
        const stats = await store.stats();
        const chunks = await store.inspect(args.limit as number, args.document_id as number | undefined);
        return { storage_mode: stats.storageMode, total_indexed_chunks: stats.count, chunks };
      } catch (error) {
        return { status: "error", error: error instanceof Error ? error.message : String(error) };
      }
    },
  },
];
