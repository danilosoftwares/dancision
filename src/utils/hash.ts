import { createHash } from "node:crypto";

export function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function embeddingCacheKey(modelId: string, content: string): string {
  return `${modelId}:${hashContent(content)}`;
}
