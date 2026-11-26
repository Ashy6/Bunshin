# ai-bunshin repository rules

- Product requirements and architecture live in `README.md` and `docs/`.
- Any change to product scope, deployment, repository structure, Cloudflare resources, security, or public routes must update `README.md` in the same change.
- The product has exactly two deployable applications: `apps/web` and `apps/admin`.
- Do not add a third API application. Public APIs belong to `apps/web`; admin APIs and queue consumers belong to `apps/admin`.
- Never commit real provider keys, encryption keys, passwords, or Cloudflare credentials.
- Public content must remain readable without client-side JavaScript.
- Admin routes and responses must be marked `noindex` and `no-store`.
- Preserve the clean-room implementation boundary: do not copy third-party personal content or protected assets.
