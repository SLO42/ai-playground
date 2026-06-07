// S0 — SurrealDB de-risking spike (IMPLEMENTATION-PLAN §3 / DATA-MODEL).
// Connects to a RUNNING SurrealDB server over ws:// (start it first — see run-s0.txt).
// Verifies: SDK connect, HNSW index (DIMENSION 1024 DIST COSINE — NO M0), Ollama
// 1024-dim embeddings, <|K,EF|> KNN, transaction rollback, optimistic claim-token race.
import { Surreal } from "surrealdb";

const SURREAL_URL = process.env.SURREAL_URL || "ws://127.0.0.1:8000/rpc";
const SURREAL_USER = process.env.SURREAL_USER || "root";
const SURREAL_PASS = process.env.SURREAL_PASS || "root";
let OLLAMA = process.env.OLLAMA_HOST || "http://127.0.0.1:11434";
if (!/^https?:\/\//.test(OLLAMA)) OLLAMA = "http://" + OLLAMA;   // OLLAMA_HOST may be host:port only
OLLAMA = OLLAMA.replace("0.0.0.0", "127.0.0.1");                 // 0.0.0.0 isn't a connectable client host
const EMBED_MODEL = process.env.EMBED_MODEL || "qwen3-embedding:0.6b";

const results = [];
const ok = (name, pass, detail = "") => { results.push({ name, pass, detail }); console.log(`${pass ? "✓ PASS" : "✗ FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };

async function embed(text) {
  const r = await fetch(`${OLLAMA}/api/embed`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input: text }),
  });
  if (!r.ok) throw new Error(`ollama ${r.status}: ${await r.text()}`);
  const j = await r.json();
  return (j.embeddings && j.embeddings[0]) || j.embedding;
}

const db = new Surreal();
try {
  // 1. Connect + auth + use ns/db
  await db.connect(SURREAL_URL);
  await db.signin({ username: SURREAL_USER, password: SURREAL_PASS });
  await db.use({ namespace: "spike", database: "s0" });
  ok("connect + signin + use (ws://)", true, SURREAL_URL);

  // 2. Ollama embeddings — confirm 1024-dim
  const vecs = await Promise.all([
    "the orchestrator spawns a claude code session",
    "surrealdb stores vectors with an hnsw index",
    "the cat sat on the mat",
  ].map(embed));
  const dim = vecs[0]?.length;
  ok(`Ollama ${EMBED_MODEL} embeddings = 1024-dim`, dim === 1024, `got ${dim}`);

  // 3. Schema + HNSW index (NO M0 — invalid in 2.x)
  await db.query(`
    DEFINE TABLE memtest SCHEMALESS;
    DEFINE FIELD content   ON memtest TYPE string;
    DEFINE FIELD embedding ON memtest TYPE array<float>;
    DEFINE INDEX mt_vec ON memtest FIELDS embedding HNSW DIMENSION 1024 DIST COSINE TYPE F32 EFC 150 M 12;
  `);
  ok("HNSW index DEFINE (DIMENSION 1024 DIST COSINE, no M0)", true);

  // 4. Insert vectors
  const texts = ["orchestrator spawns a claude code session", "surrealdb hnsw vector index", "the cat sat on the mat"];
  for (let i = 0; i < texts.length; i++) {
    await db.query("CREATE memtest SET content = $c, embedding = $e", { c: texts[i], e: vecs[i] });
  }
  ok("insert 3 rows with embeddings", true);

  // 5. KNN query (<|K,EF|> index ANN) — nearest to the orchestrator query
  const q = await embed("which agent runs the claude code work");
  const knn = await db.query(
    "SELECT content, vector::distance::knn() AS dist FROM memtest WHERE embedding <|2,40|> $q ORDER BY dist",
    { q }
  );
  const rows = knn[0] || [];
  const top = rows[0]?.content || "";
  ok("KNN <|2,40|> returns ranked rows", rows.length === 2 && typeof rows[0]?.dist === "number", `top="${top}" dist=${rows[0]?.dist?.toFixed?.(4)}`);
  ok("KNN nearest is the semantically-closest row", /orchestrator|claude code session/i.test(top), `top="${top}"`);

  // 6. Transaction rollback (CANCEL → no write persists)
  const before = (await db.query("SELECT count() AS n FROM memtest GROUP ALL"))[0]?.[0]?.n ?? 0;
  await db.query("BEGIN; CREATE memtest SET content = 'rolled-back', embedding = $e; CANCEL;", { e: vecs[2] }).catch(() => {});
  const after = (await db.query("SELECT count() AS n FROM memtest GROUP ALL"))[0]?.[0]?.n ?? 0;
  ok("transaction CANCEL rolls back (count unchanged)", before === after, `before=${before} after=${after}`);

  // 7. Optimistic claim-token race (MEMORY-SPEC §6.6 / D-021) — single winner per row
  await db.query(`
    DEFINE TABLE work SCHEMALESS;
    DEFINE FIELD status      ON work TYPE string DEFAULT 'pending';
    DEFINE FIELD claim_token ON work TYPE option<string>;
  `);
  await db.query("CREATE work:only SET status = 'pending';"); // one claimable row
  const claim = (tok) => db.query(
    "UPDATE work SET status = 'processing', claim_token = $t WHERE status = 'pending' AND claim_token = NONE RETURN AFTER;",
    { t: tok }
  ).then(r => (r[0] || []).length).catch(() => 0);
  const claimers = await Promise.all(Array.from({ length: 8 }, (_, i) => claim(`w${i}`)));
  const winners = claimers.reduce((a, b) => a + b, 0);
  ok("optimistic claim-token: exactly ONE winner of 8 racers", winners === 1, `winners=${winners}`);

  // cleanup
  await db.query("REMOVE TABLE memtest; REMOVE TABLE work;").catch(() => {});
} catch (e) {
  ok("S0 spike completed without throw", false, String(e?.message || e));
} finally {
  await db.close().catch(() => {});
}

const failed = results.filter(r => !r.pass);
console.log(`\nS0 RESULT: ${results.length - failed.length}/${results.length} passed.`);
if (failed.length) { console.log("FAILED:", failed.map(f => f.name).join("; ")); process.exit(1); }
console.log("S0 PASS — SurrealDB server-binary path viable on this box.");
