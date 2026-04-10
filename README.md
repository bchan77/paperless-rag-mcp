# paperless-rag-mcp

An MCP server that combines [paperless-mcp](https://github.com/baruchiro/paperless-mcp) with a RAG (Retrieval Augmented Generation) pipeline for intelligent Q&A over your Paperless-ngx documents.

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
                                 Unstructured SDK
                                         ↓
                                 Document Processing
```

## Tech Stack

- **MCP Server**: TypeScript/Node.js
- **Document Processing**: [Unstructured](https://github.com/Unstructured-IO/unstructured)
- **Vector Database**: LanceDB (default) or Qdrant (when QDRANT_URL is set)
- **Embeddings**: OpenAI `text-embedding-3-small` or local alternatives

## Features

- 🔍 Natural language document search
- 📄 Document summarization
- 💬 Q&A over document content
- 🔄 Sync documents to vector store
- 📦 Uses `@baruchiro/paperless-mcp` as npm dependency
- 🤖 Works with MCP-compatible AI assistants (Claude, OpenClaw, Cursor, Continue.dev, etc.)

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
| `OPENAI_API_KEY` | OpenAI API key for embeddings (required when `EMBEDDING_PROVIDER=openai`) | Not set |
| `EMBEDDING_PROVIDER` | Embedding backend: `openai` or `ollama` | `openai` |
| `OLLAMA_URL` | Ollama server URL | `http://localhost:11434` |
| `OLLAMA_EMBED_MODEL` | Ollama embedding model to use | `nomic-embed-text` |
| `OLLAMA_MAX_CHARS` | Max characters per chunk sent to Ollama. Tune based on your model's context window: `num_ctx × 2` is a safe estimate (e.g., `nomic-embed-text` has `num_ctx=8192` → `16000`). Check your model's `num_ctx` with `ollama show <model>`. | `1000` |

### Embedding Providers

**OpenAI** (default): Requires `OPENAI_API_KEY`. Uses `text-embedding-3-small` (1536 dimensions).

**Ollama** (local, free): Set `EMBEDDING_PROVIDER=ollama`. Pull a model first:
```bash
ollama pull nomic-embed-text
```
Then check its context window to set `OLLAMA_MAX_CHARS`:
```bash
ollama show nomic-embed-text | grep num_ctx
# num_ctx = 8192 → set OLLAMA_MAX_CHARS=16000
```

> **WSL users:** If Ollama is running on Windows, set `OLLAMA_URL` to your Windows host IP instead of `localhost`. Find it with `cat /etc/resolv.conf | grep nameserver`. You also need to allow network access by setting `OLLAMA_HOST=0.0.0.0` in Windows environment variables and restarting Ollama.

> **WSL users:** LanceDB's Rust layer does not handle `/mnt/c/` paths correctly on WSL. Set `LANCEDB_PATH` to a Linux-native path (e.g., `/home/<user>/.local/share/paperless-rag-mcp/lancedb`) to avoid errors.

### Project Structure

```
paperless-rag-mcp/
├── src/
│   ├── index.ts           # Main MCP server
│   └── tools/
│       ├── types.ts       # Shared types
│       ├── paperless.ts   # Paperless document tools
│       └── rag.ts         # RAG query/summarize/sync tools
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
- `rag_sync` - Sync documents from Paperless to vector store
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
