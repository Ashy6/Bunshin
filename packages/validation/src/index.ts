import { z } from "zod";
export const chatRequestSchema=z.object({message:z.string().trim().min(1).max(1000),conversationId:z.string().uuid().optional()});
export const categorySchema=z.object({name:z.string().trim().min(1).max(40),slug:z.string().trim().regex(/^[a-z0-9-]+$/).max(60),scope:z.enum(["article","knowledge","shared"])});
export const providerSchema=z.object({name:z.string().trim().min(1).max(60),kind:z.enum(["openai","anthropic","gemini","openai-compatible"]),baseUrl:z.string().url().refine((url)=>url.startsWith("https://")||url.startsWith("http://localhost"),"仅允许 HTTPS 或本地地址"),apiKey:z.string().min(8).max(500),chatModel:z.string().trim().min(1).max(120),embeddingModel:z.string().trim().min(1).max(120),monthlyBudgetMicros:z.number().int().nonnegative()});
export const articleSchema=z.object({title:z.string().trim().min(1).max(160),slug:z.string().trim().regex(/^[a-z0-9-]+$/).max(180),excerpt:z.string().trim().max(500),body:z.string().min(1).max(500000),categoryId:z.string().nullable(),includeInRag:z.boolean(),status:z.enum(["draft","published","archived"])});
export type ChatRequest=z.infer<typeof chatRequestSchema>;
export type ProviderInput=z.infer<typeof providerSchema>;
