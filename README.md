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

## Render and Railway deployment

Bernard does not require `BUILT_IN_FORGE_API_URL` or `BUILT_IN_FORGE_API_KEY` for uploads. When those variables are absent, uploads use a process-local fallback and are converted into in-memory evidence URLs for the current diagnosis request. This is suitable for the immediate upload-to-diagnosis flow; use a persistent object store before enabling multiple replicas or long-term evidence retention.

For diagnosis on a non-Manus deployment, configure an OpenAI-compatible model endpoint:

```text
LLM_API_KEY=your-provider-key
LLM_API_URL=https://api.openai.com/v1
LLM_MODEL=gpt-4o
```

`OPENAI_API_KEY`, `OPENAI_BASE_URL`, and `OPENAI_MODEL` are accepted as equivalent names. If Manus Forge variables are present, Bernard continues to use them automatically.

## Project structure

- `client/` — responsive React interface
- `server/` — tRPC procedures, authentication, uploads, and diagnosis orchestration
- `shared/` — shared diagnosis contracts and normalization helpers
- `drizzle/` — database schema and migrations
