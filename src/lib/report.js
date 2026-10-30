import { sha256Hex, canonical } from './hash.js';
import { MATERIALITY } from './materiality.js';
import { ruleBasedSummary } from './diff/index.js';
import { adfPlainText } from './valuestore.js';

/**
 * Explain and rank an already computed diff with Forge LLMs.
 *
 * The model receives a structured payload, never the raw issue. The
 * deterministic diff engine decides what changed; the model only explains it.
 *
 * A single tool and tool_choice enforce the output schema. Validate citations
 * against the supplied drift IDs, strip unknown IDs and flag their groups.
 * If the model is unavailable, keep the complete deterministic diff and a
 * rule-based summary visible in the panel.
 *
 * Call only from resolvers and jobs, never gate.js. The validator's roughly
 * ten-second budget cannot accommodate an LLM call.
 */

/** Models that reject `temperature` and `top_p`; sending either is a 400. */
const NO_SAMPLING_PARAMS = new Set([
  'claude-opus-4-7',
  'claude-opus-4-8',
  'claude-opus-5',
  'claude-sonnet-5'
]);

/** How much of any single field value reaches the model. */
const VALUE_BUDGET = 4000;

/**
 * Use the light model for up to three minor changes, the deep model for
 * critical changes or more than ten material fields, and standard otherwise.
 */
export function chooseModel(diff, models) {
  const material = diff.materialFieldCount;
  if (diff.maxMateriality === MATERIALITY.CRITICAL || material > 10) return models.deep;
  if (material <= 3 && diff.maxMateriality === MATERIALITY.MINOR) return models.light;
  return models.standard;
}

/**
 * Define the required report tool schema. Each change group must cite
 * driftIds so the panel can link claims to the exact recorded changes.
 */
export const REPORT_TOOL = {
  type: 'function',
  function: {
    name: 'review_report',
    description:
      'Report on changes made to a Jira work item after it was approved. Use ONLY the '
      + 'facts in the supplied payload. Never invent a field, a person, a value or a date.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['verdictHint', 'headline', 'narrative', 'changeGroups', 'questionsForReviewer', 'scopeImpact'],
      properties: {
        verdictHint: {
          type: 'string',
          enum: ['no_material_change', 'review_recommended', 'material_change', 'scope_change'],
          description:
            'no_material_change: only formatting or trivia moved. review_recommended: real '
            + 'but routine edits. material_change: something a reviewer would likely object to. '
            + 'scope_change: acceptance criteria, estimate, or due date moved after approval. '
            + 'This is a HINT for ordering the reviewer\'s attention, not a decision.'
        },
        headline: {
          type: 'string',
          description: 'One sentence, under 140 characters, naming the single most important change and who made it.'
        },
        narrative: {
          type: 'string',
          description:
            'Three to six sentences, in chronological order, naming the people and automations '
            + 'involved. Say what changed and what it means for whether the approval still holds. '
            + 'Do not speculate about intent.'
        },
        changeGroups: {
          type: 'array',
          description: 'Related changes grouped as a reviewer would think about them, most important first.',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['title', 'fields', 'whoAndWhen', 'whatChanged', 'whyItMatters', 'risk', 'driftIds'],
            properties: {
              title: { type: 'string' },
              fields: { type: 'array', items: { type: 'string' } },
              whoAndWhen: { type: 'string' },
              whatChanged: { type: 'string' },
              whyItMatters: { type: 'string' },
              risk: { type: 'string', enum: ['low', 'medium', 'high'] },
              driftIds: {
                type: 'array',
                items: { type: 'string' },
                description:
                  'MANDATORY. The exact driftId values from the payload that this group is '
                  + 'based on. Every claim must be traceable to evidence. Do not invent ids.'
              }
            }
          }
        },
        questionsForReviewer: {
          type: 'array',
          items: { type: 'string' },
          description: 'At most three specific questions this reviewer should answer before deciding. Empty if none.'
        },
        scopeImpact: {
          type: 'object',
          additionalProperties: false,
          required: ['estimateChanged', 'acceptanceCriteriaChanged', 'dueDateChanged', 'note'],
          properties: {
            estimateChanged: { type: 'boolean' },
            acceptanceCriteriaChanged: { type: 'boolean' },
            dueDateChanged: { type: 'boolean' },
            note: { type: 'string' }
          }
        }
      }
    }
  }
};

const SYSTEM_PROMPT = `You explain what changed on a Jira work item after somebody approved it, for the reviewer who has to decide whether the approval still stands.

GROUND RULES, in order of importance:

1. Everything you say must come from the payload. Never invent a field name, a person, a value, a date or a number. If the payload does not say something, do not say it either.
2. Cite your evidence. Every changeGroup must list the driftIds it is based on, taken verbatim from the payload. A group with no driftIds is worthless.
3. Some fields are marked "contents not retained". For those you know THAT they changed and nothing more. Say exactly that; never guess at a value.
4. Do not speculate about why someone made a change or whether they were right to. Report what happened and what it means for the approval. The reviewer decides.
5. Formatting-only changes are noise. Group them together, mention them in one clause, and do not let them lead.
6. Name people and automations explicitly. "Automation for Jira raised the priority" is useful; "the priority was raised" is not.
7. Write for someone who has thirty seconds. Plain sentences, no headings, no bullet characters, no markdown.

You must respond by calling the review_report function. Do not reply with prose.`;

/**
 * Build the model payload with truncated field values and drift identifiers.
 * Include only evidence needed to explain the change.
 */
export function buildPayload({ issue, baseline, diff }) {
  const changes = diff.fields
    // List cosmetic changes without values so the report can mention formatting.
    .map((f) => ({
      driftIds: f.driftIds,
      field: f.fieldName,
      fieldId: f.fieldId,
      kind: f.kind,
      materiality: f.materiality,
      retained: f.retained !== false,
      semanticChange: f.semanticChange,
      occurrences: f.occurrences,
      changedBy: [...new Set(f.attribution.map((a) => a.authorName).filter(Boolean))],
      sources: [...new Set(f.attribution.map((a) => a.source).filter(Boolean))],
      firstChangedAt: isoOrNull(f.firstChangedAt),
      lastChangedAt: isoOrNull(f.lastChangedAt),
      summary: f.summary,
      ...(f.materiality === MATERIALITY.COSMETIC || f.retained === false
        ? {}
        : { before: renderValue(f.before, f.kind, f.valueLabels), after: renderValue(f.after, f.kind, f.valueLabels) })
    }));

  return {
    issue: {
      key: issue.key,
      summary: issue.fields?.summary ?? '',
      type: issue.fields?.issuetype?.name ?? null,
      status: issue.fields?.status?.name ?? null,
      priority: issue.fields?.priority?.name ?? null
    },
    baseline: {
      version: baseline.version,
      approvedBy: baseline.approved_name,
      approvedAt: isoOrNull(baseline.transition_at),
      // Told to the model so it can caveat honestly rather than presenting a
      // reconstructed rich-text baseline as if it were exact.
      fidelity: baseline.fidelity
    },
    changes,
    timeline: diff.timeline.map((t) => ({
      at: isoOrNull(t.at),
      by: t.authorName,
      source: t.source,
      fields: t.fields.map((f) => f.fieldName)
    }))
  };
}

/** "Low (id 4)" for an identifier the diff could name; the identifier stays, as in the panel. */
function named(v, labels) {
  const label = (typeof v === 'string' || typeof v === 'number') ? labels?.[String(v)] : null;
  return label && label !== String(v) ? `${label} (id ${v})` : v;
}

function renderValue(v, kind, labels = null) {
  if (v == null) return null;
  const value = Array.isArray(v) ? v.map(item => named(item, labels)) : named(v, labels);
  const text = kind === 'adf' ? adfPlainText(v) : (typeof value === 'string' ? value : JSON.stringify(value));
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length <= VALUE_BUDGET ? flat : `${flat.slice(0, VALUE_BUDGET)}… [truncated]`;
}

function isoOrNull(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * Generate a report or return a degraded deterministic report on model,
 * network, refusal or parsing failure.
 * @returns { body, model, degraded, inputTokens, outputTokens }
 */
export async function generateReport({ issue, baseline, diff, models, maxCompletionTokens = 4096 }) {
  const model = chooseModel(diff, models);
  const payload = buildPayload({ issue, baseline, diff });
  const validIds = new Set(diff.fields.flatMap((f) => f.driftIds ?? []));

  const request = {
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify(payload) }
    ],
    tools: [REPORT_TOOL],
    tool_choice: { type: 'function', function: { name: 'review_report' } },
    max_completion_tokens: maxCompletionTokens
  };

  // Omitted rather than set to a default: these models return 400 if either is
  // present, and a 400 here would degrade the report for no reason at all.
  if (!NO_SAMPLING_PARAMS.has(model)) request.temperature = 0.2;

  let response;
  try {
    // Import @forge/llm only when a report is requested. Loading it outside
    // Forge throws, which would otherwise prevent testing the pure report logic.
    const { chat } = await import('@forge/llm');
    
    // The panel resolver has a strict 25-second limit. If the model takes longer
    // than 15 seconds, cut it off and return the degraded deterministic diff so 
    // the reviewer still gets a working UI instead of a timeout error.
    let timerId;
    const timeout = new Promise((_, reject) => {
      timerId = setTimeout(() => reject(new Error('LLM_TIMEOUT')), 15000);
    });
    
    try {
      response = await Promise.race([chat(request), timeout]);
    } finally {
      clearTimeout(timerId);
    }
  } catch (err) {
    const reason = err.message === 'LLM_TIMEOUT' ? 'TIMEOUT' : 'LLM_UNAVAILABLE';
    console.error('report: LLM call failed', { model, reason, error: err?.context?.responseText ?? err?.message });
    return degraded(diff, model, reason);
  }

  const call = response?.choices?.[0]?.message?.tool_calls?.[0];
  if (!call || call.function?.name !== 'review_report') {
    console.error('report: model did not call the tool', { model, finish: response?.choices?.[0]?.finish_reason });
    return degraded(diff, model, 'NO_TOOL_CALL');
  }

  let parsed;
  try {
    // The SDK types `arguments` as an object, but a model that emits malformed
    // JSON can leave it as a string. Handle both rather than throwing on the
    // one that is easy to fix.
    parsed = typeof call.function.arguments === 'string'
      ? JSON.parse(call.function.arguments)
      : call.function.arguments;
  } catch (err) {
    console.error('report: unparseable tool arguments', err);
    return degraded(diff, model, 'UNPARSEABLE');
  }

  const body = validate(parsed, validIds, diff);
  if (!body) return degraded(diff, model, 'SCHEMA_MISMATCH');

  return {
    body,
    model,
    degraded: false,
    inputTokens: response.usage?.input_tokens ?? null,
    outputTokens: response.usage?.output_tokens ?? null
  };
}

/**
 * Validate the schema and citations. Strip unknown drift ids and mark groups
 * without valid citations as ungrounded. The panel keeps unsupported claims
 * visible with a warning so reviewers can assess the model's output.
 */
export function validate(parsed, validIds, diff) {
  if (!parsed || typeof parsed !== 'object') return null;
  if (typeof parsed.headline !== 'string' || typeof parsed.narrative !== 'string') return null;

  const groups = Array.isArray(parsed.changeGroups) ? parsed.changeGroups : [];
  const changeGroups = groups.map((g) => {
    const cited = Array.isArray(g.driftIds) ? g.driftIds.map(String) : [];
    const kept = cited.filter((id) => validIds.has(id));
    const dropped = cited.length - kept.length;
    if (dropped > 0) {
      console.warn('report: stripped', dropped, 'fabricated citation(s) from group', g.title);
    }
    return {
      title: String(g.title ?? 'Changes'),
      fields: Array.isArray(g.fields) ? g.fields.map(String) : [],
      whoAndWhen: String(g.whoAndWhen ?? ''),
      whatChanged: String(g.whatChanged ?? ''),
      whyItMatters: String(g.whyItMatters ?? ''),
      risk: ['low', 'medium', 'high'].includes(g.risk) ? g.risk : 'low',
      driftIds: kept,
      ungrounded: kept.length === 0,
      strippedCitations: dropped
    };
  });

  const verdicts = ['no_material_change', 'review_recommended', 'material_change', 'scope_change'];

  return {
    verdictHint: verdicts.includes(parsed.verdictHint) ? parsed.verdictHint : 'review_recommended',
    headline: parsed.headline.slice(0, 400),
    narrative: parsed.narrative.slice(0, 4000),
    changeGroups,
    questionsForReviewer: Array.isArray(parsed.questionsForReviewer)
      ? parsed.questionsForReviewer.slice(0, 5).map((q) => String(q).slice(0, 400))
      : [],
    scopeImpact: {
      estimateChanged: !!parsed.scopeImpact?.estimateChanged,
      acceptanceCriteriaChanged: !!parsed.scopeImpact?.acceptanceCriteriaChanged,
      dueDateChanged: !!parsed.scopeImpact?.dueDateChanged,
      note: String(parsed.scopeImpact?.note ?? '').slice(0, 1000)
    },
    // How much of the model's output survived validation. Surfaced in the panel
    // as a quiet note when it is non-zero: a reviewer deciding on the strength
    // of a report deserves to know the report needed correcting.
    groundingIssues: changeGroups.filter((g) => g.ungrounded || g.strippedCitations > 0).length
  };
}

/**
 * Build the fallback entirely from the diff. Label it so reviewers can
 * distinguish it from model-generated analysis.
 */
export function degraded(diff, model, reason) {
  const bySeverity = {};
  for (const f of diff.fields) {
    (bySeverity[f.materiality] ??= []).push(f);
  }

  const changeGroups = Object.entries(bySeverity)
    .sort((a, b) => rank(b[0]) - rank(a[0]))
    .map(([materiality, fields]) => ({
      title: `${titleCase(materiality)} changes`,
      fields: fields.map((f) => f.fieldName),
      whoAndWhen: describeWho(fields),
      whatChanged: fields.map((f) => `${f.fieldName}: ${f.summary}`).join('; '),
      whyItMatters: materiality === MATERIALITY.COSMETIC
        ? 'Formatting only. The rendered text is unchanged.'
        : 'Changed after approval; review before this work item moves on.',
      risk: materiality === MATERIALITY.CRITICAL ? 'high' : materiality === MATERIALITY.MAJOR ? 'medium' : 'low',
      driftIds: fields.flatMap((f) => f.driftIds ?? []),
      ungrounded: false,
      strippedCitations: 0
    }));

  return {
    body: {
      verdictHint: diff.materialFieldCount === 0 ? 'no_material_change' : 'review_recommended',
      headline: ruleBasedSummary(diff),
      narrative:
        'This summary was produced without AI assistance, so it lists what changed rather than '
        + 'explaining it. The field-by-field comparison below is complete and exact.',
      changeGroups,
      questionsForReviewer: [],
      scopeImpact: {
        estimateChanged: diff.fields.some((f) => /estimate|point/i.test(f.fieldName)),
        acceptanceCriteriaChanged: diff.fields.some((f) => /acceptance|criteria|description/i.test(f.fieldName)),
        dueDateChanged: diff.fields.some((f) => f.fieldId === 'duedate'),
        note: ''
      },
      groundingIssues: 0
    },
    model,
    degraded: true,
    degradedReason: reason,
    inputTokens: null,
    outputTokens: null
  };
}

function describeWho(fields) {
  const people = [...new Set(fields.flatMap((f) => f.attribution.map((a) => a.authorName)).filter(Boolean))];
  if (people.length === 0) return 'Author not recorded.';
  if (people.length === 1) return `By ${people[0]}.`;
  return `By ${people.slice(0, 3).join(', ')}${people.length > 3 ? ` and ${people.length - 3} others` : ''}.`;
}

function rank(m) {
  return { CRITICAL: 3, MAJOR: 2, MINOR: 1, COSMETIC: 0 }[m] ?? 0;
}

function titleCase(s) {
  return s.charAt(0) + s.slice(1).toLowerCase();
}

/**
 * Hash the baseline, sorted drift ids and model. Sorting avoids cache misses
 * from row order. The model is part of the key because different models can
 * produce different reports from the same evidence.
 */
export function reportHashFor(baseline, driftIds, model) {
  return sha256Hex(canonical({
    baselineId: baseline?.baseline_id ? String(baseline.baseline_id) : null,
    version: baseline?.version ?? null,
    drift: [...(driftIds ?? [])].map(String).sort(),
    model
  }));
}
