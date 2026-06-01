# Self-Healing Portal Design

## Source Skills
- **self-healing-agent** (ClawHub): Subsystem monitoring (cron, memory, config, sessions, skills, network), auto-heal, continuous watchdog, healing log with MTTR tracking
- **memory-self-heal** (ClawHub): 3-tier recovery policy (Direct Fix → Safe Fallback → Controlled Escalation), failure classification, evidence scanning, memory writeback

## Architecture: 4 Layers

### Layer 1: `server/selfHeal.ts` — Core Self-Healing Engine
The central module that all other layers call. Implements:

**Failure Classification** (from memory-self-heal):
- `network_or_reachability` — API timeouts, DNS, SSL (NYT, Etsy, forum scrapers)
- `auth_or_config` — Missing/invalid API keys
- `resource_limit` — Rate limits, memory pressure, context overflow
- `syntax_or_args` — Malformed LLM responses, JSON parse errors
- `stale_state` — Server restart mid-pipeline, stuck runs

**3-Tier Recovery Policy** (from memory-self-heal):
1. Direct Fix — retry with exponential backoff (same call, same params)
2. Safe Fallback — skip the failing subsystem, continue with degraded data
3. Controlled Escalation — mark as partial failure, notify owner, log for manual review

**Healing Log** (from self-healing-agent):
- All heal actions logged to DB table `healing_log` with: timestamp, issue, diagnosis, action, result, mttr_seconds
- Surfaced in the portal UI under a "System Health" section

### Layer 2: Pipeline Self-Healing (`pipeline.ts` modifications)
- **Stage-level checkpointing**: After each stage completes, mark it in the DB
- **Auto-resume on restart**: `recoverStaleRuns()` detects interrupted runs, determines last completed stage from DB data, resumes from next stage
- **Per-stage retry with circuit breaker**:
  - Each stage wrapped in `withSelfHeal(stageFn, { maxRetries: 2, fallback: 'skip' })`
  - Forum scraper: if 3+ forums fail → skip forum signals entirely (graceful degradation)
  - Image generation: if fails → complete run without images, mark as "images_pending"
  - NYT API: if fails → use cached books from last successful run
- **Keep-alive heartbeat**: Pipeline writes heartbeat timestamp every 30s so `recoverStaleRuns` can distinguish "actively running" from "dead process"

### Layer 3: API/tRPC Self-Healing (`server/routers.ts` + middleware)
- **Circuit breaker for external APIs**: Track consecutive failures per endpoint; after 3 failures, short-circuit for 60s before retrying
- **tRPC error middleware**: Catch transient DB errors, auto-reconnect, retry once
- **Graceful degradation responses**: If a query fails, return cached/stale data with a `stale: true` flag instead of throwing

### Layer 4: Frontend Self-Healing (`client/`)
- **Global ErrorBoundary**: Catches React render errors, shows recovery UI with "Retry" button, auto-retries after 3s
- **tRPC retry link**: Auto-retry failed queries up to 2 times with 1s delay
- **Stale data indicator**: When backend returns `stale: true`, show yellow banner "Data may be outdated"
- **Network reconnect**: Detect offline → show banner → auto-retry queries when back online

## DB Schema Addition
```sql
CREATE TABLE healing_log (
  id INT AUTO_INCREMENT PRIMARY KEY,
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  subsystem VARCHAR(50) NOT NULL,     -- 'pipeline', 'api', 'frontend', 'db'
  issue TEXT NOT NULL,
  classification VARCHAR(50),          -- failure class from memory-self-heal
  diagnosis TEXT,
  action_taken TEXT,
  result ENUM('success', 'fallback', 'escalated') NOT NULL,
  mttr_seconds INT,
  run_id INT,                          -- nullable, links to bot_runs if pipeline-related
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

## Implementation Files
1. `server/selfHeal.ts` — Core engine (classify, recover, log)
2. `server/circuitBreaker.ts` — Circuit breaker for external APIs
3. Modify `server/pipeline.ts` — Wrap stages, add heartbeat, resume logic
4. Modify `server/routers.ts` — Add error middleware
5. `client/src/components/ErrorBoundary.tsx` — Global error boundary
6. `client/src/components/StaleDataBanner.tsx` — Stale data indicator
7. Modify `client/src/lib/trpc.ts` — Add retry link
