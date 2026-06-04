/**
 * One-shot script: regenerate ONLY the culturalMap for the pickleball workspace.
 * Split into two LLM calls to avoid response truncation:
 *   Call 1: transferableVisualConcepts + animalMascots (the critical fields)
 *   Call 2: painPoints + funPoints + insideJokes + physicalComedy + catchphrases + lifestyleIdentity + rivalries
 *
 * Run: node scripts/regenerate_pickleball_cultural_map.mjs
 */

import dotenv from 'dotenv';
dotenv.config({ path: '/home/ubuntu/nyt-design-bot/.env' });
import mysql from 'mysql2/promise';

const FORGE_API_URL = process.env.BUILT_IN_FORGE_API_URL;
const FORGE_API_KEY = process.env.BUILT_IN_FORGE_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;

if (!FORGE_API_URL || !FORGE_API_KEY || !DATABASE_URL) {
  console.error('Missing required env vars'); process.exit(1);
}

async function invokeLLM(messages, responseFormat) {
  const resp = await fetch(`${FORGE_API_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${FORGE_API_KEY}` },
    body: JSON.stringify({ messages, response_format: responseFormat }),
    signal: AbortSignal.timeout(120000),
  });
  if (!resp.ok) throw new Error(`LLM HTTP ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  const raw = data.choices?.[0]?.message?.content;
  if (!raw) throw new Error('LLM returned empty response');
  return JSON.parse(raw);
}

// ─── DB ───────────────────────────────────────────────────────────────────────

const conn = await mysql.createConnection(DATABASE_URL);
const [rows] = await conn.execute('SELECT id, name, nicheProfile FROM workspaces WHERE slug = ?', ['pickleball']);
const ws = rows[0];
if (!ws) { console.error('Pickleball workspace not found'); await conn.end(); process.exit(1); }

const existingProfile = typeof ws.nicheProfile === 'string' ? JSON.parse(ws.nicheProfile) : (ws.nicheProfile ?? {});
console.log('Has culturalMap:', !!existingProfile.culturalMap);

// ─── Call 1: transferableVisualConcepts + animalMascots ───────────────────────

console.log('\n[Call 1] Generating transferableVisualConcepts + animalMascots...');

const call1 = await invokeLLM(
  [
    {
      role: 'system',
      content: `You are a print-on-demand niche research expert for the pickleball niche (adults 35-65, suburban).
Return ONLY a JSON object with two keys: "transferableVisualConcepts" and "animalMascots".

transferableVisualConcepts: 6 entries. Each must have:
- sourceNiche (string): where the design comes from, e.g. "hiking"
- sourcePattern (string): specific visual, e.g. "Bigfoot/Sasquatch blowing a dandelion"
- targetAdaptation (string): pickleball replacement, e.g. "Llama blowing a dandelion"
- whyItTransfers (string): why pickleball buyers love it

REQUIRED entries (use these exact sourcePatterns):
1. sourcePattern: "Bigfoot/Sasquatch blowing a dandelion" → targetAdaptation: "Llama blowing a dandelion"
2. sourcePattern: "Bear hiking with a backpack" → targetAdaptation: "Llama with a pickleball paddle"
3. sourcePattern: "Skeleton holding a fishing rod" → targetAdaptation: "Skeleton playing pickleball"
4. sourcePattern: "Cat doing yoga poses" → targetAdaptation: "Cat in pickleball poses (serving, dinking, volleying)"
5. sourcePattern: "Dog with hiking gear" → targetAdaptation: "Dog with pickleball gear"
6. sourcePattern: "Retro cowboy/western character" → targetAdaptation: "Retro pickleball player in vintage athletic style"

animalMascots: 4 entries with animal, whyItWorks, visualTreatment.`,
    },
    { role: 'user', content: 'Generate transferableVisualConcepts and animalMascots for the pickleball niche.' },
  ],
  {
    type: 'json_schema',
    json_schema: {
      name: 'call1_result',
      strict: true,
      schema: {
        type: 'object',
        properties: {
          transferableVisualConcepts: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                sourceNiche: { type: 'string' },
                sourcePattern: { type: 'string' },
                targetAdaptation: { type: 'string' },
                whyItTransfers: { type: 'string' },
              },
              required: ['sourceNiche', 'sourcePattern', 'targetAdaptation', 'whyItTransfers'],
              additionalProperties: false,
            },
          },
          animalMascots: {
            type: 'array',
            items: {
              type: 'object',
              properties: { animal: { type: 'string' }, whyItWorks: { type: 'string' }, visualTreatment: { type: 'string' } },
              required: ['animal', 'whyItWorks', 'visualTreatment'],
              additionalProperties: false,
            },
          },
        },
        required: ['transferableVisualConcepts', 'animalMascots'],
        additionalProperties: false,
      },
    },
  }
);

console.log('transferableVisualConcepts count:', call1.transferableVisualConcepts?.length);
call1.transferableVisualConcepts?.forEach((c, i) => {
  console.log(`  ${i + 1}. [${c.sourceNiche}] "${c.sourcePattern}" → "${c.targetAdaptation}"`);
});

// ─── Call 2: remaining cultural map fields ────────────────────────────────────

console.log('\n[Call 2] Generating painPoints, insideJokes, catchphrases, etc...');

const call2 = await invokeLLM(
  [
    {
      role: 'system',
      content: `You are a print-on-demand niche research expert for the pickleball niche (adults 35-65, suburban).
Return ONLY a JSON object with these keys: painPoints, funPoints, insideJokes, physicalComedy, catchphrases, lifestyleIdentity, rivalries.

- painPoints: 4 entries {pain, humorAngle}
- funPoints: 3 entries {joy, visualConcept}
- insideJokes: 4 entries {joke, context}
- physicalComedy: 3 entries {scenario, whyFunny}
- catchphrases: 6 strings (real pickleball community phrases)
- lifestyleIdentity: 3 entries {trait, purchaseDriver}
- rivalries: 2 entries {rivalry, tension, humorAngle}`,
    },
    { role: 'user', content: 'Generate the cultural signals for the pickleball niche.' },
  ],
  {
    type: 'json_schema',
    json_schema: {
      name: 'call2_result',
      strict: true,
      schema: {
        type: 'object',
        properties: {
          painPoints: { type: 'array', items: { type: 'object', properties: { pain: { type: 'string' }, humorAngle: { type: 'string' } }, required: ['pain', 'humorAngle'], additionalProperties: false } },
          funPoints: { type: 'array', items: { type: 'object', properties: { joy: { type: 'string' }, visualConcept: { type: 'string' } }, required: ['joy', 'visualConcept'], additionalProperties: false } },
          insideJokes: { type: 'array', items: { type: 'object', properties: { joke: { type: 'string' }, context: { type: 'string' } }, required: ['joke', 'context'], additionalProperties: false } },
          physicalComedy: { type: 'array', items: { type: 'object', properties: { scenario: { type: 'string' }, whyFunny: { type: 'string' } }, required: ['scenario', 'whyFunny'], additionalProperties: false } },
          catchphrases: { type: 'array', items: { type: 'string' } },
          lifestyleIdentity: { type: 'array', items: { type: 'object', properties: { trait: { type: 'string' }, purchaseDriver: { type: 'string' } }, required: ['trait', 'purchaseDriver'], additionalProperties: false } },
          rivalries: { type: 'array', items: { type: 'object', properties: { rivalry: { type: 'string' }, tension: { type: 'string' }, humorAngle: { type: 'string' } }, required: ['rivalry', 'tension', 'humorAngle'], additionalProperties: false } },
        },
        required: ['painPoints', 'funPoints', 'insideJokes', 'physicalComedy', 'catchphrases', 'lifestyleIdentity', 'rivalries'],
        additionalProperties: false,
      },
    },
  }
);

console.log('catchphrases:', call2.catchphrases?.slice(0, 4).join(', '));

// ─── Merge and patch DB ───────────────────────────────────────────────────────

const culturalMap = { ...call1, ...call2 };
const mergedProfile = { ...existingProfile, culturalMap };

console.log('\nPatching DB...');
await conn.execute('UPDATE workspaces SET nicheProfile = ? WHERE id = ?', [JSON.stringify(mergedProfile), ws.id]);

// Verify
const [verifyRows] = await conn.execute(
  "SELECT JSON_EXTRACT(nicheProfile, '$.culturalMap.transferableVisualConcepts') as tvc FROM workspaces WHERE slug = 'pickleball'"
);
const rawTvc = verifyRows[0]?.tvc;
const tvc = Array.isArray(rawTvc) ? rawTvc : (typeof rawTvc === 'string' ? JSON.parse(rawTvc) : []);
console.log(`\n✅ DB patched. ${tvc.length} transferableVisualConcepts now in DB.`);
tvc.forEach((c, i) => console.log(`  ${i + 1}. "${c.sourcePattern}" → "${c.targetAdaptation}"`));

await conn.end();
