# MCP + Skills Agent Service + Streamlit UI

This codebase includes:

- A TypeScript agent service (`src/`) using OpenAI Responses API
- MCP integration (URL-based MCP servers)
- Skill support (`SKILL.md`, local and hosted)
- Context engineering (`agents.md`, `memory.md`, runtime memory backends)
- A Streamlit UI (`ui/streamlit_app.py`) to interact with all core endpoints

## What You Can Do

- Chat with the agent in `sync`, `stream`, or `async` mode
- Run chained skill workflows (`/v1/chat/chain`)
- Persist feedback memory and inspect runtime memory
- Inspect loaded context and MCP server attachment state

## Project Structure

- `src/` -> Agent service source code
- `ui/streamlit_app.py` -> Streamlit interface
- `ui/requirements.txt` -> Python dependencies for Streamlit UI
- `.env.example` -> Agent service configuration template
- `agents.md` -> Persistent role/context instructions
- `memory.md` -> Persistent manual memory file
- `mcp.config.json` -> Desktop-style MCP configuration

## Step-by-Step Setup and Execution

## 1. Prerequisites

Install these on your machine:

- Node.js 20+ and npm
- Python 3.10+

Verify:

```bash
node -v
npm -v
python3 --version
```

## 2. Configure and Run the Agent Service (Backend)

From this folder:

```bash
cd /Users/anishshanbhogue/Documents/Agent/agent-service
```

Install backend dependencies:

```bash
npm install
```

Create local env:

```bash
cp .env.example .env
```

Edit `.env` and set at least:

- `OPENAI_API_KEY`
- `OPENAI_MODEL` (default `gpt-5.4`)
- MCP settings (`MCP_CONFIG_PATH` and/or `MCP_SERVERS_JSON`)

Start backend:

```bash
npm run dev
```

Confirm health:

```bash
curl http://localhost:8080/healthz
```

Expected: JSON with `ok: true`.

## 3. Configure and Run Streamlit UI (Frontend)

Open a second terminal and run:

```bash
cd /Users/anishshanbhogue/Documents/Agent/agent-service
python3 -m venv .venv-ui
source .venv-ui/bin/activate
pip install -r ui/requirements.txt
```

Set target backend URL (optional if default `http://localhost:8080`):

```bash
export AGENT_BASE_URL=http://localhost:8080
```

Run Streamlit:

```bash
streamlit run ui/streamlit_app.py
```

Open the URL printed by Streamlit (usually `http://localhost:8501`).

## 4. Use the Streamlit Tabs

### Chat tab

- Choose mode (`stream`, `sync`, `async`) in sidebar
- Set `Session ID`, `User ID`, and optional `Skill Names`
- Send prompts using chat input

### Chain tab

- Provide task + comma-separated skill chain
- Optionally add planner/summarizer hints
- Run full `planner -> per-skill -> summary` workflow

### Memory tab

- Save feedback memories to runtime memory backend
- Inspect stored memory by `sessionId` and `userId`

### Inspect tab

- Check `/healthz`
- Inspect `/v1/context`
- Inspect `/v1/mcp/servers`
- List `/v1/skills/local`

## Context Engineering Model

Each request is composed using this precedence order:

1. Platform safety and hard policies
2. Persistent agent context (`agents.md` / `AGENTS.md`)
3. Persistent memory (`memory.md` + runtime memory store)
4. Skill instructions (`SKILL.md`)
5. Current user request

## Runtime Memory Backends

Configure `MEMORY_BACKEND` in `.env`:

- `file` -> persists to `MEMORY_STORE_FILE_PATH`
- `redis` -> requires `REDIS_URL`
- `postgres` -> requires `POSTGRES_URL`
- `none` -> runtime memory disabled

## MCP Configuration

You can configure MCP in either format.

### Option A: `MCP_SERVERS_JSON`

```json
[
  {
    "label": "crm",
    "url": "https://mcp.example.com/sse",
    "description": "CRM lookup and account actions",
    "requireApproval": "always"
  }
]
```

### Option B: `mcp.config.json`

```json
{
  "mcpServers": {
    "apify": {
      "url": "https://mcp.apify.com",
      "transport": "http",
      "timeout_seconds": 90,
      "headers": {
        "Authorization": "Bearer <APIFY_TOKEN>"
      }
    }
  }
}
```

Important: command-based MCP entries (for example `"command": "npx"`) are detected but skipped for OpenAI MCP tool attachment. Expose those through an HTTP/SSE MCP gateway URL, then configure that URL.

For Apify specifically, you can also set `APIFY_MCP_TOKEN` in `.env` and the service will inject `Authorization: Bearer <token>` automatically for MCP server label `apify`.

## API Endpoints Exposed by Backend

- `POST /v1/chat`
- `POST /v1/chat/stream`
- `POST /v1/chat/async`
- `POST /v1/chat/chain`
- `GET /v1/chat/status/:responseId`
- `GET /v1/context`
- `GET /v1/skills/local`
- `GET /v1/mcp/servers`
- `POST /v1/memory/feedback`
- `GET /v1/memory`
- `POST /webhooks/openai`

## Troubleshooting

If Streamlit cannot connect:

1. Verify backend is running on `http://localhost:8080`
2. Verify `AGENT_BASE_URL` in Streamlit sidebar
3. Check backend terminal logs for request errors

If async never completes:

1. Use `GET /v1/chat/status/:responseId` from Inspect tab or curl
2. Verify OpenAI API key/model settings
3. For webhook mode, set `OPENAI_WEBHOOK_SECRET` and public webhook routing

If MCP tool listing fails with `401 Unauthorized`:

1. Set `APIFY_MCP_TOKEN` in `.env` and restart `npm run dev`
2. Or provide MCP auth directly in `mcp.config.json` via `authorization` or `headers`
3. Check `GET /v1/mcp/servers` to confirm auth is present (`hasAuthorization` / `headerKeys`)
4. Chat endpoints automatically retry once without MCP tools and return a warning, so core chat can continue while MCP auth is fixed

## Validation Commands

Run backend checks:

```bash
npm run typecheck
npm run build
```

Run UI syntax check:

```bash
python3 -m py_compile ui/streamlit_app.py
```
