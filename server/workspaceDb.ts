/**
 * Workspace DB helpers — Phase A Foundation
 * Karpathy: simple functions, no class hierarchy, no typed credential interface yet.
 */
import { eq, and, or } from "drizzle-orm";
import { getDb } from "./db";
import { workspaces, workspaceCredentials } from "../drizzle/schema";
import type { Workspace, InsertWorkspace } from "../drizzle/schema";
import { nanoid } from "nanoid";

export async function getWorkspaceById(id: string): Promise<Workspace | null> {
  const db = await getDb();
  if (!db) return null;
  const rows = await db.select().from(workspaces).where(eq(workspaces.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function getWorkspaceBySlug(slug: string): Promise<Workspace | null> {
  const db = await getDb();
  if (!db) return null;
  const rows = await db.select().from(workspaces).where(eq(workspaces.slug, slug)).limit(1);
  return rows[0] ?? null;
}

export async function getWorkspacesByOwner(ownerId: string): Promise<Workspace[]> {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(workspaces).where(eq(workspaces.ownerId, ownerId));
}

/** Get all workspaces visible to a user: those they own + the system-owned defaults. */
export async function getWorkspacesForUser(userId: string): Promise<Workspace[]> {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(workspaces).where(
    or(eq(workspaces.ownerId, userId), eq(workspaces.ownerId, "system"))
  );
}

export async function createWorkspace(
  input: Pick<InsertWorkspace, "name" | "slug" | "icon" | "workspaceType" | "ownerId"> & { nicheProfile?: Record<string, unknown> }
): Promise<Workspace> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const id = nanoid();
  await db.insert(workspaces).values({ ...input, id });
  const created = await getWorkspaceById(id);
  if (!created) throw new Error("Failed to create workspace");
  return created;
}

export async function updateWorkspace(
  id: string,
  fields: Partial<Pick<InsertWorkspace, "name" | "icon" | "pipelineConfig" | "nicheProfile" | "descriptionTemplate" | "styleProfile" | "styleOverride">>
): Promise<Workspace> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.update(workspaces).set(fields).where(eq(workspaces.id, id));
  const updated = await getWorkspaceById(id);
  if (!updated) throw new Error("Workspace not found");
  return updated;
}

/** Simple key-value credential lookup. No typed interface until multiple providers are needed. */
export async function getCredential(
  workspaceId: string,
  provider: string,
  key: string
): Promise<string | null> {
  const db = await getDb();
  if (!db) return null;
  const rows = await db
    .select()
    .from(workspaceCredentials)
    .where(
      and(
        eq(workspaceCredentials.workspaceId, workspaceId),
        eq(workspaceCredentials.provider, provider),
        eq(workspaceCredentials.credKey, key)
      )
    )
    .limit(1);
  return rows[0]?.credValue ?? null;
}

export async function setCredential(
  workspaceId: string,
  provider: string,
  key: string,
  value: string
): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const existing = await getCredential(workspaceId, provider, key);
  if (existing !== null) {
    await db
      .update(workspaceCredentials)
      .set({ credValue: value })
      .where(
        and(
          eq(workspaceCredentials.workspaceId, workspaceId),
          eq(workspaceCredentials.provider, provider),
          eq(workspaceCredentials.credKey, key)
        )
      );
  } else {
    await db.insert(workspaceCredentials).values({
      id: nanoid(),
      workspaceId,
      provider,
      credKey: key,
      credValue: value,
    });
  }
}

/** Delete a workspace and its associated credentials. Does NOT delete scan runs/patterns (orphaned). */
export async function deleteWorkspace(id: string): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  // Delete credentials first
  await db.delete(workspaceCredentials).where(eq(workspaceCredentials.workspaceId, id));
  // Delete workspace
  await db.delete(workspaces).where(eq(workspaces.id, id));
}
