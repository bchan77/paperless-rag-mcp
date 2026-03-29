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

# Run in development mode
npm run dev
```

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PAPERLESS_URL` | Paperless-ngx URL | `http://paperless.homelab.local` |
| `PAPERLESS_TOKEN` | Paperless API token | Required |
| `QDRANT_URL` | Qdrant URL (if using instead of LanceDB) | Not set (uses LanceDB) |
| `OPENAI_API_KEY` | OpenAI API key for embeddings | Required for embeddings |

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

## License

MIT
