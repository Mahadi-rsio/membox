/**
 * Live exam with larger memory context + complex multi-hop questions.
 *
 *   export $(grep -E '^(DATABASE_URL|REDIS_URL|UPSTREAM)' .env | xargs)
 *   bun run scripts/live-complex-exam.ts
 */
import app from "../src/index";
import { createTestDb, createTestContextStore } from "../tests/helpers/db";
import { archiveRequest } from "../src/storage/archive";
import { listMemoryItems } from "../src/memory/state";
import { runConsolidationPass } from "../src/memory/consolidator";
import { compileContext } from "../src/context/compiler";
import { MemoryStatus } from "../src/models/memory";

const MODEL = process.env.LIVE_MODEL || "deepseek-v4-flash-0731";
const USER = `live-complex-${Date.now()}`;

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
  return s
    .replace(/progga_[A-Za-z0-9]+/g, "progga_[REDACTED]")
    .replace(/postgresql:\/\/[^\s"']+/gi, "postgresql://[REDACTED]");
}

async function store(db: any, ctx: any, content: string) {
  await archiveRequest(
    db,
    { messages: [{ role: "user", content }] },
    { userId: USER, contextStore: ctx }
  );
  console.log(`  + ${content}`);
}

async function ask(compiledMessages: Array<Record<string, any>>, maxTokens = 180) {
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
        max_tokens: maxTokens,
        temperature: 0,
      }),
    },
    liveEnv()
  );
  const raw = await res.text();
  if (res.status !== 200) {
    throw new Error(`Upstream HTTP ${res.status}: ${redact(raw).slice(0, 500)}`);
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

  console.log(`\n=== Live COMPLEX context exam ===`);
  console.log(`model=${MODEL}`);
  console.log(`user=${USER}\n`);

  const db = await createTestDb();
  const ctx = createTestContextStore();

  console.log("--- Seeding durable identity / prefs / stack / project ---");
  await store(db, ctx, "My name is Mahadi");
  await store(db, ctx, "I love blue");
  await store(db, ctx, "I hate verbose code");
  await store(db, ctx, "I prefer TypeScript");
  await store(db, ctx, "I prefer Neon over PlanetScale");
  await store(db, ctx, "I prefer Cloudflare Workers");
  await store(db, ctx, "I prefer Hono");
  await store(db, ctx, "I am building an AI Memory Gateway called Remember");
  await store(db, ctx, "Remember uses Drizzle ORM for its database layer");
  await store(db, ctx, "Remember's architecture is a Cloudflare Workers proxy with short-term Redis and long-term Neon");
  await store(db, ctx, "We decided the client only changes base_url — no MCP or custom SDK");
  await store(db, ctx, "Our goal is to keep compiled context under an 8000 token budget");

  console.log("\n--- Correction + supersede ---");
  await store(db, ctx, "I love green now"); // supersedes blue
  await store(db, ctx, "We switched Remember to use Upstash Redis for caching");

  console.log("\n--- Transient / short-term ---");
  await store(db, ctx, "I'm currently debugging a 500 error in the Redis context store");
  await store(db, ctx, "Right now I'm working on the consolidation engine");

  await runConsolidationPass(db, USER);

  const active = await listMemoryItems(db, USER, MemoryStatus.ACTIVE);
  const superseded = await listMemoryItems(db, USER, MemoryStatus.SUPERSEDED);
  const shortTerm = await ctx.getAllContext(USER);

  console.log(`\nmemory snapshot:`);
  console.log(`  active=${active.length}  superseded=${superseded.length}  shortTerm=${shortTerm.length}`);
  for (const m of active) {
    const val = (m.value || m.content).replace(/\s+/g, " ").slice(0, 90);
    console.log(`  [ACTIVE ${m.type}] ${m.subject}.${m.predicate} = ${val}`);
  }
  for (const m of superseded.slice(0, 6)) {
    console.log(`  [SUPERSEDED] ${m.predicate || m.topicKey} = ${(m.value || m.content).slice(0, 50)}`);
  }
  if (superseded.length > 6) console.log(`  … +${superseded.length - 6} more superseded`);
  for (const e of shortTerm) {
    console.log(`  [CONTEXT ${e.key}] ${String(e.value).slice(0, 70)}`);
  }

  const questions: Array<{ q: string; expectHints: string[]; maxTokens?: number }> = [
    {
      q: "Who am I, what colour do I currently like, and what colour did I used to like? Be precise about current vs old.",
      expectHints: ["mahadi", "green"],
      maxTokens: 120,
    },
    {
      q: "First: what coding style do I explicitly dislike? Then recommend database + runtime for a new Workers app from my lasting preferences and Remember's architecture, and say why.",
      expectHints: ["verbose", "neon", "cloudflare"],
      maxTokens: 280,
    },
    {
      q: "Summarize my current debugging situation AND how it relates to Remember's short-term vs long-term memory design. Then say whether Neon or PlanetScale is my preferred database now.",
      expectHints: ["500", "redis", "neon"],
      maxTokens: 220,
    },
    {
      q: "If you had to introduce Remember to a new engineer in 4 bullets: product purpose, stack, client integration rule, and active context budget goal — use ONLY stored memory, do not invent.",
      expectHints: ["remember", "base", "8000"],
      maxTokens: 220,
    },
  ];

  console.log(`\n--- Complex live questions ---\n`);

  let pass = 0;
  let fail = 0;

  for (const item of questions) {
    const compiled = await compileContext(
      db,
      [{ role: "user", content: item.q }],
      USER,
      { budget: 8000, contextStore: ctx, persistSnapshot: false }
    );

    const systemBlob = compiled.messages
      .filter((m) => m.role === "system")
      .map((m) => String(m.content))
      .join("\n");
    const tokenish = systemBlob.length;
    const hasShort = /short-term context/i.test(systemBlob);

    console.log(`Q: ${item.q}`);
    console.log(
      `  compiled: messages=${compiled.messages.length} canonical=${compiled.canonicalItemsUsed} shortTerm=${compiled.shortTermItemsUsed} systemChars≈${tokenish} hasShortTermBlock=${hasShort}`
    );
    console.log(`  system preview: ${systemBlob.replace(/\s+/g, " ").slice(0, 280)}…`);

    const answer = await ask(compiled.messages as Array<Record<string, any>>, item.maxTokens ?? 180);
    console.log(`A: ${answer}\n`);

    const lower = answer.toLowerCase();
    const hits = item.expectHints.filter((h) => lower.includes(h.toLowerCase()));
    const ok = hits.length === item.expectHints.length;
    if (ok) {
      pass++;
      console.log(`  VERDICT: PASS (hit ${hits.join(", ")})\n`);
    } else {
      fail++;
      console.log(
        `  VERDICT: PARTIAL/FAIL (hit [${hits.join(", ")}] missing [${item.expectHints
          .filter((h) => !hits.includes(h))
          .join(", ")}])\n`
      );
    }
  }

  console.log(`=== summary: ${pass} pass / ${fail} miss of ${questions.length} ===\n`);
  process.exit(fail > 0 ? 2 : 0);
}

main().catch((err) => {
  console.error(redact(String(err?.stack || err)));
  process.exit(1);
});
