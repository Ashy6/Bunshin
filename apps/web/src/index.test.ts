import { describe, expect, it } from "vitest";
import { articleBodyWithoutDuplicateTitle, shanghaiParts } from "./index";

describe("public site helpers", () => {
  it("removes a duplicated markdown article title", () => {
    expect(articleBodyWithoutDuplicateTitle("# 标题\n\n正文", "标题")).toBe("正文");
    expect(articleBodyWithoutDuplicateTitle("正文", "标题")).toBe("正文");
  });

  it("builds quota buckets using Asia/Shanghai time", () => {
    const parts = shanghaiParts(new Date("2026-11-26T16:30:00.000Z"));
    expect(parts.day).toBe("2026-11-27");
    expect(parts.minute).toBe("2026-11-27-00-30");
  });
});
