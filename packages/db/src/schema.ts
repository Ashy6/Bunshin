import {
  integer,
  sqliteTable,
  text,
  uniqueIndex,
  index,
} from "drizzle-orm/sqlite-core";

const timestamps = {
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
};
export const adminUsers = sqliteTable(
  "admin_users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    totpSecretEncrypted: text("totp_secret_encrypted"),
    ...timestamps,
  },
  (t) => [uniqueIndex("idx_admin_users_email").on(t.email)],
);
export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    adminId: text("admin_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    expiresAt: text("expires_at").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("idx_sessions_token_hash").on(t.tokenHash),
    index("idx_sessions_admin_id").on(t.adminId),
  ],
);
export const profiles = sqliteTable("profiles", {
  id: text("id").primaryKey(),
  displayName: text("display_name").notNull(),
  headline: text("headline").notNull(),
  bio: text("bio").notNull(),
  location: text("location"),
  avatarUrl: text("avatar_url"),
  socialJson: text("social_json").notNull().default("{}"),
  published: integer("published", { mode: "boolean" }).notNull().default(false),
  ragEnabled: integer("rag_enabled", { mode: "boolean" }).notNull().default(true),
  websiteUrl: text("website_url"),
  publicEmail: text("public_email"),
  experienceJson: text("experience_json").notNull().default("[]"),
  projectJson: text("project_json").notNull().default("[]"),
  educationJson: text("education_json").notNull().default("[]"),
  avatarPositionX: integer("avatar_position_x").notNull().default(50),
  avatarPositionY: integer("avatar_position_y").notNull().default(50),
  markdownBio: text("markdown_bio").notNull().default(""),
  skillsJson: text("skills_json").notNull().default("[]"),
  resumeDocumentId: text("resume_document_id"),
  ...timestamps,
});
export const profileVersions = sqliteTable(
  "profile_versions",
  {
    id: text("id").primaryKey(),
    profileId: text("profile_id").notNull(),
    snapshotJson: text("snapshot_json").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("idx_profile_versions_profile_created").on(t.profileId, t.createdAt)],
);
export const categories = sqliteTable(
  "categories",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    scope: text("scope", {
      enum: ["article", "knowledge", "shared"],
    }).notNull(),
    description: text("description").notNull().default(""),
    sortOrder: integer("sort_order").notNull().default(0),
    ...timestamps,
  },
  (t) => [uniqueIndex("idx_categories_slug").on(t.slug)],
);
export const articles = sqliteTable(
  "articles",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    slug: text("slug").notNull(),
    excerpt: text("excerpt").notNull().default(""),
    body: text("body").notNull(),
    categoryId: text("category_id"),
    status: text("status", { enum: ["draft", "published", "archived"] })
      .notNull()
      .default("draft"),
    includeInRag: integer("include_in_rag", { mode: "boolean" })
      .notNull()
      .default(true),
    publishedAt: text("published_at"),
    seoDescription: text("seo_description"),
    documentId: text("document_id"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("idx_articles_slug").on(t.slug),
    index("idx_articles_status_published_at").on(t.status, t.publishedAt),
  ],
);
export const documents = sqliteTable(
  "documents",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    sourceType: text("source_type").notNull(),
    categoryId: text("category_id"),
    visibility: text("visibility", { enum: ["public", "rag_only", "private"] })
      .notNull()
      .default("rag_only"),
    status: text("status").notNull(),
    r2Key: text("r2_key"),
    parsedText: text("parsed_text"),
    errorMessage: text("error_message"),
    chunkCount: integer("chunk_count").notNull().default(0),
    purpose: text("purpose").notNull().default("knowledge"),
    originalName: text("original_name"),
    fileSize: integer("file_size").notNull().default(0),
    sourceUrl: text("source_url"),
    archivedAt: text("archived_at"),
    ...timestamps,
  },
  (t) => [
    index("idx_documents_status").on(t.status),
    index("idx_documents_category_id").on(t.categoryId),
  ],
);
export const chunks = sqliteTable(
  "chunks",
  {
    id: text("id").primaryKey(),
    documentId: text("document_id").notNull(),
    chunkIndex: integer("chunk_index").notNull(),
    content: text("content").notNull(),
    headingPath: text("heading_path").notNull().default("[]"),
    pageNumber: integer("page_number"),
    visibility: text("visibility").notNull(),
    contentHash: text("content_hash").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("idx_chunks_document_index").on(t.documentId, t.chunkIndex),
    index("idx_chunks_document_id").on(t.documentId),
  ],
);
export const providers = sqliteTable("providers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  kind: text("kind").notNull(),
  baseUrl: text("base_url").notNull(),
  encryptedApiKey: text("encrypted_api_key").notNull(),
  chatModel: text("chat_model").notNull(),
  embeddingModel: text("embedding_model").notNull(),
  inputPriceMicros: integer("input_price_micros").notNull().default(0),
  outputPriceMicros: integer("output_price_micros").notNull().default(0),
  embeddingPriceMicros: integer("embedding_price_micros").notNull().default(0),
  monthlyBudgetMicros: integer("monthly_budget_micros").notNull().default(0),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  isDefault: integer("is_default", { mode: "boolean" })
    .notNull()
    .default(false),
  healthStatus: text("health_status").notNull().default("unknown"),
  lastCheckedAt: text("last_checked_at"),
  lastError: text("last_error"),
  ...timestamps,
});
export const usageEvents = sqliteTable(
  "usage_events",
  {
    id: text("id").primaryKey(),
    scenario: text("scenario").notNull(),
    providerId: text("provider_id"),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cachedTokens: integer("cached_tokens").notNull().default(0),
    costMicros: integer("cost_micros").notNull().default(0),
    currency: text("currency").notNull().default("USD"),
    latencyMs: integer("latency_ms").notNull().default(0),
    status: text("status").notNull(),
    estimated: integer("estimated", { mode: "boolean" })
      .notNull()
      .default(false),
    visitorHash: text("visitor_hash"),
    traceId: text("trace_id").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    index("idx_usage_events_created_at").on(t.createdAt),
    index("idx_usage_events_provider_created").on(t.providerId, t.createdAt),
  ],
);
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").notNull(),
});
