INSERT OR IGNORE INTO categories (id,name,slug,scope,description,sort_order,created_at,updated_at) VALUES
('cat-ai-agent','AI 与 Agent','ai-agent','both','个人 AI、RAG 与 Agent 的实践记录',10,datetime('now'),datetime('now')),
('cat-engineering','工程实践','engineering','both','产品工程、架构与 Cloudflare 部署记录',20,datetime('now'),datetime('now')),
('cat-knowledge','知识管理','knowledge','both','写作、阅读与知识沉淀方法',30,datetime('now'),datetime('now'));

INSERT OR IGNORE INTO profiles (id,display_name,headline,bio,social_json,published,created_at,updated_at) VALUES
('owner','Bunshin','保持好奇，持续构建','这是一个个人简历、文章与 AI 分身站点。真实姓名、经历和项目将在站长确认后补充。','{}',1,datetime('now'),datetime('now'));

INSERT OR IGNORE INTO articles (id,title,slug,excerpt,body,category_id,status,include_in_rag,published_at,seo_description,created_at,updated_at) VALUES
('article-rag-intro','如何构建可信的个人 AI 分身','building-a-personal-ai-twin','从个人资料、文章和项目中建立可追溯的知识库，让回答有依据，也知道什么时候应该说不知道。','# 如何构建可信的个人 AI 分身\n\n可信的个人分身应当以资料为事实边界，而不是依赖模型猜测。\n\n## 从内容开始\n\n先整理简历、项目说明、文章与知识笔记，再进行切片、索引和检索。\n\n## 保持可追溯\n\n回答中的关键事实应附带来源；资料不足时明确说明不知道。','cat-ai-agent','published',1,datetime('now'), '个人 AI 分身与 RAG 的基础设计原则',datetime('now'),datetime('now')),
('article-engineering','从产品想法到可维护的工程','engineering-notes','用清晰边界、渐进交付和可观测性，将个人项目做成可以长期运行的系统。','# 从产品想法到可维护的工程\n\n这个项目采用 Monorepo 管理访客端、管理后台与共享能力。\n\n## 清晰边界\n\n公开端负责内容展示与对话，管理端负责内容、知识库、渠道和用量。\n\n## 渐进交付\n\n每次发布都经过类型检查、测试、构建、迁移和健康检查。','cat-engineering','published',1,datetime('now'), '个人项目的工程化与渐进交付',datetime('now'),datetime('now')),
('article-knowledge','让知识持续复利','knowledge-that-compounds','把零散笔记转化为可检索、可引用、可继续演进的知识资产。','# 让知识持续复利\n\n知识积累的价值来自持续整理、建立关联和反复使用。\n\n## 可检索\n\n为资料设置清晰标题和分类，并保留足够上下文。\n\n## 可演进\n\n定期复查旧内容，修正过期信息，并把新的理解沉淀成文章。','cat-knowledge','published',1,datetime('now'), '个人知识管理和持续写作方法',datetime('now'),datetime('now'));

PRAGMA optimize;
