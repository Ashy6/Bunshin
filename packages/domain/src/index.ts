export type Visibility = "public" | "rag_only" | "private";
export type PublishStatus = "draft" | "published" | "archived";
export type DocumentStatus = "uploaded" | "parsing" | "parsed" | "chunking" | "embedding" | "indexed" | "needs_ocr" | "failed";
export type ProviderCredentialStatus = "unverified" | "valid" | "invalid";
export type ProviderRuntimeStatus = "unknown" | "healthy" | "degraded" | "circuit_open" | "unavailable";
export type ProviderRouteMode = "direct" | "gateway" | "runtime";
export interface ProviderRuntimeState {
  credentialStatus: ProviderCredentialStatus;
  runtimeStatus: ProviderRuntimeStatus;
  failureCode: string | null;
  consecutiveFailures: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  circuitOpenUntil: string | null;
  routeMode: ProviderRouteMode;
}
export interface Article { id:string; title:string; slug:string; excerpt:string; body:string; categoryId:string|null; status:PublishStatus; includeInRag:boolean; publishedAt:string|null; updatedAt:string }
export interface KnowledgeDocument { id:string; title:string; sourceType:"text"|"markdown"|"txt"|"pdf"|"article"|"resume"; categoryId:string|null; visibility:Visibility; status:DocumentStatus; chunkCount:number; createdAt:string; updatedAt:string }
export interface UsageEvent { id:string; scenario:"chat"|"query_embedding"|"document_embedding"|"rerank"|"admin_test"; provider:string; model:string; inputTokens:number; outputTokens:number; cachedTokens:number; costMicros:number; currency:string; latencyMs:number; status:"success"|"error"|"rate_limited"; estimated:boolean; createdAt:string }
export interface Citation { chunkId:string; title:string; url:string|null; excerpt:string }
