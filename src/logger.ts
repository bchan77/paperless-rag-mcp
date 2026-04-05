import { appendFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

const LOG_DIR = "./logs";
const LOG_FILE = join(LOG_DIR, "rag-sync.log");

// Ensure logs directory exists
if (!existsSync(LOG_DIR)) {
  mkdirSync(LOG_DIR, { recursive: true });
}

export function log(level: "info" | "error" | "debug", message: string) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [${level.toUpperCase()}] ${message}\n`;
  appendFileSync(LOG_FILE, line);
}
