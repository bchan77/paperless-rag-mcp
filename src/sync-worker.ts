#!/usr/bin/env node
/**
 * Standalone sync worker - runs independently of MCP server
 * Processes documents in batches to avoid memory issues
 */

import { getVectorStore } from "./vector-store.js";
import { PaperlessAPI } from "@baruchiro/paperless-mcp/build/api/PaperlessAPI.js";
import { initConfig, getConfig } from "./config.js";
import { embedTexts, chunkText } from "./embeddings.js";
import { writeFileSync, appendFileSync, mkdirSync, existsSync, unlinkSync } from "fs";
import { join } from "path";

const STATUS_DIR = "./data";
const STATUS_FILE = join(STATUS_DIR, "sync-status.json");
const PID_FILE = join(STATUS_DIR, "sync-worker.pid");
const LOG_FILE = "./logs/sync-worker.log";
const BATCH_SIZE = 50; // Process 50 documents at a time to avoid OOM

// Track parent process to detect if MCP server dies
const parentPid = process.ppid;

function isParentAlive(): boolean {
  try {
    process.kill(parentPid, 0);
    return true;
  } catch {
    return false;
  }
}

// Check parent every 10 seconds, exit if parent died
const parentCheckInterval = setInterval(() => {
  if (!isParentAlive()) {
    log("Parent process (MCP server) died, shutting down");
    writeStatus({
      status: "failed",
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      progress: { phase: "Orphaned", current: 0, total: 0 },
      error: "MCP server process died, worker shutting down",
    });
    cleanupPid();
    process.exit(0);
  }
}, 10000);

// Crash handlers
function logCrash(message: string) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [CRASH] ${message}\n`;
  try {
    if (!existsSync("./logs")) {
      mkdirSync("./logs", { recursive: true });
    }
    appendFileSync(LOG_FILE, line);
  } catch {
    // Can't log
  }
}

process.on("uncaughtException", (err) => {
  logCrash(`Uncaught exception: ${err.message}\n${err.stack}`);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  logCrash(`Unhandled rejection: ${reason}`);
});

// Graceful shutdown on SIGTERM (sent by rag_sync_kill)
process.on("SIGTERM", () => {
  log("Received SIGTERM, shutting down gracefully...");
  clearInterval(parentCheckInterval);
  writeStatus({
    status: "failed",
    started_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    progress: { phase: "Killed by user", current: 0, total: 0 },
    error: "Sync was stopped by user (rag_sync_kill)",
  });
  cleanupPid();
  process.exit(0);
});

interface SyncStatus {
  status: "running" | "completed" | "failed";
  started_at: string;
  completed_at?: string;
  progress: {
    phase: string;
    current: number;
    total: number;
  };
  result?: {
    documents_processed: number;
    chunks_created: number;
    documents_skipped: number;
    time_seconds: string;
  };
  error?: string;
}

function writeStatus(status: SyncStatus) {
  if (!existsSync(STATUS_DIR)) {
    mkdirSync(STATUS_DIR, { recursive: true });
  }
  writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2));
}

function log(message: string) {
  const timestamp = new Date().toISOString();
  const mem = process.memoryUsage();
  const heapMB = Math.round(mem.heapUsed / 1024 / 1024);
  const line = `[${timestamp}] [${heapMB}MB] [sync-worker] ${message}\n`;
  try {
    if (!existsSync("./logs")) {
      mkdirSync("./logs", { recursive: true });
    }
    appendFileSync(LOG_FILE, line);
  } catch {
    // Ignore logging errors
  }
}

async function fetchAllDocuments(paperless: PaperlessAPI): Promise<any[]> {
  const allDocs: any[] = [];
  const pageSize = 100;
  let page = 1;

  const firstResponse = await paperless.getDocuments(`?page=1&page_size=${pageSize}`);
  const totalCount = firstResponse.count;
  allDocs.push(...firstResponse.results);
  log(`Fetched page 1: ${allDocs.length}/${totalCount}`);

  while (allDocs.length < totalCount) {
    page++;
    const response = await paperless.getDocuments(`?page=${page}&page_size=${pageSize}`);
    allDocs.push(...response.results);
    log(`Fetched page ${page}: ${allDocs.length}/${totalCount}`);
    if (response.results.length === 0) break;
  }

  return allDocs;
}

// Process a single batch of documents - chunk, embed, store, then release memory
async function processBatch(
  docs: any[],
  store: any,
  config: any,
  chunkSize: number
): Promise<{ chunksCreated: number }> {
  // Create chunks for this batch only
  const chunks: any[] = [];
  const docChunkCounts: Map<number, number> = new Map();

  for (const doc of docs) {
    const content = doc.content || "";
    if (!content.trim()) continue;

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
  }

  if (chunks.length === 0) {
    return { chunksCreated: 0 };
  }

  log(`Batch: ${docs.length} docs -> ${chunks.length} chunks, generating embeddings...`);

  // Generate embeddings in small sub-batches
  const contents = chunks.map(c => c.content);
  for (let i = 0; i < contents.length; i += 10) {
    const batch = contents.slice(i, i + 10);
    const batchEmbeddings = await embedTexts(batch);
    for (let j = 0; j < batchEmbeddings.length; j++) {
      chunks[i + j].embedding = batchEmbeddings[j];
    }
  }

  // Delete old data for these documents
  for (const doc of docs) {
    await store.deleteDocument(doc.id);
  }

  // Store chunks
  await store.addDocuments(chunks);

  // Mark as indexed
  for (const doc of docs) {
    const chunkCount = docChunkCounts.get(doc.id) || 0;
    await store.markDocumentsIndexed(
      doc.id,
      doc.modified || doc.created || new Date().toISOString(),
      chunkCount
    );
  }

  return { chunksCreated: chunks.length };
}

function cleanupPid() {
  try {
    if (existsSync(PID_FILE)) {
      unlinkSync(PID_FILE);
      log("Removed PID file");
    }
  } catch (err) {
    log(`Failed to remove PID file: ${err}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const chunkSize = 500;
  const startTime = Date.now();

  let totalDocsProcessed = 0;
  let totalChunksCreated = 0;
  let totalSkipped = 0;

  try {
    initConfig();
    const config = getConfig();

    writeStatus({
      status: "running",
      started_at: new Date().toISOString(),
      progress: { phase: "Initializing", current: 0, total: 100 },
    });

    log("Fetching documents from Paperless...");
    const paperless = new PaperlessAPI(config.paperlessUrl, config.paperlessToken);
    const paperlessDocs = await fetchAllDocuments(paperless);
    log(`Fetched ${paperlessDocs.length} documents total`);

    const store = await getVectorStore();

    // Determine which docs need sync
    let docsToSync: typeof paperlessDocs;
    if (force) {
      docsToSync = paperlessDocs;
      log(`Force mode: will sync all ${docsToSync.length} documents`);
    } else {
      const docsWithModTime = paperlessDocs.map(d => ({
        id: d.id,
        modified: d.modified || d.created || "",
      }));
      const needsSyncIds = await store.getDocumentsNeedingSync(docsWithModTime);
      docsToSync = paperlessDocs.filter(d => needsSyncIds.includes(d.id));
      totalSkipped = paperlessDocs.length - docsToSync.length;
      log(`Delta sync: ${docsToSync.length} need sync, ${totalSkipped} already up-to-date`);
    }

    if (docsToSync.length === 0) {
      log("Nothing to sync");
      writeStatus({
        status: "completed",
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        progress: { phase: "Done", current: 100, total: 100 },
        result: {
          documents_processed: 0,
          chunks_created: 0,
          documents_skipped: totalSkipped,
          time_seconds: ((Date.now() - startTime) / 1000).toFixed(2),
        },
      });
      clearInterval(parentCheckInterval);
      cleanupPid();
      return;
    }

    // Process in batches to avoid memory issues
    const totalBatches = Math.ceil(docsToSync.length / BATCH_SIZE);
    log(`Processing ${docsToSync.length} documents in ${totalBatches} batches of ${BATCH_SIZE}`);

    for (let batchNum = 0; batchNum < totalBatches; batchNum++) {
      const start = batchNum * BATCH_SIZE;
      const end = Math.min(start + BATCH_SIZE, docsToSync.length);
      const batchDocs = docsToSync.slice(start, end);

      log(`Batch ${batchNum + 1}/${totalBatches}: docs ${start + 1}-${end}`);

      writeStatus({
        status: "running",
        started_at: new Date().toISOString(),
        progress: {
          phase: `Batch ${batchNum + 1}/${totalBatches}`,
          current: start,
          total: docsToSync.length,
        },
      });

      const result = await processBatch(batchDocs, store, config, chunkSize);
      totalDocsProcessed += batchDocs.length;
      totalChunksCreated += result.chunksCreated;

      log(`Batch ${batchNum + 1} done: +${result.chunksCreated} chunks (total: ${totalChunksCreated})`);

      // Force garbage collection hint (won't always work but helps)
      if (global.gc) {
        global.gc();
      }
    }

    const timeSeconds = ((Date.now() - startTime) / 1000).toFixed(2);
    log(`COMPLETED: ${totalDocsProcessed} docs, ${totalChunksCreated} chunks in ${timeSeconds}s`);

    writeStatus({
      status: "completed",
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      progress: { phase: "Done", current: docsToSync.length, total: docsToSync.length },
      result: {
        documents_processed: totalDocsProcessed,
        chunks_created: totalChunksCreated,
        documents_skipped: totalSkipped,
        time_seconds: timeSeconds,
      },
    });
    clearInterval(parentCheckInterval);
    cleanupPid();

  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    log(`ERROR: ${errMsg}`);
    writeStatus({
      status: "failed",
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      progress: { phase: "Failed", current: totalDocsProcessed, total: 0 },
      error: errMsg,
      result: {
        documents_processed: totalDocsProcessed,
        chunks_created: totalChunksCreated,
        documents_skipped: totalSkipped,
        time_seconds: ((Date.now() - startTime) / 1000).toFixed(2),
      },
    });
    clearInterval(parentCheckInterval);
    cleanupPid();
    process.exit(1);
  }
}

main();
