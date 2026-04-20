// Mock environment variables
const originalEnv = process.env;

beforeEach(() => {
  jest.resetModules();
  process.env = { ...originalEnv };
});

afterAll(() => {
  process.env = originalEnv;
});

describe("config validation", () => {
  it("should throw error when PAPERLESS_URL is missing", () => {
    process.env.PAPERLESS_TOKEN = "test-token";
    delete process.env.PAPERLESS_URL;
    
    const { loadConfig } = require("../src/config");
    expect(() => loadConfig()).toThrow("PAPERLESS_URL");
  });

  it("should throw error when PAPERLESS_TOKEN is missing", () => {
    process.env.PAPERLESS_URL = "http://paperless.local";
    delete process.env.PAPERLESS_TOKEN;
    
    const { loadConfig } = require("../src/config");
    expect(() => loadConfig()).toThrow("PAPERLESS_TOKEN");
  });

  it("should load config with required variables", () => {
    process.env.PAPERLESS_URL = "http://paperless.local";
    process.env.PAPERLESS_TOKEN = "test-token";
    
    const { loadConfig } = require("../src/config");
    const config = loadConfig();
    
    expect(config.paperlessUrl).toBe("http://paperless.local");
    expect(config.paperlessToken).toBe("test-token");
  });

  it("should use default values for optional variables", () => {
    process.env.PAPERLESS_URL = "http://paperless.local";
    process.env.PAPERLESS_TOKEN = "test-token";
    
    const { loadConfig } = require("../src/config");
    const config = loadConfig();
    
    expect(config.qdrantCollection).toBe("paperless_documents");
    expect(config.lancedbPath).toBe("./data/lancedb");
  });

  it("should read QDRANT_URL from environment", () => {
    process.env.PAPERLESS_URL = "http://paperless.local";
    process.env.PAPERLESS_TOKEN = "test-token";
    process.env.QDRANT_URL = "http://qdrant.local:6333";
    
    const { loadConfig } = require("../src/config");
    const config = loadConfig();
    
    expect(config.qdrantUrl).toBe("http://qdrant.local:6333");
  });

  it("should read OPENAI_MODEL from environment", () => {
    process.env.PAPERLESS_URL = "http://paperless.local";
    process.env.PAPERLESS_TOKEN = "test-token";
    process.env.OPENAI_MODEL = "gpt-4o";
    
    const { loadConfig } = require("../src/config");
    const config = loadConfig();
    
    expect(config.openaiModel).toBe("gpt-4o");
  });
});

describe("getStorageMode", () => {
  it("should return 'lancedb' when QDRANT_URL is not set", () => {
    process.env.PAPERLESS_URL = "http://paperless.local";
    process.env.PAPERLESS_TOKEN = "test-token";
    delete process.env.QDRANT_URL;
    
    const { loadConfig, getStorageMode } = require("../src/config");
    const config = loadConfig();
    
    expect(getStorageMode(config)).toBe("lancedb");
  });

  it("should return 'qdrant' when QDRANT_URL is set", () => {
    process.env.PAPERLESS_URL = "http://paperless.local";
    process.env.PAPERLESS_TOKEN = "test-token";
    process.env.QDRANT_URL = "http://qdrant.local:6333";
    
    const { loadConfig, getStorageMode } = require("../src/config");
    const config = loadConfig();
    
    expect(getStorageMode(config)).toBe("qdrant");
  });
});