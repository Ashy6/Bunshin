import { describe, expect, it } from "vitest";
import { formatMicros, normalizeSeoKeywords, pageCount } from "./operations-utils";

describe("operations helpers", () => {
  it("formats micro-dollar costs", () => {
    expect(formatMicros(17_839)).toBe("$0.0178");
  });

  it("normalizes and de-duplicates SEO keywords", () => {
    expect(normalizeSeoKeywords("RAG, AI 分身，RAG\n个人简历")).toEqual([
      "RAG",
      "AI 分身",
      "个人简历",
    ]);
  });

  it("keeps pagination valid for empty results", () => {
    expect(pageCount(0, 20)).toBe(1);
    expect(pageCount(41, 20)).toBe(3);
  });
});
