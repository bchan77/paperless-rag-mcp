# paperless-rag-mcp

An MCP server that combines [paperless-mcp](https://github.com/baruchiro/paperless-mcp) with a RAG (Retrieval Augmented Generation) pipeline for intelligent Q&A over your Paperless-ngx documents.

## ⚠️ Status

**Status:** This project is under active development and testing. Core functionality is operational on macOS.

> [!IMPORTANT]
> This project has been developed and tested on **macOS**. Compatibility with other platforms (Linux, Windows) has not been verified yet.

### ✅ Working Features

| Feature | Description |
|---------|-------------|
| Paperless integration | List, get, search documents from Paperless-ngx |
| Document sync | Sync documents to vector store (LanceDB or Qdrant) |
| Delta sync | Only syncs new/modified documents |
| Background jobs | Sync runs in background, survives MCP restarts |
| Pagination | Handles large document sets (all docs fetched) |
| Vector search | Query documents using natural language |
| Summarization | Summarize documents using LLM (OpenAI, OpenRouter, local) |
| Kill switch | `rag_sync_kill` to stop running sync |
| Sync monitoring | Track index state: pending, out-of-sync, orphaned |

## Overview

This project extends the [paperless-mcp](https://github.com/baruchiro/paperless-mcp) server with RAG capabilities:

- **Query documents** using natural language
- **Summarize** long documents
- **Get accurate answers** powered by vector similarity search

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    MCP-Compatible AI Assistant                   │
│                   (Claude Desktop, OpenClaw, etc.)              │
└─────────────────────────────────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                      paperless-rag-mcp                          │
│                                                                │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────┐  │
│  │ paperless.ts │    │   rag.ts     │    │    jobs.ts       │  │
│  │             │    │             │    │                  │  │
│  │ List, get,  │    │ Query,      │    │ createSyncJob    │  │
│  │ search docs │    │ summarize,  │    │ updateProgress  │  │
│  │ from       │    │ sync, sync   │    │ getJob, listJobs│  │
│  │ Paperless  │    │ status      │    │                  │  │
│  └──────────────┘    └──────────────┘    └──────────────────┘  │
│         │                   │                    │               │
│         └───────────────────┼────────────────────┘               │
│                             ▼                                    │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                      vector-store.ts                        ││
│  │                                                             ││
│  │  LanceDB (default) ◄──────────────► Qdrant (optional)      ││
│  │  Local file storage                  Remote vector DB       ││
│  │  No setup needed                     Better for production ││
│  └─────────────────────────────────────────────────────────────┘│
│                             │                                    │
│                             ▼                                    │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                      embeddings.ts                          ││
│  │                                                             ││
│  │  OpenAI (text-embedding-3-small) ◄── or ──► Ollama (local)  ││
│  │  1536 dimensions                    nomic-embed-text         ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                      External Services                           │
│                                                                │
│  ┌─────────────────┐    ┌─────────────────┐    ┌────────────┐ │
│  │  Paperless-ngx  │    │ OpenAI / Local  │    │  LLM for   │ │
│  │  Document API   │    │ Embeddings API  │    │ summarizer │ │
│  └─────────────────┘    └─────────────────┘    └────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

## How Document Sync Works

The sync process is designed to be **resilient** and **interruptible**:

```
1. rag_sync called
   └── Creates job in jobs.ts
   └── Spawns sync-worker.ts as background process
   └── Returns immediately with job_id

2. sync-worker.ts runs independently:
   └── Fetches ALL documents from Paperless (with pagination)
   └── For each document:
       ├── Download document content
       ├── Chunk text (configurable size/overlap)
       ├── Generate embeddings (OpenAI or Ollama)
       └── Store in LanceDB or Qdrant

3. MCP server can restart during sync:
   └── sync-worker detects if parent died
   └── Parent check every 10 seconds
   └── Worker exits if MCP server dies

4. Track sync state:
   └── vector-store.ts maintains sync metadata
   └── rag_pending shows: never indexed, out-of-sync, orphaned
```

### Sync Worker Process

The sync worker (`sync-worker.ts`) is a **standalone process** that:

- Runs in the background separate from the MCP server
- Processes documents in **batches of 50** to avoid memory issues
- Logs to `./logs/sync-worker.log`
- Writes status to `./data/sync-status.json`
- Stores PID in `./data/sync-worker.pid`
- Detects if parent MCP server died and exits gracefully

### Delta Sync (Efficient Updates)

The sync is **incremental**:

1. `rag_pending` compares:
   - Documents in Paperless
   - Documents in vector store with their `last_modified` timestamps

2. Only documents that are:
   - **Never indexed** (new)
   - **Out of sync** (modified since last index)
   - **Orphaned** (deleted from Paperless but still in index)

3. No re-indexing of unchanged documents

## Tech Stack

- **MCP Server**: TypeScript/Node.js
- **Document Processing**: Chunking and embedding
- **Vector Database**: LanceDB (default) or Qdrant (when QDRANT_URL is set)
- **LLM/Embeddings**: OpenAI, OpenRouter, or local models (Ollama)

## Features

- 🔍 Natural language document search (vector similarity)
- 📄 Document summarization
- 💬 Q&A over document content
- 🔄 Sync documents to vector store (background, interruptible)
- 📊 Track sync state (pending, out-of-sync, orphaned)
- 📦 Uses `@baruchiro/paperless-mcp` as npm dependency
- 🤖 Works with MCP-compatible AI assistants (Claude, OpenClaw, Cursor, etc.)
- 🔀 Supports multiple LLM providers (OpenAI, OpenRouter, local)

## Development

### Prerequisites

- Node.js 20+
- npm or pnpm

### Setup

```bash
# Clone the repo
git clone https://github.com/bchan77/paperless-rag-mcp.git
cd paperless-rag-mcp

# Install dependencies
npm install

# Copy .env.example to .env and fill in your values
cp .env.example .env
# Edit .env with your Paperless URL and API token

# Run in development mode (loads .env automatically)
npm run dev
```

### Environment Variables

**Required:**

| Variable | Description |
|----------|-------------|
| `PAPERLESS_URL` | Your Paperless-ngx instance URL (e.g., `http://paperless.local:8000`) |
| `PAPERLESS_TOKEN` | Paperless API token (generate in Settings > API Tokens) |

**Optional:**

| Variable | Description | Default |
|----------|-------------|---------|
| `QDRANT_URL` | Qdrant URL (if using instead of LanceDB) | Not set (uses LanceDB) |
| `LANCEDB_PATH` | Path for LanceDB storage | `./data/lancedb` |
| `OPENAI_API_KEY` | API key for OpenAI/OpenRouter | Not set |
| `OPENAI_API_URL` | Custom API URL (for OpenRouter, proxies) | Not set |
| `OPENAI_MODEL` | Model for summarization | `gpt-4o-mini` |
| `EMBEDDING_PROVIDER` | Embedding backend: `openai` or `ollama` | `openai` |
| `OLLAMA_URL` | Ollama server URL | `http://localhost:11434` |
| `OLLAMA_EMBED_MODEL` | Ollama embedding model | `nomic-embed-text` |

### Embedding Providers

**OpenAI** (default): Requires `OPENAI_API_KEY`. Uses `text-embedding-3-small` (1536 dimensions).

**OpenRouter**: Set `OPENAI_API_URL=https://openrouter.ai/api/v1` and use any model:
```bash
OPENAI_API_KEY=sk-or-v1-xxx
OPENAI_API_URL=https://openrouter.ai/api/v1
OPENAI_MODEL=anthropic/claude-3.5-sonnet
```

**Ollama** (local, free): Set `EMBEDDING_PROVIDER=ollama`. Pull a model first:
```bash
ollama pull nomic-embed-text
```

> **WSL users:** If Ollama is running on Windows, set `OLLAMA_URL` to your Windows host IP instead of `localhost`. Find it with `cat /etc/resolv.conf | grep nameserver`. You also need to allow network access by setting `OLLAMA_HOST=0.0.0.0` in Windows environment variables and restarting Ollama.

> **WSL users:** LanceDB's Rust layer does not handle `/mnt/c/` paths correctly on WSL. Set `LANCEDB_PATH` to a Linux-native path (e.g., `/home/<user>/.local/share/paperless-rag-mcp/lancedb`) to avoid errors.

### Project Structure

```
paperless-rag-mcp/
├── src/
│   ├── index.ts           # Main MCP server entry point
│   ├── config.ts          # Environment variable loading and validation
│   ├── embeddings.ts      # OpenAI/Ollama embedding generation
│   ├── vector-store.ts    # LanceDB/Qdrant abstraction layer
│   ├── sync-worker.ts     # Standalone background sync process
│   ├── jobs.ts            # In-memory job management
│   ├── logger.ts          # File-based logging
│   └── tools/
│       ├── types.ts       # Shared TypeScript interfaces
│       ├── paperless.ts   # Paperless document tools
│       └── rag.ts         # RAG query/summarize/sync tools
├── tests/
│   ├── chunkText.test.ts  # Text chunking tests
│   ├── config.test.ts     # Config loading tests
│   └── jobs.test.ts       # Job management tests
├── data/                  # Runtime data (gitignored)
│   ├── lancedb/          # LanceDB storage
│   ├── sync-status.json  # Current sync state
│   └── sync-worker.pid   # Background worker PID
├── logs/                  # Log files (gitignored)
│   └── sync-worker.log   # Sync worker logs
├── .env.example
├── package.json
├── tsconfig.json
├── jest.config.js
└── README.md
```

### Available Tools

**Paperless Tools:**
- `paperless_list_documents` - List all documents with pagination
- `paperless_get_document` - Get a specific document by ID
- `paperless_search_documents` - Full-text search

**RAG Tools:**
- `rag_query` - Query documents using natural language
- `rag_summarize` - Summarize a document
- `rag_sync` - Sync documents from Paperless to vector store (background)
- `rag_sync_status` - Check background sync job progress
- `rag_sync_status_all` - List all indexed documents with sync timestamps
- `rag_sync_kill` - Stop running sync
- `rag_stats` - Get vector store statistics
- `rag_pending` - Show unindexed and out-of-sync documents
- `rag_debug` - Inspect vector store contents (dev use)

## Monitoring & Troubleshooting

### Check what's pending sync

Use `rag_pending` to see documents that need attention:

```javascript
await rag_pending();

// Returns:
{
  total_paperless_docs: 100,
  indexed_and_current: 70,       // Indexed and up-to-date
  never_indexed_count: 20,        // Never been indexed
  out_of_sync_count: 5,           // Modified since last index
  orphaned_in_index: 3,          // In index but deleted from Paperless
  pending_count: 25,              // Total needing action
  never_indexed: [...],           // List with id, title, created
  out_of_sync: [...],             // List with id, title, last_modified, indexed_at
}
```

### Monitor background sync job

Use `rag_sync_status` to check if a sync is running:

```javascript
await rag_sync_status();
// Returns: { status, progress, result, error, job_id, ... }
```

### See all indexed documents

Use `rag_sync_status_all` to list what's in the vector store:

```javascript
await rag_sync_status_all();
// Returns: { indexed_documents: [{ document_id, last_modified, indexed_at }] }
```

### Check logs

```bash
# View sync worker logs
tail -f logs/sync-worker.log

# Check sync status file
cat data/sync-status.json
```

### Running Tests

```bash
npm test           # run all tests
npm run test:watch # run tests in watch mode
```

## Testing

### Using MCP Inspector

You can use the [MCP Inspector](https://github.com/modelcontextprotocol/inspector) to test this server or other MCP servers.

**Test this server:**

```bash
npx @modelcontextprotocol/inspector npm run dev --silent
```

## License

MIT