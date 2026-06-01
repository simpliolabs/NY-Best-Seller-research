/**
 * Self-Healing Engine
 * 
 * Integrates patterns from ClawHub:
 * - self-healing-agent: subsystem monitoring, auto-heal, healing log with MTTR
 * - memory-self-heal: 3-tier recovery (Direct Fix → Safe Fallback → Controlled Escalation),
 *   failure classification, evidence scanning
 * 
 * All auto-recovery actions are logged to the healing_log DB table.
 */

import { getDb } from "./db";
import { healingLog, type InsertHealingLog } from "../drizzle/schema";

// ─── Failure Classification (from memory-self-heal) ─────────────────────────

export type FailureClass =
  | "network_or_reachability"  // API timeouts, DNS, SSL
  | "auth_or_config"           // Missing/invalid API keys
  | "resource_limit"           // Rate limits, memory pressure
  | "syntax_or_args"           // Malformed LLM responses, JSON parse
  | "stale_state"              // Server restart mid-pipeline, stuck runs
  | "data_integrity"           // Missing/corrupt DB data
  | "unknown";

export function classifyError(error: unknown): FailureClass {
  const msg = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();

  // Network / reachability
  if (
    msg.includes("timeout") ||
    msg.includes("econnrefused") ||
    msg.includes("econnreset") ||
    msg.includes("enotfound") ||
    msg.includes("dns") ||
    msg.includes("ssl") ||
    msg.includes("fetch failed") ||
    msg.includes("network") ||
    msg.includes("socket hang up")
  ) {
    return "network_or_reachability";
  }

  // Auth / config
  if (
    msg.includes("401") ||
    msg.includes("403") ||
    msg.includes("unauthorized") ||
    msg.includes("forbidden") ||
    msg.includes("api key") ||
    msg.includes("api_key") ||
    msg.includes("invalid key") ||
    msg.includes("not configured")
  ) {
    return "auth_or_config";
  }

  // Resource limits
  if (
    msg.includes("429") ||
    msg.includes("rate limit") ||
    msg.includes("too many requests") ||
    msg.includes("quota") ||
    msg.includes("context") ||
    msg.includes("memory") ||
    msg.includes("heap")
  ) {
    return "resource_limit";
  }

  // Syntax / args (LLM response parse errors)
  if (
    msg.includes("json") ||
    msg.includes("parse") ||
    msg.includes("syntax") ||
    msg.includes("unexpected token") ||
    msg.includes("invalid") && msg.includes("response")
  ) {
    return "syntax_or_args";
  }

  // Stale state
  if (
    msg.includes("stuck") ||
    msg.includes("stale") ||
    msg.includes("interrupted") ||
    msg.includes("restart")
  ) {
    return "stale_state";
  }

  // Data integrity
  if (
    msg.includes("null") ||
    msg.includes("undefined") ||
    msg.includes("not found") ||
    msg.includes("missing")
  ) {
    return "data_integrity";
  }

  return "unknown";
}

// ─── Healing Log ─────────────────────────────────────────────────────────────

export async function logHealingAction(entry: Omit<InsertHealingLog, "id" | "createdAt">): Promise<void> {
  try {
    const db = await getDb();
    if (!db) return;
    await db.insert(healingLog).values(entry);
    console.log(`[SelfHeal] Logged: ${entry.subsystem}/${entry.classification} → ${entry.result}`);
  } catch (err) {
    // Don't let logging failures cascade
    console.warn("[SelfHeal] Failed to log healing action:", err);
  }
}

// ─── 3-Tier Recovery Policy (from memory-self-heal) ──────────────────────────

export interface RecoveryOptions<T> {
  /** Human-readable label for logging */
  label: string;
  /** Subsystem name for the healing log */
  subsystem: "pipeline" | "api" | "db" | "network" | "frontend";
  /** The primary operation to attempt */
  primaryFn: () => Promise<T>;
  /** Fallback operation if primary fails (Tier 2) */
  fallbackFn?: () => Promise<T>;
  /** Default value if both primary and fallback fail (Tier 3) */
  defaultValue?: T;
  /** Max retries for the primary operation (Tier 1) */
  maxRetries?: number;
  /** Base delay in ms for exponential backoff */
  baseDelayMs?: number;
  /** Max delay cap in ms */
  maxDelayMs?: number;
  /** Optional run ID for pipeline-related operations */
  runId?: number;
  /** Whether to throw if all tiers fail (default: true if no defaultValue) */
  throwOnExhaust?: boolean;
}

export async function withSelfHeal<T>(opts: RecoveryOptions<T>): Promise<T> {
  const {
    label,
    subsystem,
    primaryFn,
    fallbackFn,
    defaultValue,
    maxRetries = 2,
    baseDelayMs = 1000,
    maxDelayMs = 15000,
    runId,
    throwOnExhaust = defaultValue === undefined,
  } = opts;

  const startTime = Date.now();

  // ── Tier 1: Direct Fix (retry with exponential backoff) ──
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await primaryFn();
      
      // Log successful recovery if this wasn't the first attempt
      if (attempt > 0) {
        await logHealingAction({
          subsystem,
          issue: `${label} failed ${attempt} time(s) before succeeding`,
          classification: classifyError(lastError),
          diagnosis: lastError instanceof Error ? lastError.message : String(lastError),
          actionTaken: `Retried ${attempt} time(s) with exponential backoff`,
          result: "success",
          mttrSeconds: Math.round((Date.now() - startTime) / 1000),
          runId: runId ?? null,
        });
      }
      return result;
    } catch (err) {
      lastError = err;
      const classification = classifyError(err);
      
      // Don't retry auth errors — they won't fix themselves
      if (classification === "auth_or_config") {
        console.warn(`[SelfHeal] ${label}: Auth/config error, skipping retries`);
        break;
      }

      if (attempt < maxRetries) {
        const delay = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
        console.log(`[SelfHeal] ${label}: Attempt ${attempt + 1} failed (${classification}), retrying in ${delay}ms...`);
        await sleep(delay);
      }
    }
  }

  // ── Tier 2: Safe Fallback ──
  if (fallbackFn) {
    try {
      console.log(`[SelfHeal] ${label}: Primary exhausted, trying fallback...`);
      const result = await fallbackFn();
      
      await logHealingAction({
        subsystem,
        issue: `${label} primary failed, fallback succeeded`,
        classification: classifyError(lastError),
        diagnosis: lastError instanceof Error ? lastError.message : String(lastError),
        actionTaken: "Switched to fallback operation",
        result: "fallback",
        mttrSeconds: Math.round((Date.now() - startTime) / 1000),
        runId: runId ?? null,
      });
      
      return result;
    } catch (fallbackErr) {
      console.warn(`[SelfHeal] ${label}: Fallback also failed:`, fallbackErr);
      lastError = fallbackErr;
    }
  }

  // ── Tier 3: Controlled Escalation ──
  const classification = classifyError(lastError);
  
  if (defaultValue !== undefined) {
    await logHealingAction({
      subsystem,
      issue: `${label} all recovery tiers exhausted, using default value`,
      classification,
      diagnosis: lastError instanceof Error ? lastError.message : String(lastError),
      actionTaken: "Returned default/degraded value",
      result: "fallback",
      mttrSeconds: Math.round((Date.now() - startTime) / 1000),
      runId: runId ?? null,
    });
    
    return defaultValue;
  }

  // Log escalation
  await logHealingAction({
    subsystem,
    issue: `${label} all recovery tiers exhausted`,
    classification,
    diagnosis: lastError instanceof Error ? lastError.message : String(lastError),
    actionTaken: "Escalated — no fallback or default available",
    result: "escalated",
    mttrSeconds: Math.round((Date.now() - startTime) / 1000),
    runId: runId ?? null,
  });

  if (throwOnExhaust) {
    throw lastError;
  }

  return defaultValue as T;
}

// ─── Circuit Breaker (from self-healing-agent network monitoring) ─────────────

interface CircuitState {
  failures: number;
  lastFailure: number;
  isOpen: boolean;
  openedAt: number;
}

const circuits = new Map<string, CircuitState>();

export interface CircuitBreakerOptions {
  /** Unique name for this circuit */
  name: string;
  /** Number of consecutive failures before opening the circuit */
  failureThreshold?: number;
  /** How long (ms) to keep the circuit open before allowing a test request */
  resetTimeoutMs?: number;
}

export function getCircuitState(name: string): CircuitState {
  if (!circuits.has(name)) {
    circuits.set(name, { failures: 0, lastFailure: 0, isOpen: false, openedAt: 0 });
  }
  return circuits.get(name)!;
}

export async function withCircuitBreaker<T>(
  opts: CircuitBreakerOptions,
  fn: () => Promise<T>,
  fallback?: () => Promise<T>
): Promise<T> {
  const { name, failureThreshold = 3, resetTimeoutMs = 60000 } = opts;
  const state = getCircuitState(name);

  // Check if circuit is open
  if (state.isOpen) {
    const elapsed = Date.now() - state.openedAt;
    if (elapsed < resetTimeoutMs) {
      console.log(`[CircuitBreaker] ${name}: Circuit OPEN (${Math.round((resetTimeoutMs - elapsed) / 1000)}s until reset)`);
      if (fallback) return fallback();
      throw new Error(`Circuit breaker ${name} is open — service unavailable`);
    }
    // Half-open: allow one test request
    console.log(`[CircuitBreaker] ${name}: Half-open, testing...`);
  }

  try {
    const result = await fn();
    // Success: reset the circuit
    if (state.failures > 0 || state.isOpen) {
      console.log(`[CircuitBreaker] ${name}: Circuit CLOSED (recovered)`);
    }
    state.failures = 0;
    state.isOpen = false;
    return result;
  } catch (err) {
    state.failures++;
    state.lastFailure = Date.now();

    if (state.failures >= failureThreshold) {
      state.isOpen = true;
      state.openedAt = Date.now();
      console.warn(`[CircuitBreaker] ${name}: Circuit OPENED after ${state.failures} failures`);
      
      await logHealingAction({
        subsystem: "network",
        issue: `Circuit breaker ${name} opened after ${state.failures} consecutive failures`,
        classification: classifyError(err),
        diagnosis: err instanceof Error ? err.message : String(err),
        actionTaken: `Circuit opened for ${resetTimeoutMs / 1000}s`,
        result: "fallback",
        mttrSeconds: 0,
        runId: null,
      });
    }

    if (fallback) return fallback();
    throw err;
  }
}

// ─── Health Check (from self-healing-agent) ──────────────────────────────────

export interface HealthStatus {
  overall: "healthy" | "degraded" | "unhealthy";
  subsystems: {
    name: string;
    status: "healthy" | "degraded" | "unhealthy";
    details: string;
  }[];
  recentHeals: number;
  lastHealAt: string | null;
}

export async function checkHealth(): Promise<HealthStatus> {
  const db = await getDb();
  const subsystems: HealthStatus["subsystems"] = [];

  // Check DB connectivity
  try {
    if (db) {
      await db.execute("SELECT 1");
      subsystems.push({ name: "database", status: "healthy", details: "Connected" });
    } else {
      subsystems.push({ name: "database", status: "unhealthy", details: "No connection" });
    }
  } catch (err) {
    subsystems.push({ name: "database", status: "unhealthy", details: err instanceof Error ? err.message : "Unknown error" });
  }

  // Check circuit breakers
  for (const [name, state] of Array.from(circuits.entries())) {
    if (state.isOpen) {
      subsystems.push({ name: `circuit:${name}`, status: "degraded", details: `Open since ${new Date(state.openedAt).toISOString()}` });
    } else if (state.failures > 0) {
      subsystems.push({ name: `circuit:${name}`, status: "degraded", details: `${state.failures} recent failures` });
    } else {
      subsystems.push({ name: `circuit:${name}`, status: "healthy", details: "Closed" });
    }
  }

  // Check NYT API key
  if (process.env.NYT_API_KEY) {
    subsystems.push({ name: "nyt_api", status: "healthy", details: "Key configured" });
  } else {
    subsystems.push({ name: "nyt_api", status: "unhealthy", details: "Key missing" });
  }

  // Get recent healing actions
  let recentHeals = 0;
  let lastHealAt: string | null = null;
  try {
    if (db) {
      const { desc } = await import("drizzle-orm");
      const recent = await db
        .select()
        .from(healingLog)
        .orderBy(desc(healingLog.createdAt))
        .limit(1);
      if (recent.length > 0) {
        lastHealAt = recent[0].createdAt.toISOString();
      }

      // Count heals in last 24h
      const { sql } = await import("drizzle-orm");
      const countResult = await db.execute(
        sql`SELECT COUNT(*) as cnt FROM healing_log WHERE createdAt > DATE_SUB(NOW(), INTERVAL 24 HOUR)`
      );
      recentHeals = (countResult as any)[0]?.[0]?.cnt ?? 0;
    }
  } catch {
    // Non-fatal
  }

  // Determine overall status
  const hasUnhealthy = subsystems.some(s => s.status === "unhealthy");
  const hasDegraded = subsystems.some(s => s.status === "degraded");
  const overall = hasUnhealthy ? "unhealthy" : hasDegraded ? "degraded" : "healthy";

  return { overall, subsystems, recentHeals, lastHealAt };
}

// ─── Utility ─────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
