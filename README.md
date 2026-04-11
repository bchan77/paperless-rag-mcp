# paperless-rag-mcp

An MCP server that combines [paperless-mcp](https://github.com/baruchiro/paperless-mcp) with a RAG (Retrieval Augmented Generation) pipeline for intelligent Q&A over your Paperless-ngx documents.

## ⚠️ Status

**Core functionality is working.** This project is actively developed and tested.

### ✅ Working Features

| Feature | Description |
|---------|-------------|
| Paperless integration | List, get, search documents from Paperless-ngx |
| Document sync | Sync documents to vector store (LanceDB or Qdrant) |
| Delta sync | Only syncs new/modified documents |
| Background jobs | Sync runs in background, survives MCP restarts |
| Vector search | Query documents using natural language |
| Summarization | Summarize documents using LLM (OpenAI, OpenRouter, local) |
| Kill switch | `rag_sync_kill` to stop running sync |

### 🔄 MCP Integration (WIP)

The MCP server is implemented and runs, but **MCP client integration testing is ongoing**.
The server works with MCP Inspector for manual testing.

## Overview

This project extends the [paperless-mcp](https://github.com/baruchiro/paperless-mcp) server with RAG capabilities:

- **Query documents** using natural language
- **Summarize** long documents
- **Get accurate answers** powered by vector similarity search

## Architecture

```
MCP-Compatible AI Assistant → paperless-rag-mcp → Paperless-ngx
                                         ↓
                                  Vector DB (LanceDB or Qdrant)
                                         ↓
                                 OpenAI / OpenRouter / Local LLM
                                         ↓
                                 Document Embeddings
```

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
git clone https://gitea.homelab.local/AI/paperless-rag-mcp.git
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
│   ├── index.ts           # Main MCP server
│   ├── config.ts          # Configuration
│   ├── embeddings.ts       # Text embedding
│   ├── vector-store.ts    # LanceDB/Qdrant abstraction
│   ├── sync-worker.ts     # Background sync worker
│   ├── jobs.ts            # Job management
│   ├── logger.ts          # Logging
│   └── tools/
│       ├── types.ts       # Shared types
│       ├── paperless.ts   # Paperless document tools
│       └── rag.ts         # RAG tools
├── .env.example
├── package.json
├── tsconfig.json
└── README.md
```

### Available Tools

**Paperless Tools:**
- `paperless_list_documents` - List all documents
- `paperless_get_document` - Get a specific document

**RAG Tools:**
- `rag_query` - Query documents using natural language
- `rag_summarize` - Summarize a document
- `rag_sync` - Sync documents from Paperless to vector store (background)
- `rag_sync_status` - Check sync progress
- `rag_sync_kill` - Stop running sync
- `rag_stats` - Get vector store statistics

## Testing

### Using MCP Inspector

You can use the [MCP Inspector](https://github.com/modelcontextprotocol/inspector) to test this server or other MCP servers.

**Test this server:**

```bash
npx @modelcontextprotocol/inspector npm run dev --silent
```

## License

MIT
