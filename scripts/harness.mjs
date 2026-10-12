#!/usr/bin/env node

/**
 * VAtlassian ALM Observability & Diagnostics Harness CLI
 *
 * Real-time log streamer, event parser, issue lifecycle inspector, and ALM analytics tool.
 *
 * Commands:
 *   node scripts/harness.mjs watch [options]              # Continuous live log stream
 *   node scripts/harness.mjs tail [limit=40] [options]    # Fetch and summarize recent Forge logs
 *   node scripts/harness.mjs parse <logfile> [options]    # Parse and filter local log file
 *   node scripts/harness.mjs stats [logfile|--limit N]    # Comprehensive ALM health & performance analytics
 *   node scripts/harness.mjs inspect <issueKey> [logfile] # Full chronological lifecycle reconstruction for an issue
 *   node scripts/harness.mjs replay <logfile> [--speed N] # Replay log file with relative timing
 *
 * Options:
 *   -i, --issue <key>      Filter by Jira issue key (e.g. VJIRA-18)
 *   -c, --category <cats>  Filter by comma-separated categories (e.g. GATE,RESTORE,VAULT)
 *   -e, --errors           Only show errors, warnings, and gate denials
 *   -a, --action <pattern> Filter by action name pattern
 *   -t, --trace <id>       Filter by correlation/trace ID
 *       --json             Output raw NDJSON instead of human-friendly formatting
 *   -o, --output <file>    Append filtered events to a file
 */

import { execSync } from 'child_process';
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'fs';

export const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  underline: '\x1b[4m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
  bgRed: '\x1b[41m\x1b[37m\x1b[1m',
  bgGreen: '\x1b[42m\x1b[30m\x1b[1m',
  bgYellow: '\x1b[43m\x1b[30m\x1b[1m',
  bgBlue: '\x1b[44m\x1b[37m\x1b[1m',
  bgMagenta: '\x1b[45m\x1b[37m\x1b[1m',
  bgCyan: '\x1b[46m\x1b[30m\x1b[1m'
};

export const CATEGORY_BADGES = {
  GATE: `${ANSI.bgYellow} WORKFLOW GATE ${ANSI.reset}`,
  CAPTURE: `${ANSI.bgCyan} CAPTURE ${ANSI.reset}`,
  DRIFT: `${ANSI.yellow}${ANSI.bold} DRIFT ${ANSI.reset}`,
  APPROVAL: `${ANSI.bgGreen} APPROVAL ${ANSI.reset}`,
  WEBAUTHN: `${ANSI.bgGreen} BIOMETRIC / WEBAUTHN ${ANSI.reset}`,
  RESTORE: `${ANSI.cyan}${ANSI.bold} RESTORE ${ANSI.reset}`,
  VAULT: `${ANSI.magenta}${ANSI.bold} VAULT ${ANSI.reset}`,
  RESOLVER: `${ANSI.blue}${ANSI.bold} RESOLVER ${ANSI.reset}`,
  ADMIN: `${ANSI.bgBlue} ADMIN ${ANSI.reset}`,
  TRIGGER: `${ANSI.bgMagenta} TRIGGER ${ANSI.reset}`,
  WORKER: `${ANSI.cyan} WORKER ${ANSI.reset}`,
  DIAGNOSTICS: `${ANSI.bgCyan} DIAGNOSTICS ${ANSI.reset}`,
  AUDIT: `${ANSI.yellow} AUDIT LEDGER ${ANSI.reset}`,
  CLIENT: `${ANSI.bgBlue} CLIENT ACTION ${ANSI.reset}`,
  UI: `${ANSI.bgBlue} UI ${ANSI.reset}`,
  BRIDGE: `${ANSI.bgMagenta} BRIDGE INVOKE ${ANSI.reset}`,
  ERROR: `${ANSI.bgRed} ERROR ${ANSI.reset}`
};

/**
 * Parse an individual line or chunk into a structured Harness LogEvent.
 */
export function parseHarnessEvent(line) {
  if (!line || !line.trim()) return null;

  const harnessMatch = line.match(/\[HARNESS:([A-Z_]+)\]\s+([^\s]+)?\s*(.*)/);
  if (harnessMatch) {
    const [, category, action, rest] = harnessMatch;
    let details = {};
    if (rest) {
      try {
        details = JSON.parse(rest);
      } catch {
        details = { rawMessage: rest };
      }
    }

    const issueKey = details.issueKey || details.targetKey || details.rootIssueKey || null;
    const traceId = details.traceId || null;
    const durationMs = typeof details.durationMs === 'number' ? details.durationMs : null;
    const isError = category === 'ERROR' || details.level === 'ERROR' || details.success === false || Boolean(details.error) || (action ?? '').includes('failed') || action === 'gate:deny';

    return {
      isHarness: true,
      category: category.toUpperCase(),
      action: action || 'unknown',
      issueKey,
      traceId,
      durationMs,
      timestamp: details.timestamp || new Date().toISOString(),
      level: isError ? 'ERROR' : (details.level === 'WARN' || details.reason ? 'WARN' : 'INFO'),
      details,
      raw: line
    };
  }

  // Non-harness Forge log lines
  const isForgeError = line.startsWith('ERROR') || line.includes(' Forge SQL Error:') || line.includes('Error:');
  const isForgeWarn = line.startsWith('WARN') || line.includes('Warning:');
  const level = isForgeError ? 'ERROR' : isForgeWarn ? 'WARN' : 'INFO';

  // Extract issue key if present in normal log line (e.g. [A-Z]+-[0-9]+)
  const issueMatch = line.match(/\b([A-Z]{2,10}-\d+)\b/);
  const issueKey = issueMatch ? issueMatch[1] : null;

  return {
    isHarness: false,
    category: isForgeError ? 'ERROR' : 'FORGE',
    action: isForgeError ? 'forge:error' : 'forge:log',
    issueKey,
    traceId: null,
    durationMs: null,
    timestamp: new Date().toISOString(),
    level,
    details: { raw: line },
    raw: line
  };
}

/**
 * Assemble multiple raw lines into logical entries, preserving stack traces and SQL context.
 */
export function groupLogEntries(lines) {
  const entries = [];
  let currentGroup = null;

  for (const line of lines) {
    if (!line.trim()) continue;
    if (line.includes('Warning: Your version of Forge CLI')) continue;

    const isNewEntry = line.startsWith('ERROR ') ||
      line.startsWith('WARN ') ||
      line.startsWith('INFO ') ||
      line.includes('[HARNESS:') ||
      /^\d{4}-\d{2}-\d{2}T/.test(line);

    if (isNewEntry) {
      if (currentGroup) entries.push(currentGroup);
      currentGroup = [line];
    } else if (currentGroup) {
      currentGroup.push(line);
    } else {
      currentGroup = [line];
    }
  }

  if (currentGroup) entries.push(currentGroup);

  return entries.map(group => {
    const firstLine = group[0];
    const event = parseHarnessEvent(firstLine);
    if (!event) return null;

    if (group.length > 1) {
      const extra = group.slice(1).join('\n');
      event.raw = `${event.raw}\n${extra}`;
      if (!event.isHarness && event.level === 'ERROR') {
        event.details.stack = extra;
      }
    }
    return event;
  }).filter(Boolean);
}

/**
 * Filter evaluation against CLI options.
 */
export function matchesFilter(event, options = {}) {
  if (!event) return false;

  if (options.issue) {
    const target = options.issue.toUpperCase();
    const eventIssue = (event.issueKey || '').toUpperCase();
    if (eventIssue !== target && !event.raw.toUpperCase().includes(target)) {
      return false;
    }
  }

  if (options.category) {
    const allowed = options.category.split(',').map(s => s.trim().toUpperCase());
    if (!allowed.includes(event.category)) {
      return false;
    }
  }

  if (options.errors) {
    if (event.level !== 'ERROR' && event.level !== 'WARN' && event.action !== 'gate:deny') {
      return false;
    }
  }

  if (options.action) {
    const regex = new RegExp(options.action, 'i');
    if (!regex.test(event.action)) {
      return false;
    }
  }

  if (options.trace) {
    if (event.traceId !== options.trace && !event.raw.includes(options.trace)) {
      return false;
    }
  }

  return true;
}

/**
 * Format a Harness LogEvent into terminal text with badges, timing, and highlighted properties.
 */
export function formatHarnessEvent(event) {
  if (!event) return null;

  if (!event.isHarness) {
    if (event.level === 'ERROR') {
      return `${ANSI.red}${ANSI.bold}🚨 ${event.raw}${ANSI.reset}`;
    }
    if (event.level === 'WARN') {
      return `${ANSI.yellow}⚠️  ${event.raw}${ANSI.reset}`;
    }
    return `${ANSI.dim}${event.raw}${ANSI.reset}`;
  }

  const badge = CATEGORY_BADGES[event.category] || `[${event.category}]`;
  const actionName = `${ANSI.bold}${event.action}${ANSI.reset}`;
  const parts = [];

  const { issueKey, durationMs, success, error, reason, state, decision, traceId, verdict, ...others } = event.details;

  if (event.issueKey) parts.push(`${ANSI.cyan}issue=${event.issueKey}${ANSI.reset}`);
  if (decision) parts.push(`${ANSI.magenta}decision=${decision}${ANSI.reset}`);
  if (state) parts.push(`${ANSI.green}state=${state}${ANSI.reset}`);
  if (verdict) parts.push(`${ANSI.bgYellow} verdict=${verdict} ${ANSI.reset}`);
  if (event.durationMs !== null && event.durationMs !== undefined) {
    const durationColor = event.durationMs > 1000 ? ANSI.red : event.durationMs > 300 ? ANSI.yellow : ANSI.gray;
    parts.push(`${durationColor}${event.durationMs}ms${ANSI.reset}`);
  }
  if (success !== undefined) {
    parts.push(success ? `${ANSI.green}✓ OK${ANSI.reset}` : `${ANSI.red}✗ FAIL${ANSI.reset}`);
  }
  if (reason) parts.push(`${ANSI.yellow}reason=${reason}${ANSI.reset}`);
  if (error) parts.push(`${ANSI.red}${ANSI.bold}error=${typeof error === 'object' ? JSON.stringify(error) : error}${ANSI.reset}`);
  if (traceId) parts.push(`${ANSI.gray}trace=${String(traceId).slice(0, 8)}${ANSI.reset}`);

  const otherKeys = Object.keys(others).filter(k => k !== 'timestamp' && k !== 'rawMessage');
  let compactOthers = '';
  if (otherKeys.length) {
    const compactObj = {};
    for (const k of otherKeys) compactObj[k] = others[k];
    compactOthers = ` ${ANSI.gray}${JSON.stringify(compactObj)}${ANSI.reset}`;
  }

  const detailsStr = parts.length ? ` ${parts.join(' ')}` : '';
  const timeStr = event.timestamp ? `${ANSI.gray}${event.timestamp.slice(11, 19)} ${ANSI.reset}` : '';

  return `${timeStr}${badge} ${actionName}${detailsStr}${compactOthers}`;
}

/**
 * Output or persist a formatted event.
 */
function outputEvent(event, options = {}) {
  if (options.json) {
    const jsonStr = JSON.stringify(event);
    console.log(jsonStr);
    if (options.output) appendFileSync(options.output, `${jsonStr}\n`, 'utf8');
    return;
  }

  const formatted = formatHarnessEvent(event);
  if (formatted) {
    console.log(formatted);
    if (options.output) appendFileSync(options.output, `${formatted.replace(/\x1b\[[0-9;]*m/g, '')}\n`, 'utf8');
  }
}

/**
 * Parse CLI flags into an options object.
 */
export function parseCliOptions(args) {
  const options = {
    command: 'watch',
    positional: [],
    issue: null,
    category: null,
    errors: false,
    action: null,
    trace: null,
    json: false,
    output: null,
    limit: 40,
    speed: 1
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === '-h' || arg === '--help' || arg === 'help') {
      options.command = 'help';
    } else if (arg === '-i' || arg === '--issue') {
      options.issue = args[++i];
    } else if (arg === '-c' || arg === '--category') {
      options.category = args[++i];
    } else if (arg === '-e' || arg === '--errors') {
      options.errors = true;
    } else if (arg === '-a' || arg === '--action') {
      options.action = args[++i];
    } else if (arg === '-t' || arg === '--trace') {
      options.trace = args[++i];
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '-o' || arg === '--output') {
      options.output = args[++i];
    } else if (arg === '-n' || arg === '--limit') {
      options.limit = parseInt(args[++i], 10) || 40;
    } else if (arg === '--speed') {
      options.speed = parseFloat(args[++i]) || 1;
    } else if (!arg.startsWith('-')) {
      options.positional.push(arg);
    }
    i++;
  }

  if (options.positional.length > 0) {
    options.command = options.positional[0];
  }

  return options;
}

/**
 * Continuous live watcher.
 */
export async function startWatcher(options = {}) {
  console.log(`${ANSI.bold}=== VAtlassian ALM Live Harness Watcher ===${ANSI.reset}`);
  console.log(`${ANSI.dim}Continuous monitoring enabled for one-atlas-mjkg.atlassian.net (development)${ANSI.reset}`);
  if (options.issue) console.log(`${ANSI.cyan}Filtering by issue: ${options.issue}${ANSI.reset}`);
  if (options.category) console.log(`${ANSI.magenta}Filtering by category: ${options.category}${ANSI.reset}`);
  if (options.errors) console.log(`${ANSI.red}Showing errors & denials only${ANSI.reset}`);
  console.log('');

  const seenKeys = new Set();
  let running = true;

  process.on('SIGINT', () => { running = false; });
  process.on('SIGTERM', () => { running = false; });

  while (running) {
    try {
      const output = execSync('forge logs --environment development --limit 35', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
      const rawLines = output.split('\n');
      const events = groupLogEntries(rawLines);

      for (const ev of events) {
        const uniqueKey = `${ev.timestamp}_${ev.category}_${ev.action}_${ev.issueKey || ''}_${(ev.raw || '').slice(0, 60)}`;
        if (!seenKeys.has(uniqueKey)) {
          seenKeys.add(uniqueKey);
          if (seenKeys.size > 3000) {
            const first = seenKeys.values().next().value;
            seenKeys.delete(first);
          }
          if (matchesFilter(ev, options)) {
            outputEvent(ev, options);
          }
        }
      }
    } catch {
      // transient network or CLI error, retry next tick
    }
    await new Promise(r => setTimeout(r, 2500));
  }
}

/**
 * Fetch and format recent logs.
 */
export function tailLogs(limit = 40, options = {}) {
  console.log(`${ANSI.bold}=== Fetching last ${limit} Forge log entries ===${ANSI.reset}`);
  try {
    const output = execSync(`forge logs --environment development --limit ${limit}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
    const rawLines = output.split('\n');
    const events = groupLogEntries(rawLines);
    let count = 0;

    for (const ev of events) {
      if (matchesFilter(ev, options)) {
        outputEvent(ev, options);
        count++;
      }
    }
    console.log(`\n${ANSI.green}✓ Displayed ${count} matching log entries.${ANSI.reset}`);
  } catch (err) {
    console.error(`${ANSI.red}Error fetching logs: ${err.message}${ANSI.reset}`);
  }
}

/**
 * Parse local log file.
 */
export function parseFile(filePath, options = {}) {
  if (!existsSync(filePath)) {
    console.error(`${ANSI.red}File not found: ${filePath}${ANSI.reset}`);
    return;
  }
  const content = readFileSync(filePath, 'utf8');
  const rawLines = content.split('\n');
  const events = groupLogEntries(rawLines);

  if (!options.json) {
    console.log(`${ANSI.bold}=== Parsing Log File: ${filePath} (${events.length} entries) ===${ANSI.reset}\n`);
  }
  let count = 0;

  for (const ev of events) {
    if (matchesFilter(ev, options)) {
      outputEvent(ev, options);
      count++;
    }
  }
  if (!options.json) {
    console.log(`\n${ANSI.green}✓ Processed ${count}/${events.length} log entries.${ANSI.reset}`);
  }
}

/**
 * Compute and display ALM health and performance statistics.
 */
export function showStatistics(source, options = {}) {
  let rawContent = '';
  if (existsSync(source)) {
    rawContent = readFileSync(source, 'utf8');
  } else {
    const limit = options.limit || 100;
    console.log(`${ANSI.dim}Fetching ${limit} logs from Forge development environment...${ANSI.reset}`);
    try {
      rawContent = execSync(`forge logs --environment development --limit ${limit}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
    } catch (err) {
      console.error(`${ANSI.red}Error fetching Forge logs: ${err.message}${ANSI.reset}`);
      return;
    }
  }

  const events = groupLogEntries(rawContent.split('\n'));
  if (events.length === 0) {
    console.log(`${ANSI.yellow}No log events found to analyze.${ANSI.reset}`);
    return;
  }

  const categoryCounts = {};
  const actionCounts = {};
  const issuesSeen = new Map();
  const durations = [];
  const errors = [];
  let gateAllows = 0;
  let gateDenies = 0;
  const gateDenyReasons = {};

  for (const ev of events) {
    categoryCounts[ev.category] = (categoryCounts[ev.category] || 0) + 1;
    actionCounts[ev.action] = (actionCounts[ev.action] || 0) + 1;

    if (ev.issueKey) {
      issuesSeen.set(ev.issueKey, {
        key: ev.issueKey,
        lastAction: ev.action,
        category: ev.category,
        timestamp: ev.timestamp
      });
    }

    if (ev.durationMs !== null) {
      durations.push({ action: ev.action, ms: ev.durationMs });
    }

    if (ev.level === 'ERROR') {
      errors.push({ action: ev.action, error: ev.details.error || ev.details.raw || 'Unknown error' });
    }

    if (ev.category === 'GATE') {
      if (ev.action === 'gate:allow') gateAllows++;
      if (ev.action === 'gate:deny') {
        gateDenies++;
        const reason = ev.details.reason || 'UNKNOWN';
        gateDenyReasons[reason] = (gateDenyReasons[reason] || 0) + 1;
      }
    }
  }

  console.log(`\n${ANSI.bold}╔════════════════════════════════════════════════════════════════════╗${ANSI.reset}`);
  console.log(`${ANSI.bold}║              VAtlassian ALM Observability Statistics               ║${ANSI.reset}`);
  console.log(`${ANSI.bold}╚════════════════════════════════════════════════════════════════════╝${ANSI.reset}\n`);

  console.log(`  Total log entries parsed: ${ANSI.bold}${events.length}${ANSI.reset}`);
  console.log(`  Unique issues observed:   ${ANSI.bold}${issuesSeen.size}${ANSI.reset}`);
  console.log(`  Total errors logged:      ${errors.length ? ANSI.red + ANSI.bold + errors.length + ANSI.reset : ANSI.green + '0' + ANSI.reset}\n`);

  // Category breakdown
  console.log(`${ANSI.bold}📊 Category Distribution:${ANSI.reset}`);
  const maxCatCount = Math.max(...Object.values(categoryCounts), 1);
  for (const [cat, cnt] of Object.entries(categoryCounts).sort((a, b) => b[1] - a[1])) {
    const barWidth = Math.max(1, Math.round((cnt / maxCatCount) * 28));
    const bar = '█'.repeat(barWidth);
    const catStr = cat.padEnd(14, ' ');
    console.log(`  ${catStr} | ${ANSI.cyan}${bar}${ANSI.reset} ${cnt}`);
  }

  // Gate summary
  if (gateAllows > 0 || gateDenies > 0) {
    console.log(`\n${ANSI.bold}🚪 Workflow Gate Decisions:${ANSI.reset}`);
    console.log(`  Allows: ${ANSI.green}${ANSI.bold}${gateAllows}${ANSI.reset}  |  Denials: ${ANSI.yellow}${ANSI.bold}${gateDenies}${ANSI.reset}`);
    if (gateDenies > 0) {
      console.log(`  Top denial reasons:`);
      for (const [r, count] of Object.entries(gateDenyReasons)) {
        console.log(`    • ${ANSI.yellow}${r}${ANSI.reset}: ${count}`);
      }
    }
  }

  // Resolver Latency Statistics
  if (durations.length > 0) {
    durations.sort((a, b) => a.ms - b.ms);
    const min = durations[0].ms;
    const max = durations[durations.length - 1].ms;
    const sum = durations.reduce((acc, d) => acc + d.ms, 0);
    const avg = Math.round(sum / durations.length);
    const p95 = durations[Math.floor(durations.length * 0.95)]?.ms ?? max;

    console.log(`\n${ANSI.bold}⚡ Performance Latencies (${durations.length} timed operations):${ANSI.reset}`);
    console.log(`  Min: ${min}ms  |  Avg: ${avg}ms  |  P95: ${p95}ms  |  Max: ${max}ms`);

    const slowest = [...durations].sort((a, b) => b.ms - a.ms).slice(0, 3);
    console.log(`  Slowest operations:`);
    slowest.forEach(s => console.log(`    • ${s.action}: ${ANSI.yellow}${s.ms}ms${ANSI.reset}`));
  }

  // Top issues seen
  if (issuesSeen.size > 0) {
    console.log(`\n${ANSI.bold}🎯 Observed Work Items:${ANSI.reset}`);
    for (const [key, item] of Array.from(issuesSeen.entries()).slice(0, 8)) {
      console.log(`  • ${ANSI.cyan}${key}${ANSI.reset}: [${item.category}] ${item.lastAction}`);
    }
  }

  console.log('');
}

/**
 * Reconstruct the complete lifecycle timeline of a specific Jira work item.
 */
export function inspectIssueLifecycle(issueKey, source, options = {}) {
  if (!issueKey) {
    console.error(`${ANSI.red}Please provide an issue key to inspect (e.g. node scripts/harness.mjs inspect VJIRA-18)${ANSI.reset}`);
    return;
  }

  const targetKey = issueKey.toUpperCase();
  let rawContent = '';

  if (source && existsSync(source)) {
    rawContent = readFileSync(source, 'utf8');
  } else {
    console.log(`${ANSI.dim}Scanning recent Forge logs for ${targetKey}...${ANSI.reset}`);
    try {
      rawContent = execSync('forge logs --environment development --limit 100', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
    } catch (err) {
      console.error(`${ANSI.red}Error fetching logs: ${err.message}${ANSI.reset}`);
      return;
    }
  }

  const events = groupLogEntries(rawContent.split('\n'));
  const issueEvents = events.filter(e => {
    return (e.issueKey && e.issueKey.toUpperCase() === targetKey) ||
      (e.raw && e.raw.toUpperCase().includes(targetKey));
  });

  console.log(`\n${ANSI.bold}╔════════════════════════════════════════════════════════════════════╗${ANSI.reset}`);
  console.log(`${ANSI.bold}║        VAtlassian ALM Issue Lifecycle: ${targetKey.padEnd(27, ' ')} ║${ANSI.reset}`);
  console.log(`${ANSI.bold}╚════════════════════════════════════════════════════════════════════╝${ANSI.reset}\n`);

  if (issueEvents.length === 0) {
    console.log(`${ANSI.yellow}No recorded harness events found for ${targetKey}.${ANSI.reset}\n`);
    return;
  }

  console.log(`${ANSI.green}Found ${issueEvents.length} events for ${targetKey}:${ANSI.reset}\n`);

  for (let idx = 0; idx < issueEvents.length; idx++) {
    const ev = issueEvents[idx];
    const prefix = `${ANSI.bold}${String(idx + 1).padStart(2, ' ')}.${ANSI.reset}`;
    console.log(`${prefix} ${formatHarnessEvent(ev)}`);
  }
  console.log('');
}

/**
 * Replay a log file with realistic timing delay.
 */
export async function replayLogFile(filePath, options = {}) {
  if (!existsSync(filePath)) {
    console.error(`${ANSI.red}File not found: ${filePath}${ANSI.reset}`);
    return;
  }
  const content = readFileSync(filePath, 'utf8');
  const events = groupLogEntries(content.split('\n')).filter(e => matchesFilter(e, options));

  console.log(`${ANSI.bold}=== Replaying ${events.length} log events (speed: ${options.speed}x) ===${ANSI.reset}\n`);

  let lastTime = null;
  for (const ev of events) {
    if (lastTime && ev.timestamp) {
      const delta = new Date(ev.timestamp).getTime() - new Date(lastTime).getTime();
      if (delta > 0 && delta < 10000) {
        await new Promise(r => setTimeout(r, Math.max(10, Math.round(delta / options.speed))));
      } else {
        await new Promise(r => setTimeout(r, 100 / options.speed));
      }
    }
    lastTime = ev.timestamp;
    outputEvent(ev, options);
  }
  console.log(`\n${ANSI.green}✓ Replay completed.${ANSI.reset}`);
}

// CLI Execution Router
const isMain = Boolean(process.argv[1] && (process.argv[1].endsWith('harness.mjs') || process.argv[1].endsWith('harness')));

if (isMain) {
  const rawArgs = process.argv.slice(2);
  const options = parseCliOptions(rawArgs);

  if (options.command === 'watch') {
    void startWatcher(options);
  } else if (options.command === 'tail') {
    const limitArg = options.positional[1] ? parseInt(options.positional[1], 10) : options.limit;
    tailLogs(limitArg, options);
  } else if (options.command === 'parse') {
    const file = options.positional[1] || 'logs.txt';
    parseFile(file, options);
  } else if (options.command === 'stats' || options.command === 'summary') {
    const source = options.positional[1] || 'logs.txt';
    showStatistics(source, options);
  } else if (options.command === 'inspect' || options.command === 'diagnose') {
    const issueKey = options.positional[1];
    const source = options.positional[2] || 'logs.txt';
    inspectIssueLifecycle(issueKey, source, options);
  } else if (options.command === 'replay') {
    const file = options.positional[1] || 'logs.txt';
    void replayLogFile(file, options);
  } else {
    console.log(`VAtlassian ALM Observability Harness CLI

Usage:
  node scripts/harness.mjs watch [options]              # Stream real-time Forge logs
  node scripts/harness.mjs tail [limit=40] [options]    # Fetch recent Forge logs
  node scripts/harness.mjs parse <logfile> [options]    # Parse and filter local log file
  node scripts/harness.mjs stats [logfile] [options]    # ALM health and performance statistics
  node scripts/harness.mjs inspect <issueKey> [logfile] # Chronological issue lifecycle report
  node scripts/harness.mjs replay <logfile> [--speed N] # Replay log session with timing

Filtering Options:
  -i, --issue <key>      Filter by Jira issue key (e.g. VJIRA-18)
  -c, --category <cats>  Filter by category (e.g. GATE,RESTORE,VAULT)
  -e, --errors           Show errors, warnings, and gate denials only
  -a, --action <pattern> Filter by action name pattern
  -t, --trace <id>       Filter by correlation/trace ID
      --json             Output raw NDJSON format
  -o, --output <file>    Append events to a file
`);
  }
}
