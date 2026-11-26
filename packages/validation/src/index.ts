import { z } from "zod";
export const chatRequestSchema = z.object({
  message: z.string().trim().min(1).max(1000),
  conversationId: z.string().uuid().optional(),
});
export const categorySchema = z.object({
  name: z.string().trim().min(1).max(40),
  slug: z
    .string()
    .trim()
    .regex(/^[a-z0-9-]+$/)
    .max(60),
  scope: z.enum(["article", "knowledge", "shared"]),
  description: z.string().trim().max(300).default(""),
  sortOrder: z.number().int().min(0).max(9999).default(0),
  showInPortal: z.boolean().default(true),
});
export const providerSchema = z.object({
  name: z.string().trim().min(1).max(60),
  kind: z.enum(["openai", "anthropic", "gemini", "openai-compatible"]),
  baseUrl: z
    .string()
    .url()
    .refine(
      (url) => url.startsWith("https://") || url.startsWith("http://localhost"),
      "仅允许 HTTPS 或本地地址",
    ),
  apiKey: z.string().min(8).max(500),
  chatModel: z.string().trim().min(1).max(120),
  embeddingModel: z.string().trim().min(1).max(120),
  monthlyBudgetMicros: z.number().int().nonnegative(),
});
export const simpleProviderSchema = z.object({
  presetId: z.enum(["openai", "deepseek", "openrouter", "custom"]),
  apiKey: z.string().min(8).max(500),
  monthlyBudgetMicros: z.number().int().nonnegative().default(0),
  baseUrl: z.string().url().optional(),
  chatModel: z.string().trim().min(1).max(120).optional(),
  allowExternalEmbedding: z.boolean().default(false),
});
export const profileSchema = z.object({
  displayName: z.string().trim().min(1).max(80),
  headline: z.string().trim().max(160),
  bio: z.string().trim().max(2000),
  location: z.string().trim().max(100).nullable(),
  markdownBio: z.string().max(200000),
  skills: z.array(z.string().trim().min(1).max(40)).max(100),
  social: z.record(
    z.string(),
    z.union([z.string().trim().url(), z.literal("")]),
  ),
  published: z.boolean(),
  ragEnabled: z.boolean(),
  websiteUrl: z.union([z.string().trim().url(), z.literal("")]).nullable(),
  publicEmail: z.union([z.string().trim().email(), z.literal("")]).nullable(),
  experiences: z.array(z.object({
    title: z.string().trim().min(1).max(120),
    organization: z.string().trim().max(120),
    period: z.string().trim().max(80),
    summary: z.string().trim().max(2000),
  })).max(30),
  projects: z.array(z.object({
    name: z.string().trim().min(1).max(120),
    role: z.string().trim().max(120),
    url: z.union([z.string().trim().url(), z.literal("")]),
    summary: z.string().trim().max(2000),
  })).max(50),
  education: z.array(z.object({
    school: z.string().trim().min(1).max(120),
    degree: z.string().trim().max(120),
    period: z.string().trim().max(80),
    summary: z.string().trim().max(1000),
  })).max(20),
  avatarPositionX: z.number().int().min(0).max(100),
  avatarPositionY: z.number().int().min(0).max(100),
});
export const agentSettingsSchema = z.object({
  enabled: z.boolean(),
  dailyLimit: z.number().int().min(1).max(1000),
  minuteLimit: z.number().int().min(1).max(100),
  globalDailyLimit: z.number().int().min(1).max(100000),
  welcomeMessage: z.string().trim().min(1).max(500),
  systemInstruction: z.string().trim().max(2000),
});
export const articleSchema = z.object({
  title: z.string().trim().min(1).max(160),
  slug: z
    .string()
    .trim()
    .regex(/^[a-z0-9-]+$/)
    .max(180),
  excerpt: z.string().trim().max(500),
  body: z.string().min(1).max(500000),
  categoryId: z.string().nullable(),
  includeInRag: z.boolean(),
  status: z.enum(["draft", "scheduled", "published", "archived"]),
  seoDescription: z.string().trim().max(300).nullable().optional(),
  seoTitle: z.string().trim().max(180).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  scheduledAt: z.string().datetime().nullable().optional(),
});
export type ChatRequest = z.infer<typeof chatRequestSchema>;
export type ProviderInput = z.infer<typeof providerSchema>;
