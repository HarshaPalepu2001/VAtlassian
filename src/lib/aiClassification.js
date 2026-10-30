import { ALWAYS_CONTROLLED_FIELDS } from './content.js';

/**
 * Suggest GxP field classifications for administrator review.
 *
 * The model assigns each field a category and a short reason. An administrator
 * can change each assignment before saving. Only the human-triggered
 * admin:saveControlledFieldsBaseline resolver writes va_controlled_field.
 * This module neither calls that resolver nor queries the database.
 *
 * Classification uses Forge LLMs through @forge/llm, the bl-llm module and
 * model: [claude], as the AI report does. It sends field IDs, names and schema
 * types, never field values or issue content. It adds no remotes or external
 * fetch configuration; inference stays on the Atlassian platform.
 *
 * If the model is disabled, unavailable, over quota or returns unparseable
 * output, heuristicClassify() supplies a complete fallback classification.
 * The response sets degraded: true so the UI identifies the fallback.
 */

export const CLASSIFICATION = {
  GXP: 'GXP_CANDIDATE',
  NON_GXP: 'NON_GXP_CANDIDATE'
};

/**
 * Models that reject temperature with a 400 response. Keep this list separate
 * from lib/report.js because the modules make independent model calls.
 */
const NO_SAMPLING_PARAMS = new Set([
  'claude-opus-4-7',
  'claude-opus-4-8',
  'claude-opus-5',
  'claude-sonnet-5'
]);

/**
 * Bound the total number of fields in one resolver request. Projects usually
 * have only a few hundred fields, but network input must still have a limit.
 */
const MAX_FIELDS_PER_CALL = 500;

/**
 * Fields per completion. Output size determines generation time: each field
 * adds a {fieldId, decision, rationale} object. Split requests into concurrent CHUNK_SIZE-field chunks rather than increasing
 * the timeout.
 * Total time then depends on the slowest chunk. A timeout or invalid response
 * falls back to the heuristic for that chunk only.
 */
const CHUNK_SIZE = 150;

/**
 * Per-chunk wall-clock budget. admin:classifyFieldsForBaseline runs from a
 * Custom UI click rather than a validator, so it has more than the panel's
 * 25-second budget. Chunking bounds payload size; this timeout stops stalled
 * requests.
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
 * Deterministic, keyword-based fallback. validate() also uses it to fill gaps
 * in model output. partitionForBaseline() pins ALWAYS_CONTROLLED_FIELDS to
 * GXP_CANDIDATE before classification, but handle them here too for direct callers.
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
    // Default unknown fields to GXP_CANDIDATE to avoid excluding controlled content.
    // materiality.js ranks already tracked changes and defaults lower to reduce
    // notifications. This classifier decides what enters the baseline, so it uses
    // the more conservative default. See SYSTEM_PROMPT rule 4.
    return { fieldId: id, decision: CLASSIFICATION.GXP, rationale: 'Unrecognised — defaulted to controlled' };
  });
}

/**
 * Validate both schema and field coverage. Fill missing or unknown model IDs
 * from the heuristic so every input field appears in exactly one output list.
 * A model response with 40 of 42 fields must not hide the other two from review.
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
 * Classify and validate one chunk. Every failure returns its heuristic result
 * with degraded: true. Isolating chunks prevents a timeout or invalid response
 * from discarding successful classifications for the rest of the batch.
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
    // Import @forge/llm lazily. It throws "Forge runtime not found." at module load
    // outside deployed Forge, which would otherwise break smoke tests and sites
    // where AI is not provisioned. lib/report.js uses the same approach.
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
 * Classify a batch of fields without throwing.
 *
 * @param fields Candidate fields in either shape accepted by buildPayload().
 * @param model The light model from project configuration for short descriptors.
 * @param aiEnabled The project's config.ai.enabled. Disabled AI uses the same
 *                  heuristic fallback as an unavailable model.
 *
 * Request CHUNK_SIZE-field pieces concurrently. Each piece has its own timeout
 * and fallback, so one failure leaves the other model classifications intact.
 * The resolver decides how to disclose degraded results in the UI.
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
 * Convert reviewed classifications into write decisions without I/O.
 *
 * Always track ALWAYS_CONTROLLED_FIELDS, including summary, description,
 * issuelinks and subtasks, even if an edited request tries to exclude them.
 * Keep only the first occurrence of each fieldId so a duplicate cannot write
 * twice or replace an earlier decision.
 *
 * fieldsById supplies the name, kind and schema required by
 * upsertControlledField. Classifications contain only IDs, decisions and rationales.
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

  // Include pinned fields even if an edited request omits them. The UI's
  // Bucket A rendering does not establish that the payload is complete.
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
 * Build audit metadata for a GxP baseline commit.
 *
 * Record final tracked/excluded categories and the aiAssisted, reviewedByHuman
 * and timestamp flags. This pure function lets tests check the payload schema
 * without a database ledger.
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
