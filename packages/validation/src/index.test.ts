import { describe, expect, it } from "vitest";
import { agentSettingsSchema, systemSettingsSchema } from "./index";

describe("operations settings validation", () => {
  it("accepts the personal-site defaults", () => {
    expect(
      systemSettingsSchema.parse({
        publicOrigin: "https://example.com",
        defaultSeoDescription: "个人简历、文章与 AI 分身",
        seoKeywords: ["RAG", "AI 分身"],
        llmsFullEnabled: false,
        cacheTtlSeconds: 300,
      }),
    ).toMatchObject({ publicOrigin: "https://example.com", cacheTtlSeconds: 300 });
  });

  it("rejects unsafe public origins and invalid cache windows", () => {
    expect(
      systemSettingsSchema.safeParse({
        publicOrigin: "not-a-url",
        defaultSeoDescription: "test",
        seoKeywords: [],
        llmsFullEnabled: false,
        cacheTtlSeconds: 1,
      }).success,
    ).toBe(false);
  });

  it("keeps the default visitor quota at 25 or above", () => {
    expect(
      agentSettingsSchema.parse({
        enabled: true,
        dailyLimit: 25,
        minuteLimit: 5,
        globalDailyLimit: 500,
        welcomeMessage: "你好，我是个人分身",
        systemInstruction: "只依据知识库回答",
      }).dailyLimit,
    ).toBe(25);
  });
});
