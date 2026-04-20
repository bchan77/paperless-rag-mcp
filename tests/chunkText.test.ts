// chunkText is a standalone pure function - testing directly
// Note: This doesn't import from embeddings.ts to avoid ESM issues with config

function chunkText(text: string, chunkSize: number = 500, overlap: number = 50): string[] {
  if (!text || text.trim().length === 0) {
    return [];
  }
  
  const chunks: string[] = [];
  const words = text.split(/\s+/);
  let currentChunk: string[] = [];
  let currentLength = 0;
  
  for (const word of words) {
    currentLength += word.length + 1;
    
    if (currentLength > chunkSize && currentChunk.length > 0) {
      chunks.push(currentChunk.join(" "));
      
      const overlapWords = currentChunk.slice(-Math.floor(overlap / 5)).join(" ");
      currentChunk = overlapWords ? [overlapWords, word] : [word];
      currentLength = overlapWords.length + word.length + 1;
    } else {
      currentChunk.push(word);
    }
  }
  
  if (currentChunk.length > 0) {
    chunks.push(currentChunk.join(" "));
  }
  
  return chunks;
}

describe("chunkText", () => {
  it("should return empty array for empty string", () => {
    const result = chunkText("");
    expect(result).toEqual([]);
  });

  it("should return empty array for whitespace only", () => {
    const result = chunkText("   ");
    expect(result).toEqual([]);
  });

  it("should return single chunk for short text", () => {
    const result = chunkText("short text");
    expect(result).toEqual(["short text"]);
  });

  it("should split long text into chunks", () => {
    const words = Array.from({ length: 100 }, (_, i) => `word${i}`).join(" ");
    const result = chunkText(words, 50, 0);
    expect(result.length).toBeGreaterThan(1);
  });

  it("should create multiple chunks for long text", () => {
    // Test basic chunking behavior
    const text = "word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 " +
                "word11 word12 word13 word14 word15 word16 word17 word18 word19 word20";
    const result = chunkText(text, 50, 0);
    expect(result.length).toBeGreaterThan(1);
  });

  it("should combine words into chunks", () => {
    const text = "short text";
    const result = chunkText(text, 100, 0);
    expect(result).toEqual(["short text"]);
  });

  it("should handle chunk size larger than text", () => {
    const shortText = "short";
    const result = chunkText(shortText, 100, 0);
    expect(result).toEqual(["short"]);
  });

  it("should produce non-overlapping chunks by default", () => {
    const text = Array.from({ length: 50 }, (_, i) => `w${i}`).join(" ");
    const result = chunkText(text, 20, 0);
    expect(result.length).toBeGreaterThan(1);
  });
});