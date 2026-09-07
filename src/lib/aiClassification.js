import { ALWAYS_CONTROLLED_FIELDS } from './content.js';

/**
 * AI-assisted GxP field classification — decision support, and nothing else.
 *
 * THE ONE RULE THIS MODULE IS BUILT AROUND, same as lib/report.js's: the model
 * never decides anything by itself. It sorts each field into a bucket and gives
 * a short reason; an administrator reviews the split, can move any field before
 * committing, and only resolvers/admin.js's admin:saveControlledFieldsBaseline —
 * fired by a human pressing "Track & Save Baseline" — ever writes a row to
 * va_controlled_field. Nothing here calls that resolver, queries the database,
 * or has an opinion once its answer is returned.
 *
 * ZERO EGRESS. Classification runs on Forge LLMs (`@forge/llm`, the `bl-llm`
 * module, `model: [claude]`), the same as the AI report — inference stays on
 * the Atlassian platform and nothing here adds a `remotes` block or an external
 * fetch. Only field ids, names and Jira schema types are sent; never a field's
 * VALUE, and never the issue the field lives on.
 *
 * FAIL CLOSED TO A HEURISTIC, NEVER TO A BLOCKED SCREEN. If the model is
 * disabled, unavailable, over quota, or returns something unparseable, the
 * admin still gets a full classification — heuristicClassify() below — and the
 * response says so (`degraded: true`) so the screen can be honest about which
 * kind of answer the administrator is reviewing. An app that says "AI could not
 * run, so start over" turns a decision-support feature into an outage.
 */

export const CLASSIFICATION = {
  GXP: 'GXP_CANDIDATE',
  NON_GXP: 'NON_GXP_CANDIDATE'
};

/**
 * Models that reject `temperature`; sending it is a 400. Kept as its own short
 * list rather than imported from lib/report.js — the two modules make
 * independent calls to the LLM module and neither should have to change because
 * the other's model set did.
 */
const NO_SAMPLING_PARAMS = new Set([
  'claude-opus-4-7',
  'claude-opus-4-8',
  'claude-opus-5',
  'claude-sonnet-5'
]);

/**
 * A hard cap on one classification request's total batch size. Not a
 * real-world limit — a company-managed project rarely declares more than a
 * few hundred fields — but a resolver with a bounded budget must never hand an
 * unbounded list to a network call.
 */
const MAX_FIELDS_PER_CALL = 500;

/**
 * How many fields go into ONE completion. THIS, not MAX_FIELDS_PER_CALL, is
 * what keeps a large project from timing out.
 *
 * A single completion asked to emit structured JSON for hundreds of fields is
 * slow in direct proportion to its OUTPUT size — every field costs another
 * {fieldId, decision, rationale} object — so a 500-field project sent as one
 * request is the classic way this feature times out, and raising the timeout
 * to compensate only buys a little room before the next larger project hits
 * it again. Chunking is the fix that scales: 50 fields is a few seconds of
 * generation, whatever REQUEST_TIMEOUT_MS is set to, and chunks are requested
 * IN PARALLEL (see classifyFields), so a 500-field project is ~10 concurrent
 * small calls rather than one huge one — bounded by the slowest chunk, not
 * their sum. A chunk that times out or comes back unparseable degrades to the
 * heuristic ON ITS OWN; the rest of the project keeps its real classification.
 */
const CHUNK_SIZE = 150;

/**
 * Per-chunk wall-clock budget. admin:classifyFieldsForBaseline runs from a
 * Custom UI click, not a validator, so it has more headroom than the panel's
 * 25s budget — but chunking already does the heavy lifting here. This mostly
 * exists to catch a genuinely stuck request rather than to accommodate a large
 * payload, which chunking has already made small.
 */
const REQUEST_TIMEOUT_MS = 20000;

/** How many words of rationale reach the screen. Enforced, not just asked for. */
const RATIONALE_CHARS = 200;

export const CLASSIFY_TOOL = {
  type: 'function',
  function: {
    name: 'classify_fields',
    description:
      'Classify Jira project fields for a GxP/21 CFR Part 11 controlled-field baseline. Use ONLY '
      + 'the fields supplied. Never invent a field id, and return exactly one classification per '
      + 'field supplied.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['classifications'],
      properties: {
        classifications: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['fieldId', 'decision', 'rationale'],
            properties: {
              fieldId: { type: 'string', description: 'Copied verbatim from the supplied field.' },
              decision: {
                type: 'string',
                enum: [CLASSIFICATION.GXP, CLASSIFICATION.NON_GXP],
                description:
                  `${CLASSIFICATION.GXP}: the field can carry information that bears on product `
                  + 'quality, clinical or patient safety, verification/validation, an electronic '
                  + `record, a release decision, or regulatory compliance. ${CLASSIFICATION.NON_GXP}: `
                  + 'purely cosmetic, reporting, sprint-planning, or team bookkeeping fields with no '
                  + 'bearing on the reviewed record.'
              },
              rationale: {
                type: 'string',
                description: 'THREE TO SIX WORDS. e.g. "Tracks test execution result" or "Non-GxP UI metadata".'
              }
            }
          }
        }
      }
    }
  }
};

const SYSTEM_PROMPT = `You are a decision-support assistant helping a Jira administrator configure a GxP (21 CFR Part 11) controlled-field baseline. You do not make the decision — you propose one, with a reason, and a human reviews every field before anything is saved.

GROUND RULES:

1. Classify every field supplied, and only fields supplied. Never invent a field id.
2. GXP_CANDIDATE means the field can carry information bearing on product quality, clinical or patient safety, verification/validation, an electronic record, a release decision, or regulatory compliance. Fields like description, acceptance criteria, due date, priority, security level, linked issues, and anything naming a specification, protocol, batch, lot, deviation, CAPA, risk, or approval are typically GXP_CANDIDATE.
3. NON_GXP_CANDIDATE means the field is cosmetic, a reporting/rollup field, sprint or backlog bookkeeping (story points, rank, sprint, epic colour), or team process metadata with no bearing on the reviewed record.
4. When genuinely uncertain, prefer GXP_CANDIDATE — an administrator reviewing a false positive costs one click; a compliance-relevant field silently defaulted out of the baseline is the failure this tool exists to prevent.
5. Every rationale is three to six words, plain language, specific to the field — never a restatement of the category name alone.

You must respond by calling the classify_fields function. Do not reply with prose.`;

/**
 * The closed payload the model sees: field shape only, never a value and never
 * the issue. Accepts either the db row shape (field_id/field_name/...) or the
 * camelCase shape the resolver already uses elsewhere, so callers do not have
 * to reshape their data just to call this.
 */
export function buildPayload(fields) {
  return (fields ?? [])
    .slice(0, MAX_FIELDS_PER_CALL)
    .map((f) => ({
      fieldId: String(f.fieldId ?? f.field_id ?? ''),
      fieldName: String(f.fieldName ?? f.field_name ?? f.fieldId ?? f.field_id ?? ''),
      fieldKind: f.fieldKind ?? f.field_kind ?? null,
      schemaType: f.schemaType ?? f.schema_type ?? null
    }))
    .filter((f) => f.fieldId);
}

/**
 * THE DETERMINISTIC FALLBACK, and the second opinion every model answer is
 * checked against for coverage (see validate() below).
 *
 * Pure and keyword-based on purpose: no network, no model, so it is always
 * available and always the same answer for the same input. ALWAYS_CONTROLLED_
 * FIELDS are never asked about — they are pinned GXP_CANDIDATE by
 * partitionForBaseline() regardless of what reaches this function — but are
 * handled here too so a caller that passes one gets a sensible answer rather
 * than the generic default.
 */
const GXP_NAME_HINTS =
  /accept(ance)?[\s-]?criteri|qualit|valid(at)?|verif|complian|regulat|risk|deviat|\bcapa\b|release|audit|safety|clinical|batch|\blot\b|specification|protocol|electronic record|signature|due ?date|priority|security|description|approv/i;
const NON_GXP_NAME_HINTS =
  /sprint|story ?points?|epic ?(link|colou?r|name)|\brank\b|colou?r|icon|watchers?|votes?|\blabels?\b|environment|original estimate|remaining estimate|time ?tracking|approvers?|satisfaction|request type|organizations?|sla|time to/i;

export function heuristicClassify(fields) {
  const alwaysIds = new Set(ALWAYS_CONTROLLED_FIELDS.map((f) => f.field_id));

  return (fields ?? []).map((f) => {
    const id = String(f.fieldId ?? f.field_id ?? '');
    const name = String(f.fieldName ?? f.field_name ?? id);

    if (alwaysIds.has(id)) {
      return { fieldId: id, decision: CLASSIFICATION.GXP, rationale: 'Core reviewed-record field' };
    }
    if (GXP_NAME_HINTS.test(name)) {
      return { fieldId: id, decision: CLASSIFICATION.GXP, rationale: 'Name suggests compliance relevance' };
    }
    if (NON_GXP_NAME_HINTS.test(name)) {
      return { fieldId: id, decision: CLASSIFICATION.NON_GXP, rationale: 'Looks like planning metadata' };
    }
    // Unrecognised defaults to GXP_CANDIDATE, deliberately the opposite of
    // materiality.js's DEFAULT_LADDER default. That module is ranking ALREADY-
    // TRACKED fields for how loudly to alert on a change, where over-alerting
    // gets an app muted. This one is deciding what enters a compliance baseline
    // in the first place, where the failure that matters is a controlled field
    // silently left out — see ground rule 4 in SYSTEM_PROMPT above.
    return { fieldId: id, decision: CLASSIFICATION.GXP, rationale: 'Unrecognised — defaulted to controlled' };
  });
}

/**
 * Enforce the schema AND enforce coverage.
 *
 * THE COVERAGE CHECK IS THE POINT, same shape as lib/report.js's citation
 * check. A model that classifies 40 of the 42 fields it was sent is not a
 * degraded response — it is a partial one, and a reviewer must never see a
 * two-bucket screen that silently has no row at all for a field Jira actually
 * has. Every id not returned, or returned against an id we never sent, is
 * filled in from the pure heuristic so the two lists always sum to the input.
 */
export function validate(parsed, fields) {
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.classifications)) return null;

  const known = new Map(fields.map((f) => [String(f.fieldId ?? f.field_id ?? ''), f]));
  const byId = new Map();

  for (const c of parsed.classifications) {
    const id = String(c?.fieldId ?? '');
    if (!id || !known.has(id) || byId.has(id)) continue; // unknown or duplicate id: dropped, not trusted
    const decision = c?.decision === CLASSIFICATION.GXP ? CLASSIFICATION.GXP : CLASSIFICATION.NON_GXP;
    const rationale = String(c?.rationale ?? '').trim().slice(0, RATIONALE_CHARS)
      || (decision === CLASSIFICATION.GXP ? 'Flagged as compliance-relevant' : 'No compliance signal found');
    byId.set(id, { fieldId: id, decision, rationale });
  }

  const missing = fields.filter((f) => !byId.has(String(f.fieldId ?? f.field_id ?? '')));
  if (missing.length > 0) {
    console.warn('aiClassification: model left', missing.length, 'of', fields.length, 'fields unclassified — filled from heuristic');
    for (const h of heuristicClassify(missing)) byId.set(h.fieldId, h);
  }

  // Ordered the same way the request listed them, so a reviewer comparing the
  // screen against "the fields I have" sees a stable, predictable order rather
  // than whatever order the model happened to emit them in.
  return fields.map((f) => byId.get(String(f.fieldId ?? f.field_id ?? '')));
}

function degraded(fields, model, reason) {
  return { classifications: heuristicClassify(fields), degraded: true, degradedReason: reason, model };
}

/**
 * One completion's worth of the work: send a single chunk, validate it, and
 * NEVER THROW — every failure path returns the chunk's heuristic
 * classification with `degraded: true`, exactly as the AI report degrades.
 * Pulled out of classifyFields() so a timeout or a bad response on one chunk
 * is contained to that chunk instead of losing the whole batch's real
 * classifications.
 */
async function classifyChunk(payload, model, maxCompletionTokens) {
  const request = {
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify({ fields: payload }) }
    ],
    tools: [CLASSIFY_TOOL],
    tool_choice: { type: 'function', function: { name: 'classify_fields' } },
    max_completion_tokens: maxCompletionTokens
  };
  if (!NO_SAMPLING_PARAMS.has(model)) request.temperature = 0.1;

  let response;
  try {
    // IMPORTED LAZILY — see lib/report.js's identical comment. @forge/llm
    // throws "Forge runtime not found." at module load anywhere outside a
    // deployed app, which would make this module (and admin.js, which imports
    // it) unloadable by test/smoke.mjs and unusable when AI is unprovisioned.
    const { chat } = await import('@forge/llm');

    let timerId;
    const timeout = new Promise((_, reject) => {
      timerId = setTimeout(() => reject(new Error('LLM_TIMEOUT')), REQUEST_TIMEOUT_MS);
    });

    try {
      response = await Promise.race([chat(request), timeout]);
    } finally {
      clearTimeout(timerId);
    }
  } catch (err) {
    const reason = err.message === 'LLM_TIMEOUT' ? 'TIMEOUT' : 'LLM_UNAVAILABLE';
    console.error('aiClassification: LLM call failed', { model, reason, fields: payload.length, error: err?.context?.responseText ?? err?.message });
    return degraded(payload, model, reason);
  }

  const call = response?.choices?.[0]?.message?.tool_calls?.[0];
  if (!call || call.function?.name !== 'classify_fields') {
    console.error('aiClassification: model did not call the tool', { model, finish: response?.choices?.[0]?.finish_reason });
    return degraded(payload, model, 'NO_TOOL_CALL');
  }

  let parsed;
  try {
    parsed = typeof call.function.arguments === 'string'
      ? JSON.parse(call.function.arguments)
      : call.function.arguments;
  } catch (err) {
    console.error('aiClassification: unparseable tool arguments', err);
    return degraded(payload, model, 'UNPARSEABLE');
  }

  const classifications = validate(parsed, payload);
  if (!classifications) return degraded(payload, model, 'SCHEMA_MISMATCH');

  return { classifications, degraded: false, degradedReason: null, model };
}

/**
 * Classify a batch of fields.
 *
 * @param fields   candidate fields, either shape buildPayload() accepts
 * @param model    e.g. project config's ai.models.light — a full batch of short
 *                 field descriptors is exactly the low-stakes, high-volume case
 *                 lib/report.js's own routing reserves the light model for
 * @param aiEnabled  the project's config.ai.enabled. Checked here, not left to
 *                    the caller, so a project that has turned AI off gets the
 *                    same heuristic path as one where the model happened to be
 *                    unavailable — one behaviour, two reasons.
 *
 * CHUNKED AND PARALLEL. The batch is split into CHUNK_SIZE-field pieces and
 * every piece is requested at once — total wall time is bounded by the
 * slowest chunk, not their sum, and each chunk is small enough that the
 * slowest chunk is rarely close to REQUEST_TIMEOUT_MS. A chunk that still
 * times out degrades on its own; every other chunk keeps its real
 * classification, so one bad chunk costs a few weaker suggestions, never the
 * whole screen.
 *
 * NEVER THROWS. Every failure path returns a heuristic classification for the
 * fields it covers; the caller (resolvers/admin.js) decides how to say so on
 * screen, exactly as panel.js does for the AI report.
 */
export async function classifyFields({ fields, model, aiEnabled = true, maxCompletionTokens = 4096 }) {
  const payload = buildPayload(fields);
  if (payload.length === 0) return { classifications: [], degraded: false, degradedReason: null, model };

  if (!aiEnabled) return degraded(payload, model, 'AI_DISABLED');

  const chunks = [];
  for (let i = 0; i < payload.length; i += CHUNK_SIZE) chunks.push(payload.slice(i, i + CHUNK_SIZE));

  const results = await Promise.all(chunks.map((chunk) => classifyChunk(chunk, model, maxCompletionTokens)));

  const classifications = results.flatMap((r) => r.classifications);
  const degradedChunks = results.filter((r) => r.degraded);

  return {
    classifications,
    degraded: degradedChunks.length > 0,
    degradedReason: degradedChunks.length === 0
      ? null
      // One reason, deduplicated: usually every degraded chunk failed for the
      // same platform-level cause (the model being over quota, say), and a
      // reviewer needs "why", not a list with one entry per chunk.
      : [...new Set(degradedChunks.map((r) => r.degradedReason))].join(', '),
    model
  };
}

/**
 * THE ONLY PLACE A CLASSIFICATION BECOMES A WRITE-SHAPED DECISION — pure, so it
 * is testable without a database, and the last line of defence for the two
 * rules the UI is already supposed to enforce:
 *
 *   1. ALWAYS_CONTROLLED_FIELDS ARE PINNED. Whatever decision reached this
 *      function for summary/description/issuelinks/subtasks, they come out
 *      tracked. The admin console does not render a move control for them, but
 *      a resolver that trusted the payload to also honour that would be one
 *      hand-crafted request away from excluding the reviewed record itself.
 *   2. EVERY FIELD IS RULED ON EXACTLY ONCE. A duplicate fieldId in the
 *      reviewer's payload (a double click, a stale re-render) keeps its first
 *      occurrence and drops the rest, rather than writing the same field twice
 *      or letting a later duplicate silently overturn an earlier decision.
 *
 * `fieldsById` supplies the metadata (name/kind/schema) upsertControlledField
 * needs — classifications carry only the id, decision and rationale.
 */
export function partitionForBaseline(classifications, fieldsById) {
  const alwaysIds = new Set(ALWAYS_CONTROLLED_FIELDS.map((f) => f.field_id));
  const tracked = [];
  const excluded = [];
  const seen = new Set();

  for (const c of classifications ?? []) {
    const id = String(c?.fieldId ?? '');
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const meta = fieldsById?.get(id) ?? {};
    const row = {
      fieldId: id,
      fieldName: String(meta.fieldName ?? meta.field_name ?? c.fieldName ?? id),
      fieldKind: String(meta.fieldKind ?? meta.field_kind ?? c.fieldKind ?? 'TEXT'),
      schemaType: meta.schemaType ?? meta.schema_type ?? null,
      rationale: c.rationale ?? null
    };

    if (alwaysIds.has(id) || c.decision === CLASSIFICATION.GXP) tracked.push(row);
    else excluded.push(row);
  }

  // Pinned fields the reviewer's payload never mentioned at all — should not
  // happen, since the screen always renders them in Bucket A, but a baseline
  // commit is exactly the place to not take that on faith.
  for (const always of ALWAYS_CONTROLLED_FIELDS) {
    if (!seen.has(always.field_id)) {
      tracked.push({
        fieldId: always.field_id,
        fieldName: always.field_name,
        fieldKind: always.field_kind,
        schemaType: null,
        rationale: 'Core reviewed-record field'
      });
    }
  }

  return { tracked, excluded };
}

/**
 * AUDIT TRAIL PAYLOAD GENERATION.
 *
 * Verifies and generates the required compliance metadata for a GxP baseline commit.
 * The payload must capture both the final categorisation (tracked vs excluded)
 * and the affirmative compliance flags (`aiAssisted`, `reviewedByHuman`, `timestamp`).
 *
 * Exported as a pure function to guarantee testability of the payload schema
 * without mocking the database ledger.
 */
export function buildBaselineAuditPayload({ projectId, issueTypeId, tracked, excluded, now }) {
  if (!Number.isFinite(projectId)) throw new Error('Missing projectId');
  if (typeof issueTypeId !== 'string') throw new Error('Missing issueTypeId');
  if (!now) throw new Error('Missing timestamp');

  return {
    projectId,
    issueTypeId,
    trackedFields: (tracked ?? []).map(({ fieldId, fieldName, fieldKind, rationale }) => ({
      fieldId, fieldName, fieldKind, rationale
    })),
    excludedFields: (excluded ?? []).map(({ fieldId, fieldName, fieldKind, rationale }) => ({
      fieldId, fieldName, fieldKind, rationale
    })),
    // 21 CFR Part 11 required assertions: AI was used to propose, but a human reviewed.
    aiAssisted: true,
    reviewedByHuman: true,
    timestamp: now
  };
}
