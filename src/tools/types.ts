export interface Tool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

export interface DocumentChunk {
  id: string;
  content: string;
  metadata: {
    document_id: number;
    source: string;
    page?: number;
    [key: string]: unknown;
  };
}
