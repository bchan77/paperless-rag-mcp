import { getVectorStore, getStorageModeLabel } from "../vector-store.js";
import { PaperlessAPI } from "@baruchiro/paperless-mcp/build/api/PaperlessAPI.js";
import { getConfig } from "../config.js";
import { embedTexts, chunkText } from "../embeddings.js";
import { createSyncJob, getJob, updateJobProgress, completeJob, failJob, listJobs } from "../jobs.js";
import { log } from "../logger.js";
import { spawn } from "child_process";
import { readFileSync, writeFileSync, existsSync, openSync, mkdirSync, unlinkSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import type { Tool } from "./types.js";

const STATUS_FILE = "./data/sync-status.json";
const PID_FILE = "./data/sync-worker.pid";

function readSyncStatus(): any {
  if (!existsSync(STATUS_FILE)) {
    return { status: "idle", message: "No sync has been run yet" };
  }
  try {
    return JSON.parse(readFileSync(STATUS_FILE, "utf-8"));
  } catch {
    return { status: "error", message: "Failed to read status file" };
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err.code !== "ESRCH";
  }
}

function spawnSyncWorker(force: boolean): boolean {
  try {
    const currentFile = fileURLToPath(import.meta.url);
    const isDevMode = currentFile.endsWith(".ts");
    const workerPath = isDevMode
      ? join(currentFile, "../../sync-worker.ts")
      : join(currentFile, "../../sync-worker.js");
    const args = force ? ["--force"] : [];

    // Ensure data directory exists
    const dataDir = "./data";
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }

    // Ensure logs directory exists
    if (!existsSync("./logs")) {
      mkdirSync("./logs", { recursive: true });
    }

    // Redirect stderr to file to capture OOM and other fatal errors
    const stderrFile = openSync("./logs/sync-worker-stderr.log", "a");

    // In dev mode (tsx), spawn with --import=tsx so the worker can load .ts files
    const nodeArgs = isDevMode
      ? ["--report-on-fatalerror", "--import=tsx", workerPath, ...args]
      : ["--report-on-fatalerror", workerPath, ...args];

    const child = spawn("node", nodeArgs, {
      detached: true,
      stdio: ["ignore", "ignore", stderrFile],
      env: process.env,
    });

    if (child.pid) {
      writeFileSync(PID_FILE, child.pid.toString(), "utf-8");
      log("info", `[rag_sync] Wrote PID file ${PID_FILE} (PID: ${child.pid})`);
    }

    child.unref();
    log("info", `[rag_sync] Spawned sync worker process (PID: ${child.pid})`);
    return true;
  } catch (err) {
    log("error", `[rag_sync] Failed to spawn worker: ${err}`);
    return false;
  }
}

/**
 * Kill the running sync worker process
 */
function killSyncWorker(): { success: boolean; message: string } {
  try {
    if (!existsSync(PID_FILE)) {
      return { success: false, message: "No PID file found. Worker may not be running." };
    }

    const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
    
    if (isNaN(pid)) {
      return { success: false, message: "Invalid PID in file." };
    }

    try {
      process.kill(pid, "SIGTERM");
      log("info", `[rag_sync_kill] Sent SIGTERM to PID ${pid}`);
      
      // Clean up PID file
      unlinkSync(PID_FILE);
      log("info", `[rag_sync_kill] Removed PID file`);
      
      return { success: true, message: `Sent SIGTERM to worker process (PID: ${pid})` };
    } catch (err: any) {
      if (err.code === "ESRCH") {
        // Process doesn't exist
        log("info", `[rag_sync_kill] Process ${pid} not found, cleaning up PID file`);
        unlinkSync(PID_FILE);
        return { success: true, message: "Worker process was already dead. PID file cleaned up." };
      }
      throw err;
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log("error", `[rag_sync_kill] Failed to kill worker: ${msg}`);
    return { success: false, message: `Failed to kill worker: ${msg}` };
  }
}

/**
 * RAG tools - vector storage and search
 * Uses LanceDB by default, can fall back to Qdrant if configured
 * Supports delta sync and background jobs for large document sets
 */

function getPaperlessAPI(): PaperlessAPI {
  const config = getConfig();
  return new PaperlessAPI(config.paperlessUrl, config.paperlessToken);
}

// Fetch all documents with pagination
async function fetchAllDocuments(
  paperless: PaperlessAPI,
  onProgress?: (fetched: number, total: number) => void
): Promise<any[]> {
  const allDocs: any[] = [];
  const pageSize = 100;
  let page = 1;
  let totalCount = 0;

  log("info", `[fetchAllDocuments] Starting pagination fetch...`);

  // First request to get total count
  const firstResponse = await paperless.getDocuments(`?page=1&page_size=${pageSize}`);
  totalCount = firstResponse.count;
  allDocs.push(...firstResponse.results);

  log("info", `[fetchAllDocuments] Total documents in Paperless: ${totalCount}`);
  log("info", `[fetchAllDocuments] Fetched page 1: ${allDocs.length}/${totalCount}`);

  if (onProgress) {
    onProgress(allDocs.length, totalCount);
  }

  // Fetch remaining pages
  while (allDocs.length < totalCount) {
    page++;
    const response = await paperless.getDocuments(`?page=${page}&page_size=${pageSize}`);
    allDocs.push(...response.results);

    log("info", `[fetchAllDocuments] Fetched page ${page}: ${allDocs.length}/${totalCount}`);

    if (onProgress) {
      onProgress(allDocs.length, totalCount);
    }

    // Safety check in case API returns empty results
    if (response.results.length === 0) {
      break;
    }
  }

  log("info", `[fetchAllDocuments] Complete. Total fetched: ${allDocs.length}`);
  return allDocs;
}

// Sync worker
async function runSyncInBackground(
  jobId: string,
  options: {
    document_ids?: number[];
    force?: boolean;
    chunk_size?: number;
    limit?: number;
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
    
    try {
      if (options.document_ids && options.document_ids.length > 0) {
        paperlessDocs = [];
        for (const docId of options.document_ids) {
          try {
            const doc = await paperless.getDocument(docId);
            paperlessDocs.push(doc);
          } catch (err) {
            log("error", `[rag_sync:${jobId}] Failed to fetch document ${docId}`);
          }
        }
      } else {
        paperlessDocs = await fetchAllDocuments(paperless, (fetched, total) => {
          updateJobProgress(jobId, 0, 100, `Fetching documents from Paperless: ${fetched}/${total}`);
        });
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes("401")) {
        throw new Error(`Paperless API authentication failed (401). Check your PAPERLESS_TOKEN is valid.`);
      }
      throw new Error(`Paperless API error: ${errMsg}`);
    }
    
    log("info", `[rag_sync:${jobId}] Fetched ${paperlessDocs.length} documents from Paperless`);

    if (paperlessDocs.length === 0) {
      log("info", `[rag_sync:${jobId}] No documents to sync`);
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
      log("info", `[rag_sync:${jobId}] Force sync: processing all ${docsToSync.length} documents`);
    } else {
      log("info", `[rag_sync:${jobId}] Checking which documents need sync (delta sync)...`);
      const docsWithModTime = paperlessDocs.map(d => ({
        id: d.id,
        modified: d.modified || d.created || "",
      }));
      const needsSyncIds = await store.getDocumentsNeedingSync(docsWithModTime);
      docsToSync = paperlessDocs.filter(d => needsSyncIds.includes(d.id));
      log("info", `[rag_sync:${jobId}] Delta sync: ${docsToSync.length} documents need sync (${paperlessDocs.length - docsToSync.length} already up-to-date)`);
    }

    if (docsToSync.length === 0) {
      log("info", `[rag_sync:${jobId}] All documents already up-to-date, nothing to sync`);
      completeJob(jobId, {
        status: "completed",
        documents_processed: 0,
        chunks_created: 0,
        documents_skipped: paperlessDocs.length,
        documents_remaining: 0,
        time_seconds: ((Date.now() - startTime) / 1000).toFixed(2),
      });
      return;
    }

    // Apply limit to batch size
    const limit = options.limit || 50;
    const totalNeedingSync = docsToSync.length;
    if (docsToSync.length > limit) {
      docsToSync = docsToSync.slice(0, limit);
      log("info", `[rag_sync:${jobId}] Limiting to ${limit} documents (${totalNeedingSync - limit} remaining for next sync)`);
    }

    const chunks: any[] = [];
    const docChunkCounts: Map<number, number> = new Map();

    log("info", `[rag_sync:${jobId}] Starting to chunk ${docsToSync.length} documents...`);

    for (let i = 0; i < docsToSync.length; i++) {
      const doc = docsToSync[i];

      try {
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
      } catch (err) {
        log("error", `[rag_sync:${jobId}] Error processing doc ${doc.id} (${doc.title}): ${err}`);
        // Continue with next document
      }

      // Log progress every 50 documents
      if ((i + 1) % 50 === 0 || i + 1 === docsToSync.length) {
        log("info", `[rag_sync:${jobId}] Chunking progress: ${i + 1}/${docsToSync.length} docs, ${chunks.length} chunks so far`);
      }

      updateJobProgress(
        jobId,
        Math.round((i + 1) / docsToSync.length * 50),
        100,
        `Processing: ${doc.title || `Doc ${doc.id}`} (${i + 1}/${docsToSync.length})`
      );
    }
    
    log("info", `[rag_sync:${jobId}] Created ${chunks.length} chunks from ${docsToSync.length} documents`);

    if (chunks.length === 0) {
      log("info", `[rag_sync:${jobId}] No chunks created (documents may be empty)`);
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

    log("info", `[rag_sync:${jobId}] Starting embedding generation for ${contents.length} chunks...`);
    try {
      for (let i = 0; i < contents.length; i += 10) {
        const batch = contents.slice(i, i + 10);
        const batchEmbeddings = await embedTexts(batch);

        for (let j = 0; j < batchEmbeddings.length; j++) {
          chunks[i + j].embedding = batchEmbeddings[j];
        }

        if ((i + batch.length) % 100 === 0 || i + batch.length === contents.length) {
          log("info", `[rag_sync:${jobId}] Embeddings: ${Math.min(i + batch.length, contents.length)}/${contents.length}`);
        }

        updateJobProgress(
          jobId,
          50 + Math.round((i + batch.length) / contents.length * 40),
          100,
          `Generating embeddings: ${Math.min(i + batch.length, contents.length)}/${contents.length}`
        );
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes("401")) {
        throw new Error(`OpenAI API authentication failed (401). Check your OPENAI_API_KEY is valid.`);
      }
      throw new Error(`OpenAI API error: ${errMsg}`);
    }

    log("info", `[rag_sync:${jobId}] Storing chunks in vector database...`);
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

    const documentsRemaining = totalNeedingSync - docsToSync.length;
    log("info", `[rag_sync:${jobId}] Sync completed: ${docsToSync.length} docs, ${chunks.length} chunks, ${((Date.now() - startTime) / 1000).toFixed(2)}s. Remaining: ${documentsRemaining}`);
    completeJob(jobId, {
      status: "completed",
      documents_processed: docsToSync.length,
      chunks_created: chunks.length,
      documents_skipped: paperlessDocs.length - totalNeedingSync,
      documents_remaining: documentsRemaining,
      time_seconds: ((Date.now() - startTime) / 1000).toFixed(2),
      message: documentsRemaining > 0 ? `Run rag_sync again to process ${documentsRemaining} more documents` : "All documents synced",
    });
    
  } catch (error) {
    log("error", `[rag_sync:${jobId}] Error: ${error}`);
    failJob(jobId, error instanceof Error ? error.message : String(error));
  }
}

export const ragTools: Tool[] = [
  {
    name: "rag_query",
    description: "Query documents using natural language. Returns relevant document chunks with scores.",
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
    handler: async (args) => {
      const query = args.query as string;
      const limit = (args.limit as number) || 5;
      
      log("info", `[rag_query] Searching for: "${query}" (limit: ${limit})`);
      
      try {
        const store = await getVectorStore();
        
        // Embed the query
        log("info", `[rag_query] Embedding query...`);
        const { embedText } = await import("../embeddings.js");
        const queryEmbedding = await embedText(query);
        log("info", `[rag_query] Query embedded, searching vector store...`);
        
        // Search the vector store
        const results = await store.search(queryEmbedding, limit);
        log("info", `[rag_query] Found ${results.length} results`);
        
        return {
          query,
          results: results.map(r => ({
            chunk_id: r.id,
            document_id: r.documentId,
            content: r.content,
            title: r.metadata?.title || "Unknown",
            source: r.metadata?.source || "",
            page: r.metadata?.page,
            match_percent: r.match_percent,
            score: r.score,
          })),
          storage_mode: getStorageModeLabel(),
          total_results: results.length,
        };
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        log("error", `[rag_query] Error: ${errMsg}`);
        return {
          status: "error",
          error: errMsg,
          query,
          results: [],
          storage_mode: getStorageModeLabel(),
        };
      }
    },
  },
  {
    name: "rag_summarize",
    description: "Summarize a document using AI. Returns a concise summary of the document content.",
    inputSchema: {
      type: "object",
      properties: {
        document_id: { 
          type: "number",
          description: "The document ID from Paperless to summarize",
        },
        max_length: { 
          type: "number", 
          description: "Approximate maximum word count for the summary",
          default: 200,
        },
      },
      required: ["document_id"],
    },
    handler: async (args) => {
      const documentId = args.document_id as number;
      const maxLength = (args.max_length as number) || 200;
      
      log("info", `[rag_summarize] Summarizing document ${documentId} (max: ${maxLength} words)`);
      
      try {
        // Get document content from Paperless
        const paperless = getPaperlessAPI();
        const doc = await paperless.getDocument(documentId);
        
        const content = doc.content || "";
        if (!content.trim()) {
          return {
            status: "error",
            error: `Document ${documentId} has no content to summarize`,
            document_id: documentId,
          };
        }
        
        // Summarize using OpenAI
        const { default: OpenAI } = await import("openai");
        const config = getConfig();
        
        // API key is optional if using a local model without auth
        const openaiOptions: { apiKey?: string; baseURL?: string } = {};
        if (config.openaiApiKey) {
          openaiOptions.apiKey = config.openaiApiKey;
        }
        if (config.openaiApiUrl) {
          openaiOptions.baseURL = config.openaiApiUrl;
        }
        const openai = new OpenAI(openaiOptions);
        
        log("info", `[rag_summarize] Calling OpenAI for document ${documentId}`);
        
        const response = await openai.chat.completions.create({
          model: config.openaiModel,
          messages: [
            {
              role: "system",
              content: `You are a document summarizer. Create a concise summary of the following document in approximately ${maxLength} words. Focus on the key points and main topics. Return only the summary, no introductions or conclusions.`,
            },
            {
              role: "user",
              content: content,
            },
          ],
          max_tokens: Math.round(maxLength * 1.5),
          temperature: 0.3,
        });
        
        const summary = response.choices[0]?.message?.content || "No summary generated";
        
        log("info", `[rag_summarize] Summary generated for document ${documentId}`);
        
        return {
          document_id: documentId,
          title: doc.title || `Document ${documentId}`,
          summary,
          word_count: summary.split(/\s+/).length,
          source: `openai/${config.openaiModel}`,
        };
        
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        log("error", `[rag_summarize] Error: ${errMsg}`);
        return {
          status: "error",
          error: errMsg,
          document_id: documentId,
        };
      }
    },
  },
  {
    name: "rag_sync",
    description: "Start syncing all documents from Paperless to vector store. Runs as background process. Use rag_sync_status to check progress.",
    inputSchema: {
      type: "object",
      properties: {
        force: { type: "boolean", default: false, description: "Re-sync all documents even if already indexed" },
      },
    },
    handler: async (args) => {
      // 1) Check for existing sync lock/state (PID as primary liveness check)
      if (existsSync(PID_FILE)) {
        try {
          const pidString = readFileSync(PID_FILE, "utf-8").trim();
          const pid = parseInt(pidString, 10);

          if (!isNaN(pid) && isProcessAlive(pid)) {
            // 3) Process is alive - sync is genuinely in progress
            const currentStatus = readSyncStatus();
            return {
              status: "already_running",
              message: "Sync is already in progress. Use rag_sync_status to check progress.",
              progress: currentStatus.progress,
              pid: pid,
            };
          } else {
            // 4) Process not alive - treat as stale
            log("info", `[rag_sync] Worker process ${pid} not found. Cleaning up stale state.`);
            if (existsSync(PID_FILE)) unlinkSync(PID_FILE);

            // Optionally reset status file if it says it's running but process is dead
            const currentStatus = readSyncStatus();
            if (currentStatus.status === "running") {
              writeFileSync(STATUS_FILE, JSON.stringify({
                ...currentStatus,
                status: "failed",
                error: "Worker process died unexpectedly",
                completed_at: new Date().toISOString(),
              }, null, 2));
            }
          }
        } catch (err) {
          log("error", `[rag_sync] Error checking worker liveness: ${err}`);
          // If PID file is corrupted, remove it
          if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
        }
      } else {
        // No PID file - check if status file shows "running" (stale state)
        const currentStatus = readSyncStatus();
        if (currentStatus.status === "running") {
          log("info", `[rag_sync] Status shows running but no PID file found. Cleaning up stale state.`);
          writeFileSync(STATUS_FILE, JSON.stringify({
            ...currentStatus,
            status: "failed",
            error: "Worker process died unexpectedly (no PID file)",
            completed_at: new Date().toISOString(),
          }, null, 2));
        }
      }

      // 5) Start new sync
      const force = args.force as boolean || false;
      const started = spawnSyncWorker(force);

      if (started) {
        return {
          status: "started",
          message: "Sync started in background. Use rag_sync_status to check progress.",
        };
      } else {
        return {
          status: "error",
          message: "Failed to start sync worker. Check logs for details.",
        };
      }
    },
  },
  {
    name: "rag_sync_status",
    description: "Check background sync status. Returns progress and results.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    handler: async () => {
      return readSyncStatus();
    },
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
    name: "rag_pending",
    description: "Show documents that need to be indexed or re-indexed.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      try {
        const store = await getVectorStore();
        const paperless = getPaperlessAPI();
        
        log("info", "[rag_pending] Fetching all documents from Paperless...");

        // Fetch all documents from Paperless (with pagination)
        const paperlessDocs = await fetchAllDocuments(paperless);
        
        // Get sync status from vector store
        const syncStatus = await store.getSyncStatus();
        
        // Build map of indexed docs
        const indexedMap = new Map<string, { last_modified: string; indexed_at: string }>();
        for (const doc of syncStatus.documents) {
          indexedMap.set(String(doc.document_id), { last_modified: doc.last_modified, indexed_at: doc.indexed_at });
        }
        
        const never_indexed: Array<{ id: number; title: string; created: string }> = [];
        const out_of_sync: Array<{ id: number; title: string; last_modified: string; indexed_at: string }> = [];
        let indexed_and_current_count = 0;

        // Track which Paperless doc IDs exist
        const paperlessIds = new Set(paperlessDocs.map(d => String(d.id)));

        for (const doc of paperlessDocs) {
          const indexed = indexedMap.get(String(doc.id));

          if (!indexed) {
            // Never indexed
            never_indexed.push({
              id: doc.id,
              title: doc.title || `Document ${doc.id}`,
              created: doc.created || "",
            });
          } else if (doc.modified && indexed.last_modified && doc.modified > indexed.last_modified) {
            // Out of sync - doc was modified after it was indexed
            out_of_sync.push({
              id: doc.id,
              title: doc.title || `Document ${doc.id}`,
              last_modified: doc.modified,
              indexed_at: indexed.indexed_at,
            });
          } else {
            // Indexed and up-to-date
            indexed_and_current_count++;
          }
        }

        // Calculate orphaned index entries (indexed docs that no longer exist in Paperless)
        const orphanedIndexIds = syncStatus.documents
          .filter(d => !paperlessIds.has(String(d.document_id)))
          .map(d => d.document_id);

        log("info", `[rag_pending] Found ${never_indexed.length} never indexed, ${out_of_sync.length} out of sync, ${orphanedIndexIds.length} orphaned in index, ${indexed_and_current_count} indexed and current`);
        log("info", `[rag_pending] Index stats: syncStatus.total_indexed=${syncStatus.total_indexed}, indexedMap.size=${indexedMap.size}`);

        return {
          total_paperless_docs: paperlessDocs.length,
          indexed_and_current: indexed_and_current_count,
          never_indexed_count: never_indexed.length,
          out_of_sync_count: out_of_sync.length,
          pending_count: never_indexed.length + out_of_sync.length,
          orphaned_in_index: orphanedIndexIds.length,
          total_in_index: indexedMap.size,
          never_indexed,
          out_of_sync,
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
  {
    name: "rag_sync_kill",
    description: "Kill the running sync worker process. Use this to stop a background sync that was started with rag_sync.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      return killSyncWorker();
    },
  },
];
