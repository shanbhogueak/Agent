# Reference Architecture

## Components

1. Client apps
2. Agent service (this repo)
3. OpenAI Responses API
4. Remote MCP servers
5. Skill registry (`/v1/skills`) and local skill bundles
6. Context files (`agents.md`, `memory.md`)
7. Runtime memory store (file, Redis, or Postgres)
8. Optional queue/store for async jobs and distributed session state

## Request flow

1. Client calls `POST /v1/chat` (or stream/async/chain variants).
2. Service loads context files and runtime memories.
3. Service composes precedence-aware prompt context:
   - persistent role context
   - persistent memory
   - skill instructions
   - user request
4. Service composes tools:
   - MCP tool entries from `MCP_SERVERS_JSON` and/or `MCP_CONFIG_PATH`
   - optional hosted `skill_reference` entries
5. Service calls `responses.create` or `responses.stream`.
6. Service returns final output or stream deltas.
7. For long jobs, service uses `background: true` and receives webhook completion.

## Skill-chain flow (`POST /v1/chat/chain`)

1. Planner prompt creates a JSON step plan for the requested skill list.
2. Service executes each skill step sequentially.
3. Step outputs are accumulated as a working draft.
4. Final summarizer pass synthesizes a user-ready answer + short trace.

## Deployment checklist

- [ ] API key and webhook secret are configured
- [ ] HTTPS and request authentication enabled
- [ ] MCP server list restricted and reviewed
- [ ] Command-based MCP entries are exposed via HTTP/SSE gateway URLs
- [ ] PII logging policy enforced
- [ ] Backpressure/rate limiting enabled
- [ ] Health/readiness probes configured
- [ ] Webhook signature verification enabled
- [ ] Runtime memory backend configured (Redis/Postgres for production)
