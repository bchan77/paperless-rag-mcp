/**
 * Debug script to inspect LanceDB contents
 */

import { connect } from "@lancedb/lancedb";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Default LanceDB path
const dbPath = process.env.LANCEDB_PATH || "./data/lancedb";

async function debug() {
  console.log(`Connecting to LanceDB at: ${dbPath}`);
  
  const db = await connect(dbPath);
  const tableNames = await db.tableNames();
  
  console.log(`\nTables: ${JSON.stringify(tableNames)}`);
  
  if (!tableNames.includes("documents")) {
    console.log("\nNo 'documents' table found!");
    return;
  }
  
  const table = await db.openTable("documents");
  const count = await table.countRows();
  
  console.log(`\nTotal rows: ${count}`);
  
  if (count > 0) {
    // Get first few rows
    const result = await table.query().limit(5).toArray();
    
    console.log("\nSample documents:");
    result.forEach((row, i) => {
      console.log(`\n--- Document ${i + 1} ---`);
      console.log(`  document_id: ${row.document_id}`);
      console.log(`  chunk_id: ${row.chunk_id}`);
      console.log(`  title: ${row.title}`);
      console.log(`  content: ${row.content?.substring(0, 100)}...`);
      console.log(`  source: ${row.source}`);
    });
  }
}

debug().catch(console.error);
