import { PaperlessAPI } from "@baruchiro/paperless-mcp/build/api/PaperlessAPI.js";
import { getConfig } from "../config.js";
import type { Tool } from "./types.js";

/**
 * Paperless tools - delegates to @baruchiro/paperless-mcp
 */

// Create Paperless API client using config
function getPaperlessAPI(): PaperlessAPI {
  const config = getConfig();
  return new PaperlessAPI(config.paperlessUrl, config.paperlessToken);
}

export const paperlessTools: Tool[] = [
  {
    name: "paperless_list_documents",
    description: "List all documents in Paperless-ngx with pagination",
    inputSchema: {
      type: "object",
      properties: {
        page: {
          type: "number",
          description: "Page number",
          default: 1,
        },
        page_size: {
          type: "number",
          description: "Number of documents per page",
          default: 25,
        },
      },
    },
    handler: async (args: Record<string, unknown>) => {
      const api = getPaperlessAPI();
      const page = (args.page as number) || 1;
      const pageSize = (args.page_size as number) || 25;

      try {
        const response = await api.getDocuments();
        
        // Manual pagination since getDocuments doesn't support it directly
        const start = (page - 1) * pageSize;
        const end = start + pageSize;
        const paginatedResults = response.results.slice(start, end);

        return {
          count: response.count,
          page,
          page_size: pageSize,
          total_pages: Math.ceil(response.count / pageSize),
          documents: paginatedResults.map((doc) => ({
            id: doc.id,
            title: doc.title,
            correspondent: doc.correspondent,
            document_type: doc.document_type,
            tags: doc.tags,
            created: doc.created,
            modified: doc.modified,
            added: doc.added,
            archive_serial_number: doc.archive_serial_number,
            original_file_name: doc.original_file_name,
          })),
        };
      } catch (error) {
        throw new Error(
          `Failed to list documents: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    },
  },
  {
    name: "paperless_get_document",
    description: "Get a specific document by ID",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "number",
          description: "The document ID",
        },
      },
      required: ["id"],
    },
    handler: async (args: Record<string, unknown>) => {
      const api = getPaperlessAPI();
      const id = args.id as number;

      if (!id) {
        throw new Error("Document ID is required");
      }

      try {
        const document = await api.getDocument(id);
        return {
          id: document.id,
          title: document.title,
          correspondent: document.correspondent,
          document_type: document.document_type,
          tags: document.tags,
          created: document.created,
          modified: document.modified,
          added: document.added,
          archive_serial_number: document.archive_serial_number,
          original_file_name: document.original_file_name,
          content: document.content,
          custom_fields: document.custom_fields,
          page_count: document.page_count,
          mime_type: document.mime_type,
        };
      } catch (error) {
        throw new Error(
          `Failed to get document ${id}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    },
  },
  {
    name: "paperless_search_documents",
    description: "Search documents using full-text search",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query string",
        },
      },
      required: ["query"],
    },
    handler: async (args: Record<string, unknown>) => {
      const api = getPaperlessAPI();
      const query = args.query as string;

      if (!query) {
        throw new Error("Search query is required");
      }

      try {
        const response = await api.searchDocuments(query);
        return {
          count: response.count,
          query,
          documents: response.results.map((doc) => ({
            id: doc.id,
            title: doc.title,
            correspondent: doc.correspondent,
            document_type: doc.document_type,
            tags: doc.tags,
            created: doc.created,
            __search_hit__: doc.__search_hit__,
          })),
        };
      } catch (error) {
        throw new Error(
          `Failed to search documents: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    },
  },
];
