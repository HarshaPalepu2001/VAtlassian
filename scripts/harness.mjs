#!/usr/bin/env node

/**
 * VAtlassian ALM Observability Harness CLI
 *
 * Real-time log streamer, event parser, and issue diagnostic inspector.
 * Usage:
 *   node scripts/harness.mjs watch             # Continuous live log stream
 *   node scripts/harness.mjs tail [limit=40]   # Fetch and summarize recent Forge logs
 *   node scripts/harness.mjs parse <logfile>   # Parse and explain events in a log file
 */

import { execSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  bgRed: '\x1b[41m\x1b[37m',
  bgGreen: '\x1b[42m\x1b[30m',
  bgBlue: '\x1b[44m\x1b[37m',
  bgYellow: '\x1b[43m\x1b[30m',
  bgMagenta: '\x1b[45m\x1b[37m'
};

function formatHarnessLine(line) {
  if (!line || !line.trim()) return null;

  // Check if line contains [HARNESS:CATEGORY]
  const match = line.match(/\[HARNESS:([A-Z_]+)\]\s+([^\s]+)?\s*(.*)/);
  if (!match) {
    // Normal Forge log line
    if (line.includes('ERROR')) {
      return `${ANSI.red}${ANSI.bold}🚨 ${line}${ANSI.reset}`;
    }
    if (line.includes('WARN')) {
      return `${ANSI.yellow}⚠️  ${line}${ANSI.reset}`;
    }
    return `${ANSI.dim}${line}${ANSI.reset}`;
  }

  const [, category, action, rest] = match;
  let parsedJson = null;
  if (rest) {
    try {
      parsedJson = JSON.parse(rest);
    } catch {
      // not JSON or partial JSON
    }
  }

  const categoryBadges = {
    CLIENT: `${ANSI.bgBlue} CLIENT ACTION ${ANSI.reset}`,
    UI: `${ANSI.bgBlue} UI ${ANSI.reset}`,
    BRIDGE: `${ANSI.bgMagenta} BRIDGE INVOKE ${ANSI.reset}`,
    WEBAUTHN: `${ANSI.bgGreen} BIOMETRIC / WEBAUTHN ${ANSI.reset}`,
    GATE: `${ANSI.bgYellow} WORKFLOW GATE ${ANSI.reset}`,
    RESTORE: `${ANSI.cyan}${ANSI.bold} RESTORE ${ANSI.reset}`,
    DRIFT: `${ANSI.yellow}${ANSI.bold} DRIFT ${ANSI.reset}`,
    RESOLVER: `${ANSI.blue}${ANSI.bold} RESOLVER ${ANSI.reset}`,
    ERROR: `${ANSI.bgRed} ERROR ${ANSI.reset}`
  };

  const badge = categoryBadges[category] || `[${category}]`;
  const actionName = `${ANSI.bold}${action || ''}${ANSI.reset}`;

  let details = '';
  if (parsedJson) {
    const { issueKey, durationMs, success, error, reason, state, decision, ...others } = parsedJson;
    const parts = [];
    if (issueKey && issueKey !== 'NONE') parts.push(`${ANSI.cyan}issue=${issueKey}${ANSI.reset}`);
    if (decision) parts.push(`${ANSI.magenta}decision=${decision}${ANSI.reset}`);
    if (state) parts.push(`${ANSI.green}state=${state}${ANSI.reset}`);
    if (durationMs !== undefined) parts.push(`${ANSI.dim}${durationMs}ms${ANSI.reset}`);
    if (success !== undefined) parts.push(success ? `${ANSI.green}✓ OK${ANSI.reset}` : `${ANSI.red}✗ FAIL${ANSI.reset}`);
    if (reason) parts.push(`${ANSI.yellow}reason=${reason}${ANSI.reset}`);
    if (error) parts.push(`${ANSI.red}error=${error}${ANSI.reset}`);

    const compactOthers = Object.keys(others).length ? `${ANSI.dim}${JSON.stringify(others)}${ANSI.reset}` : '';
    details = ` ${parts.join(' ')} ${compactOthers}`;
  } else if (rest) {
    details = ` ${rest}`;
  }

  return `${badge} ${actionName}${details}`;
}

export async function startWatcher() {
  console.log(`${ANSI.bold}=== VAtlassian ALM Live Harness Watcher ===${ANSI.reset}`);
  console.log(`${ANSI.dim}Continuous monitoring enabled for one-atlas-mjkg.atlassian.net (environment: development)...${ANSI.reset}\n`);

  const seenLines = new Set();
  let running = true;

  process.on('SIGINT', () => { running = false; });
  process.on('SIGTERM', () => { running = false; });

  while (running) {
    try {
      const output = execSync('forge logs --environment development --limit 30', { encoding: 'utf8' });
      const lines = output.split('\n');
      for (const line of lines) {
        if (!line.trim() || line.includes('Warning: Your version of Forge CLI')) continue;
        if (!seenLines.has(line)) {
          seenLines.add(line);
          if (seenLines.size > 2000) {
            const first = seenLines.values().next().value;
            seenLines.delete(first);
          }
          const formatted = formatHarnessLine(line);
          if (formatted) console.log(formatted);
        }
      }
    } catch {
      // transient error, retry next tick
    }
    await new Promise(r => setTimeout(r, 2500));
  }
}

export function tailLogs(limit = 40) {
  console.log(`${ANSI.bold}=== Fetching last ${limit} Forge log entries ===${ANSI.reset}`);
  try {
    const output = execSync(`forge logs --environment development --limit ${limit}`, { encoding: 'utf8' });
    const lines = output.split('\n');
    let count = 0;
    for (const line of lines) {
      if (line.includes('Warning: Your version of Forge CLI')) continue;
      const formatted = formatHarnessLine(line);
      if (formatted) {
        console.log(formatted);
        count++;
      }
    }
    console.log(`\n${ANSI.green}✓ Shown ${count} recent log lines.${ANSI.reset}`);
  } catch (err) {
    console.error(`${ANSI.red}Error fetching logs: ${err.message}${ANSI.reset}`);
  }
}

export function parseFile(filePath) {
  if (!existsSync(filePath)) {
    console.error(`${ANSI.red}File not found: ${filePath}${ANSI.reset}`);
    return;
  }
  const content = readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  console.log(`${ANSI.bold}=== Parsing Log File: ${filePath} ===${ANSI.reset}\n`);
  for (const line of lines) {
    const formatted = formatHarnessLine(line);
    if (formatted) console.log(formatted);
  }
}

// CLI argument router
const args = process.argv.slice(2);
const command = args[0] || 'watch';

if (command === 'watch') {
  void startWatcher();
} else if (command === 'tail') {
  const limit = parseInt(args[1], 10) || 40;
  tailLogs(limit);
} else if (command === 'parse') {
  parseFile(args[1] || 'logs.txt');
} else {
  console.log(`Usage:
  node scripts/harness.mjs watch             # Stream real-time logs
  node scripts/harness.mjs tail [limit=40]   # Fetch recent logs
  node scripts/harness.mjs parse <logfile>   # Parse local log file
`);
}
