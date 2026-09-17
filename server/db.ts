import { desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { Diagnosis, diagnoses, InsertUser, users } from "../drizzle/schema";
import { ENV } from "./_core/env";

let _db: ReturnType<typeof drizzle> | null = null;

export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) throw new Error("User openId is required for upsert");
  const db = await getDb();
  if (!db) return;

  const values: InsertUser = { openId: user.openId };
  const updateSet: Record<string, unknown> = {};
  const textFields = ["name", "email", "loginMethod"] as const;
  for (const field of textFields) {
    if (user[field] !== undefined) {
      values[field] = user[field] ?? null;
      updateSet[field] = user[field] ?? null;
    }
  }
  if (user.lastSignedIn !== undefined) {
    values.lastSignedIn = user.lastSignedIn;
    updateSet.lastSignedIn = user.lastSignedIn;
  } else {
    values.lastSignedIn = new Date();
    updateSet.lastSignedIn = new Date();
  }
  if (user.role !== undefined) {
    values.role = user.role;
    updateSet.role = user.role;
  } else if (user.openId === ENV.ownerOpenId) {
    values.role = "admin";
    updateSet.role = "admin";
  }
  await db.insert(users).values(values).onDuplicateKeyUpdate({ set: updateSet });
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  return result[0];
}

export async function createDiagnosis(input: {
  userId?: number;
  sessionId: string;
  applianceType: string;
  modelNumber?: string;
  notes?: string;
  diagnosisJson: string;
}) {
  const db = await getDb();
  if (!db) return 0;
  const result = await db.insert(diagnoses).values({
    userId: input.userId,
    sessionId: input.sessionId,
    applianceType: input.applianceType,
    modelNumber: input.modelNumber || null,
    notes: input.notes || null,
    diagnosisJson: input.diagnosisJson,
    repairProgress: "[]",
  });
  return Number((result as unknown as Array<{ insertId: number }>)[0]?.insertId ?? 0);
}

export async function getLatestDiagnosis(sessionId: string): Promise<Diagnosis | undefined> {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db.select().from(diagnoses).where(eq(diagnoses.sessionId, sessionId)).orderBy(desc(diagnoses.createdAt)).limit(1);
  return rows[0];
}

export async function updateDiagnosisProgress(input: { id: number; sessionId: string; completedSteps: number[] }) {
  const db = await getDb();
  if (!db) return;
  await db.update(diagnoses)
    .set({ repairProgress: JSON.stringify(input.completedSteps), updatedAt: new Date() })
    .where(eq(diagnoses.id, input.id));
}
