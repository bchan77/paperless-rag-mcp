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
                                  Vector DB (Qdrant)
                                         ↓
                                 Unstructured SDK
                                         ↓
                                 Document Processing
```

## Tech Stack

- **MCP Server**: TypeScript/Node.js
- **Document Processing**: [Unstructured](https://github.com/Unstructured-IO/unstructured)
- **Vector Database**: Qdrant (self-hosted or cloud)
- **Embeddings**: OpenAI `text-embedding-3-small` or local alternatives

## Features

- 🔍 Natural language document search
- 📄 Document summarization
- 💬 Q&A over document content
- 🔄 Sync documents to vector store
- 📦 Uses `@baruchiro/paperless-mcp` as npm dependency
- 🤖 Works with MCP-compatible AI assistants (Claude, OpenClaw, Cursor, Continue.dev, etc.)

## Getting Started

_TBD_

## Why

This project was created for interview prep at **Unstructured**, the company behind the popular open-source document processing pipeline.

## License

MIT
