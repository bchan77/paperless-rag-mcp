import type { Tool } from "./types.js";

/**
 * Paperless tools - delegates to @baruchiro/paperless-mcp
 * These are placeholder implementations for now.
 * Will be replaced with actual paperless-mcp integration.
 */

export const paperlessTools: Tool[] = [
  {
    name: "paperless_list_documents",
    description: "List all documents in Paperless-ngx",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Maximum number of documents to return",
          default: 100,
        },
        offset: {
          type: "number",
          description: "Offset for pagination",
          default: 0,
        },
      },
    },
    handler: async (args: Record<string, unknown>) => {
      // TODO: Integrate with @baruchiro/paperless-mcp
      return {
        message: "paperless_list_documents not yet implemented",
        documents: [],
        paperless_url: process.env.PAPERLESS_URL || "http://paperless.homelab.local",
      };
    },
  },
  {
    name: "paperless_get_document",
    description: "Get a specific document by ID",
    inputSchema: {
      type: "object",
      properties: {
        document_id: {
          type: "number",
          description: "The document ID",
        },
      },
      required: ["document_id"],
    },
    handler: async (args: Record<string, unknown>) => {
      // TODO: Integrate with @baruchiro/paperless-mcp
      return {
        message: "paperless_get_document not yet implemented",
        document_id: args.document_id,
      };
    },
  },
];
