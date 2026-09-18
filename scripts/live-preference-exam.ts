/**
 * Live examination: seed preferences + stack facts, then ask the real upstream
 * questions that require memory recall. Secrets stay in env — never printed.
 *
 * Run:
 *   export $(grep -E '^(DATABASE_URL|REDIS_URL|UPSTREAM)' .env | xargs)
 *   bun run scripts/live-preference-exam.ts
 */
import app from "../src/index";
import { createTestDb, createTestContextStore } from "../tests/helpers/db";
import { archiveRequest } from "../src/storage/archive";
import { listMemoryItems } from "../src/memory/state";
import { runConsolidationPass } from "../src/memory/consolidator";
import { compileContext } from "../src/context/compiler";
import { MemoryStatus } from "../src/models/memory";

const MODEL = process.env.LIVE_MODEL || "deepseek-v4-flash-0731";
const USER = `live-exam-${Date.now()}`;

function liveEnv() {
  return {
    UPSTREAM_PROVIDER: process.env.UPSTREAM_PROVIDER,
    UPSTREAM_BASE_URL: process.env.UPSTREAM_BASE_URL,
    UPSTREAM_API_KEY: process.env.UPSTREAM_API_KEY,
    DATABASE_URL: process.env.DATABASE_URL,
    REDIS_URL: process.env.REDIS_URL,
    d
    CONTEXT_BUDGET: "8000",
    MEMORY_AI_ENABLED: "false",
  };
}

function redact(s: string): string {
  return s.replace(/progga_[A-Za-z0-9]+/g, "progga_[REDACTED]");
}

async function ask(question: string, compiledMessages: Array<Record<string, any>>) {
  const res = await app.request(
    "/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer 1234",
      },
      body: JSON.stringify({
        model: MODEL,
        messages: compiledMessages,
        max_tokens: 80,
        temperature: 0,
      }),
    },
    liveEnv()
  );
  const raw = await res.text();
  if (res.status !== 200) {
    throw new Error(`Upstream HTTP ${res.status}: ${redact(raw).slice(0, 400)}`);
  }
  const data = JSON.parse(raw) as any;
  return String(data?.choices?.[0]?.message?.content || "").trim();
}

async function main() {
  for (const k of ["UPSTREAM_API_KEY", "DATABASE_URL", "UPSTREAM_BASE_URL"]) {
    if (!process.env[k]) {
      console.error(`Missing ${k}. Source .env first.`);
      process.exit(1);
    }
  }

  console.log(`\n=== Live preference / consolidation exam ===`);
  console.log(`model=${MODEL}  user=${USER}\n`);

  const db = await createTestDb();
  const ctx = createTestContextStore();

  const stores = [
    "I love red",
    "I prefer TypeScript",
    "I prefer Neon over PlanetScale",
    "I prefer Cloudflare Workers",
    "I prefer Hono",
  ];

  for (const content of stores) {
    await archiveRequest(db, { messages: [{ role: "user", content }] }, { userId: USER, contextStore: ctx });
    console.log(`stored: ${content}`);
  }

  await runConsolidationPass(db, USER);

  const active = await listMemoryItems(db, USER, MemoryStatus.ACTIVE);
  console.log(`\nactive memories (${active.length}):`);
  for (const m of active) {
    console.log(
      `  - [${m.type}] ${m.subject}.${m.predicate}=${(m.value || m.content).slice(0, 80)}  topic=${m.topicKey}`
    );
  }

  const questions = [
    "What is my favourite colour? Answer in one short sentence.",
    "What programming language do I prefer? One short sentence.",
    "What is my tech stack? List language, database, runtime, and framework briefly.",
  ];

  console.log(`\n--- Asking live upstream ---\n`);

  for (const q of questions) {
    const compiled = await compileContext(db, [{ role: "user", content: q }], USER, {
      budget: 4000,
      contextStore: ctx,
      persistSnapshot: false,
    });
    const injected = compiled.messages
      .filter((m) => m.role === "system")
      .map((m) => String(m.content))
      .join("\n")
      .slice(0, 500);

    console.log(`Q: ${q}`);
    console.log(`  (compiled system snippet): ${injected.replace(/\s+/g, " ").slice(0, 220)}…`);
    const answer = await ask(q, compiled.messages as Array<Record<string, any>>);
    console.log(`A: ${answer}\n`);
  }

  // Negative control: reaction noise should not have been stored
  await archiveRequest(
    db,
    { messages: [{ role: "user", content: "I love this response" }] },
    { userId: USER, contextStore: ctx }
  );
  const afterNoise = await listMemoryItems(db, USER, MemoryStatus.ACTIVE);
  const noiseHit = afterNoise.some(
    (m) =>
      (m.value || m.content).toLowerCase().includes("this response") ||
      (m.predicate || "").includes("this_response")
  );
  console.log(`noise check "I love this response" stored? ${noiseHit ? "FAIL (stored)" : "PASS (not stored)"}`);
  console.log(`\n=== done ===\n`);
}

main().catch((err) => {
  console.error(redact(String(err?.stack || err)));
  process.exit(1);
});
