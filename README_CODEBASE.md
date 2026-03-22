# Codebase Deep Dive: MCP + Skills Agent Service

This document explains the full codebase in detail:

- how the agent is assembled at runtime
- how MCP is configured and attached
- how local and hosted skills are integrated
- how memory works
- how chain execution works
- how the Streamlit UI maps to backend endpoints

## 1. High-level architecture

The project has two runtime applications:

1. Backend agent service (TypeScript, Express, OpenAI Responses API)
2. Frontend console (Python Streamlit)

Primary folders:

- `src/`: backend implementation
- `ui/`: Streamlit frontend
- `skills/`: local skill bundles (`<skill>/SKILL.md`)
- `docs/`: architecture notes

Core runtime path:

1. Request comes into Express endpoint (`src/index.ts`)
2. Context is loaded from persistent files + runtime memory
3. Tool list is built (MCP, optional web search, optional hosted skill refs)
4. Input is composed with precedence-aware developer messages
5. Backend calls OpenAI Responses API
6. Response is returned in sync/stream/async/chain format

## 2. Backend entrypoint and startup

Backend entrypoint: `src/index.ts`

Startup sequence:

1. Build Express app
2. Build memory store using config (`createMemoryStore`)
3. Register endpoints (`/v1/chat`, `/v1/chat/stream`, etc.)
4. Initialize memory store in `startServer()`
5. Start listening on configured port

Important runtime objects:

- `sessionToLastResponseId: Map<string, string>`
  - stores last OpenAI response ID per session
  - used to pass `previous_response_id` for conversational continuity
- `memoryStore`
  - abstraction over file/redis/postgres/none backends

## 3. Configuration model (`src/config.ts`)

Config is loaded via `dotenv` then validated with Zod.

### 3.1 Environment schema

`envSchema` validates:

- Provider selection (`OPENAI_PROVIDER=openai|azure`)
- OpenAI config (`OPENAI_API_KEY`, optional `OPENAI_BASE_URL`, `OPENAI_MODEL`, webhook secret)
- Azure OpenAI config (`AZURE_OPENAI_API_KEY`, endpoint/base URL, API version, optional deployment, `OPENAI_MODEL`)
- service config (`PORT`)
- MCP config (`MCP_SERVERS_JSON`, `MCP_CONFIG_PATH`)
- skill refs (`SKILL_REFS_JSON`)
- context files (`AGENT_CONTEXT_PATHS`, `MEMORY_FILE_PATH`)
- memory backend config (`MEMORY_BACKEND`, backend-specific URLs)
- optional Apify token (`APIFY_MCP_TOKEN`)

### 3.2 MCP config loading and merging

Two sources are merged:

1. `MCP_SERVERS_JSON` (env-provided array)
2. `MCP_CONFIG_PATH` (desktop-style JSON file)

`loadMcpConfigFile` behavior:

- URL entries become attachable MCP servers
- command-based entries are marked as skipped with a reason
- invalid file JSON throws a startup error

`mergeMcpServers` merges by `label` (later source overwrites same label).

### 3.3 Final app config

`appConfig` is the single typed config object used by all modules.

## 4. Agent assembly (`src/agent.ts`)

This file provides the runtime "agent construction" primitives:

- `buildTools()`
- `composeInput()`
- `extractOutputText()`

### 4.1 Tool construction (`buildTools`)

Tools are built in this order:

1. MCP tools (one per configured server)
2. optional built-in web search (`ENABLE_WEB_SEARCH=true`)
3. optional hosted skill references (`SKILL_REFS_JSON`)

MCP tool shape includes:

- `type: "mcp"`
- `server_label`, `server_url`, `server_description`
- `require_approval`
- optional `authorization`, `headers`, `allowed_tools`

Apify convenience behavior:

- if label is `apify`
- and `APIFY_MCP_TOKEN` exists
- and no explicit auth/header exists
- then `Authorization: Bearer <token>` is injected

Hosted skill references are attached via a shell environment container:

- `type: "shell"`
- `environment.type = "container"`
- `environment.skills = [{ type: "skill_reference", skill_id, version }]`

### 4.2 Prompt/context composition (`composeInput`)

`composeInput` builds a sequence of messages for Responses API:

1. developer messages containing:
   - precedence rules
   - persistent agent context
   - memory file context
   - runtime memory context
   - local skill context
   - optional extra developer context
2. user messages from input

Precedence policy is embedded explicitly in developer content:

1. platform policies
2. agent context file instructions
3. memory instructions
4. skill instructions
5. current user request

This ensures instruction ordering is visible and stable per request.

### 4.3 Output extraction (`extractOutputText`)

Handles both response shapes:

- direct `response.output_text`
- aggregated `response.output[*].content[*].text` blocks

## 5. Context system (`src/context.ts`)

`loadContextFiles(config)` loads:

- first existing agent context path from candidates
- memory file path if present

Default candidates for agent role file:

- `./agents.md`
- `./AGENTS.md`
- `./claude.md`
- `./CLAUDE.md`

`formatRuntimeMemory(entries)` converts scoped memory entries into a readable bullet list injected as developer context.

## 6. Skill system (`src/skills.ts`)

Local skills are markdown bundles in `skills/<name>/SKILL.md`.

### 6.1 Listing skills

`listLocalSkills()`:

- scans `skills/`
- only includes directories containing `SKILL.md`

Used by endpoint: `GET /v1/skills/local`.

### 6.2 Loading skill instructions

`loadSkillInstructions(skillNames)`:

- validates each skill name against strict safe regex
- reads each `SKILL.md`
- concatenates into a single "Skill Context" block

Skill name sanitization prevents path traversal and unsafe names.

### 6.3 Local vs hosted skills

Two distinct models are supported:

1. Local markdown skills (injected into prompt via developer context)
2. Hosted skill refs (`skill_reference`) attached as tools

Upload helper:

- `scripts/upload-skill.sh` zips a skill folder and calls OpenAI skill endpoints

## 7. Memory subsystem (`src/memory.ts`)

Interface:

- `init()`
- `add(input)`
- `list(query)`

Factory `createMemoryStore(config)` returns one of:

1. `NoopMemoryStore` (`none`)
2. `FileMemoryStore` (`file`)
3. `RedisMemoryStore` (`redis`)
4. `PostgresMemoryStore` (`postgres`)

### 7.1 File backend

- appends one JSON per line to `memory.store.jsonl`
- reads all lines, parses valid JSON entries, sorts latest-first
- applies scope matching and limit

### 7.2 Redis backend

- stores entries in list key `agent:memory:entries` via `LPUSH`
- lists recent chunk with `LRANGE`
- parses/filter/slices in memory

### 7.3 Postgres backend

`init()` ensures table/indexes exist:

- `agent_memory` table
- created_at index
- `(session_id, user_id)` scope index

List queries:

- include global entries (`NULL`) plus matching session/user entries
- sorted by `created_at DESC`

### 7.4 Scope semantics

`matchesScope` logic includes:

- global memory (`sessionId` or `userId` undefined)
- plus matching scoped memory when provided

## 8. API contracts (`src/schemas.ts`, `src/types.ts`)

Zod schemas validate all external request payloads:

- chat request
- chain request
- memory feedback
- memory listing query

Types file defines key domain models:

- `AppConfig`
- `McpServerConfig`
- `SkillRefConfig`
- `ChatRequest`
- `MemoryEntry`

## 9. Chat endpoints and behavior (`src/index.ts`)

### 9.1 `POST /v1/chat` (sync)

Flow:

1. validate payload
2. build tools
3. load context + runtime memory
4. compose input
5. call `openai.responses.create`
6. return `{ responseId, outputText, status, previousResponseId }`

### 9.2 `POST /v1/chat/stream` (SSE)

Flow:

1. same setup as sync
2. call `openai.responses.stream`
3. emit SSE events:
   - `delta`
   - `error`
   - `done`

### 9.3 `POST /v1/chat/async`

Same setup, but sends `background: true`.
Returns `202` with response ID; status polled later.

### 9.4 `GET /v1/chat/status/:responseId`

Retrieves response status/output via `openai.responses.retrieve`.

### 9.5 Session continuity

For chat/stream/async/chain, if `sessionId` is present:

- read previous response ID from in-memory map
- pass it as `previous_response_id`
- store returned response ID as new session head

## 10. MCP behavior in detail

### 10.1 Attached vs skipped

Endpoint `GET /v1/mcp/servers` returns:

- `attached`: MCP servers currently attachable to Responses tools
- `skipped`: servers parsed from file but not attachable (for example command-based)

### 10.2 Command-based MCP entries

Desktop-style command entries (e.g., `command: "npx"`) are detected but skipped for Responses tool attachment.
To use them, expose an HTTP/SSE MCP gateway URL and configure that URL.

### 10.3 Fallback on MCP auth failure

For chat/stream/async/chain:

1. first attempt uses full tool list
2. if detected MCP authorization or connector error:
   - remove MCP tools
   - retry once
3. response includes warning message about fallback

Error detection checks:

- status codes (`401`, `403`, `424`)
- messages mentioning MCP unauthorized/status failures
- connector error codes/types

## 11. Chain execution (`src/chain.ts`)

Endpoint `POST /v1/chat/chain` orchestrates:

1. Planner pass
2. Sequential per-skill steps
3. Final summarizer pass

### 11.1 Planner step

`buildPlannerPrompt` asks model to output strict JSON schema:

`{"overall_strategy":"...","steps":[{"skill":"...","objective":"..."}]}`

`parsePlannerOutput`:

- extracts first JSON object from text
- parses both `overall_strategy` and `overallStrategy`
- filters steps to allowed skills
- falls back to linear default if parse fails

### 11.2 Step execution

For each planned step:

- loads context with only active skill
- builds step prompt with current working draft
- calls Responses API with previous response chaining
- appends output to draft

### 11.3 Summary step

Builds final prompt with all step outputs and optional summarizer hint.
Returns final answer plus short trace guidance.

## 12. Webhook endpoint

`POST /webhooks/openai`:

- uses raw request body
- verifies signature with `openai.webhooks.unwrap`
- logs `response.completed` and `response.failed`

Requires `OPENAI_WEBHOOK_SECRET`.

## 13. Streamlit UI (`ui/streamlit_app.py`)

UI tabs:

1. Chat
2. Chain
3. Memory
4. Inspect

### 13.1 Chat tab

Modes:

- `sync` -> `/v1/chat`
- `stream` -> `/v1/chat/stream` (SSE parser)
- `async` -> `/v1/chat/async` then poll `/v1/chat/status/:id`

Sidebar captures:

- base URL, timeout
- session/user IDs
- skill names CSV
- metadata JSON
- tool choice JSON

### 13.2 Chain tab

Calls `/v1/chat/chain` with:

- task
- `skillChain[]`
- optional planner/summarizer hints

Renders:

- plan object
- step outputs
- final response

### 13.3 Memory tab

- save feedback -> `POST /v1/memory/feedback`
- browse memory -> `GET /v1/memory`

### 13.4 Inspect tab

Quick GET checks:

- `/healthz`
- `/v1/context`
- `/v1/mcp/servers`
- `/v1/skills/local`

## 14. End-to-end request sequence (example)

Given `POST /v1/chat` with `sessionId`, `userId`, and `skillNames`:

1. payload validated
2. tools created (MCP/web search/skill refs)
3. context loaded from `agents.md`, `memory.md`, runtime memory store
4. skill markdown loaded from `skills/<name>/SKILL.md`
5. composed messages sent to Responses API
6. previous response ID linked for conversation continuity
7. output text extracted and returned
8. latest response ID stored in session map

## 15. Key design tradeoffs and current limits

1. Session response map is in-memory:
   - reset on process restart
   - not shared across replicas
2. `previous_response_id` continuity assumes sticky routing in multi-instance setup
3. File memory backend is simple but not ideal for high-throughput production
4. Command MCP servers are intentionally unsupported directly by Responses tools
5. Skill-chain planner output is robustly fallbacked but still model-dependent

## 16. Key files to read first

1. `src/index.ts`
2. `src/agent.ts`
3. `src/config.ts`
4. `src/chain.ts`
5. `src/memory.ts`
6. `src/skills.ts`
7. `ui/streamlit_app.py`

## 17. Useful local commands

From `agent-service`:

```bash
npm run typecheck
npm run build
python3 -m py_compile ui/streamlit_app.py
```

Inspect runtime behavior:

```bash
curl http://localhost:8080/healthz
curl http://localhost:8080/v1/context
curl http://localhost:8080/v1/mcp/servers
curl http://localhost:8080/v1/skills/local
```
