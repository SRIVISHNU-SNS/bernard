# Bernard

Bernard helps people understand what is wrong with a device and choose a clear next step. Upload a photo, short video, model label, or error display and Bernard returns a concise diagnosis, safety guidance, estimated cost in INR, and a guided repair path.

## Product highlights

- Automatic device and model detection from uploaded evidence
- Multi-photo and short-video diagnosis
- Model and serial label reading
- Error-code reading
- Safety-first repair guidance
- INR cost estimates
- Downloadable PDF reports
- Responsive, camera-first mobile experience

## Local development

```bash
pnpm install
pnpm dev
```

Run checks before opening a pull request:

```bash
pnpm check
pnpm test
pnpm build
```

The application expects the runtime environment variables supplied by the deployment environment for authentication, database access, storage, and model services. Keep local secrets in `.env` files and never commit them.

## Project structure

- `client/` — responsive React interface
- `server/` — tRPC procedures, authentication, uploads, and diagnosis orchestration
- `shared/` — shared diagnosis contracts and normalization helpers
- `drizzle/` — database schema and migrations
