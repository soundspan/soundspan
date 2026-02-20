#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv) {
  const flags = new Map();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      fail(`Unexpected positional argument: ${token}`);
    }

    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      fail(`Flag --${key} requires a value.`);
    }
    index += 1;

    flags.set(key, next);
  }

  const input = flags.get("input");
  if (!input) {
    fail("Missing required --input <events.ndjson> flag.");
  }

  const output =
    flags.get("output") ??
    ".agents/docs/architecture/segmented-streaming-baseline.md";
  const label = flags.get("label") ?? "direct-stream-baseline";

  return { input, output, label };
}

function percentile(values, p) {
  if (values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  const index = Math.max(0, Math.min(sorted.length - 1, rank));
  return sorted[index];
}

function average(values) {
  if (values.length === 0) {
    return null;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function toTimestampMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function durationMsToReadable(ms) {
  if (!Number.isFinite(ms) || ms <= 0) {
    return "n/a";
  }

  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }

  return `${(ms / 1000).toFixed(3)}s`;
}

function formatNumber(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "n/a";
  }
  return Number(value).toFixed(digits);
}

function readEvents(inputFile) {
  if (!fs.existsSync(inputFile)) {
    fail(`Input file does not exist: ${inputFile}`);
  }

  const lines = fs.readFileSync(inputFile, "utf8").split(/\r?\n/);
  const events = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      fail(`Invalid JSON on line ${index + 1}: ${error.message}`);
    }

    const eventName = parsed.event ?? parsed.type;
    if (typeof eventName !== "string" || eventName.trim().length === 0) {
      fail(`Missing event/type field on line ${index + 1}.`);
    }

    const sessionId =
      parsed.sessionId ?? parsed.session_id ?? parsed.playbackSessionId ?? "global";
    const tsMs =
      toTimestampMs(parsed.tsMs) ??
      toTimestampMs(parsed.ts) ??
      toTimestampMs(parsed.timestamp) ??
      toTimestampMs(parsed.time);
    if (tsMs === null) {
      fail(`Missing timestamp on line ${index + 1}.`);
    }

    events.push({
      event: eventName.trim(),
      sessionId: String(sessionId),
      tsMs,
      rollingUpdate:
        Boolean(parsed.rollingUpdate) ||
        String(parsed.scenario ?? "").toLowerCase() === "rolling-update",
      seekId: parsed.seekId ?? parsed.seek_id ?? null,
    });
  }

  events.sort((a, b) => a.tsMs - b.tsMs);
  return events;
}

function buildSessionState() {
  return {
    firstPlayTsMs: null,
    firstAudioTsMs: null,
    playingSinceTsMs: null,
    totalPlayMs: 0,
    rebufferCount: 0,
    fatalInterruption: false,
    rollingUpdate: false,
    openSeekStartsById: new Map(),
    openSeekStartsStack: [],
    seekDurationsMs: [],
  };
}

function applyEvent(state, eventRecord) {
  const event = eventRecord.event;

  if (eventRecord.rollingUpdate) {
    state.rollingUpdate = true;
  }

  if (event === "session_start") {
    return;
  }

  if (event === "play") {
    if (state.firstPlayTsMs === null) {
      state.firstPlayTsMs = eventRecord.tsMs;
    }
    if (state.playingSinceTsMs === null) {
      state.playingSinceTsMs = eventRecord.tsMs;
    }
    return;
  }

  if (event === "first_audio") {
    if (state.firstAudioTsMs === null) {
      state.firstAudioTsMs = eventRecord.tsMs;
    }
    return;
  }

  if (event === "pause" || event === "ended" || event === "session_end") {
    if (state.playingSinceTsMs !== null && eventRecord.tsMs >= state.playingSinceTsMs) {
      state.totalPlayMs += eventRecord.tsMs - state.playingSinceTsMs;
      state.playingSinceTsMs = null;
    }
    return;
  }

  if (event === "rebuffer_start") {
    state.rebufferCount += 1;
    return;
  }

  if (event === "fatal_interruption") {
    state.fatalInterruption = true;
    return;
  }

  if (event === "seek_start") {
    if (eventRecord.seekId) {
      state.openSeekStartsById.set(String(eventRecord.seekId), eventRecord.tsMs);
    } else {
      state.openSeekStartsStack.push(eventRecord.tsMs);
    }
    return;
  }

  if (event === "seek_complete") {
    let startTs = null;
    if (eventRecord.seekId) {
      const key = String(eventRecord.seekId);
      if (state.openSeekStartsById.has(key)) {
        startTs = state.openSeekStartsById.get(key);
        state.openSeekStartsById.delete(key);
      }
    }

    if (startTs === null && state.openSeekStartsStack.length > 0) {
      startTs = state.openSeekStartsStack.pop() ?? null;
    }

    if (startTs !== null && eventRecord.tsMs >= startTs) {
      state.seekDurationsMs.push(eventRecord.tsMs - startTs);
    }
  }
}

function finalizeState(state, lastTimestampMs) {
  if (state.playingSinceTsMs !== null && lastTimestampMs >= state.playingSinceTsMs) {
    state.totalPlayMs += lastTimestampMs - state.playingSinceTsMs;
    state.playingSinceTsMs = null;
  }
}

function analyzeEvents(events) {
  if (events.length === 0) {
    return {
      sessionCount: 0,
      startupLatenciesMs: [],
      seekLatenciesMs: [],
      totalPlayMs: 0,
      rebufferCount: 0,
      rollingUpdateSessionCount: 0,
      rollingUpdateFatalInterruptionCount: 0,
    };
  }

  const sessions = new Map();

  for (const eventRecord of events) {
    if (!sessions.has(eventRecord.sessionId)) {
      sessions.set(eventRecord.sessionId, buildSessionState());
    }

    applyEvent(sessions.get(eventRecord.sessionId), eventRecord);
  }

  const lastTimestampMs = events[events.length - 1].tsMs;
  const startupLatenciesMs = [];
  const seekLatenciesMs = [];
  let totalPlayMs = 0;
  let rebufferCount = 0;
  let rollingUpdateSessionCount = 0;
  let rollingUpdateFatalInterruptionCount = 0;

  for (const state of sessions.values()) {
    finalizeState(state, lastTimestampMs);

    if (
      state.firstPlayTsMs !== null &&
      state.firstAudioTsMs !== null &&
      state.firstAudioTsMs >= state.firstPlayTsMs
    ) {
      startupLatenciesMs.push(state.firstAudioTsMs - state.firstPlayTsMs);
    }

    seekLatenciesMs.push(...state.seekDurationsMs);
    totalPlayMs += state.totalPlayMs;
    rebufferCount += state.rebufferCount;

    if (state.rollingUpdate) {
      rollingUpdateSessionCount += 1;
      if (state.fatalInterruption) {
        rollingUpdateFatalInterruptionCount += 1;
      }
    }
  }

  return {
    sessionCount: sessions.size,
    startupLatenciesMs,
    seekLatenciesMs,
    totalPlayMs,
    rebufferCount,
    rollingUpdateSessionCount,
    rollingUpdateFatalInterruptionCount,
  };
}

function buildMarkdownReport(label, inputPath, summary) {
  const startupP95 = percentile(summary.startupLatenciesMs, 95);
  const startupAvg = average(summary.startupLatenciesMs);
  const seekP95 = percentile(summary.seekLatenciesMs, 95);
  const seekAvg = average(summary.seekLatenciesMs);

  const playbackHours = summary.totalPlayMs > 0 ? summary.totalPlayMs / 3600000 : null;
  const rebufferPerHour =
    playbackHours && playbackHours > 0
      ? summary.rebufferCount / playbackHours
      : null;

  const rollingFatalRate =
    summary.rollingUpdateSessionCount > 0
      ? (summary.rollingUpdateFatalInterruptionCount /
          summary.rollingUpdateSessionCount) *
        100
      : null;

  const generatedAt = new Date().toISOString();

  return `# Segmented Streaming Baseline Report

- Label: ${label}
- Generated at (UTC): ${generatedAt}
- Event input: \`${inputPath}\`
- Sessions observed: ${summary.sessionCount}

## Baseline Metrics (Current Path)

| Metric | Value | Sample Size |
| --- | --- | --- |
| Fatal interruption rate during rolling updates | ${formatNumber(rollingFatalRate)}% | ${summary.rollingUpdateSessionCount} rolling-update sessions |
| Rebuffer events per playback hour | ${formatNumber(rebufferPerHour)} | ${formatNumber(playbackHours)} playback hours |
| Startup to first audio P95 | ${durationMsToReadable(startupP95)} | ${summary.startupLatenciesMs.length} startups |
| Startup to first audio average | ${durationMsToReadable(startupAvg)} | ${summary.startupLatenciesMs.length} startups |
| Seek complete P95 | ${durationMsToReadable(seekP95)} | ${summary.seekLatenciesMs.length} seeks |
| Seek complete average | ${durationMsToReadable(seekAvg)} | ${summary.seekLatenciesMs.length} seeks |

## Before/After Comparison Template

Fill these columns as segmented implementation phases land.

| Metric | Baseline (direct stream) | Segmented candidate | Delta | Target |
| --- | --- | --- | --- | --- |
| Fatal interruption rate (rolling update) | ${formatNumber(rollingFatalRate)}% | TBD | TBD | < 0.5% |
| Rebuffer events per playback hour | ${formatNumber(rebufferPerHour)} | TBD | TBD | >= 40% reduction |
| Startup to first audio P95 | ${durationMsToReadable(startupP95)} | TBD | TBD | <= 1.5s |
| Seek complete P95 (local) | ${durationMsToReadable(seekP95)} | TBD | TBD | <= 1.2s |
| Seek complete P95 (provider) | ${durationMsToReadable(seekP95)} | TBD | TBD | <= 2.0s |

## Event Contract Used by This Script

Each input line must be JSON with at least:

- \`event\` (or \`type\`): one of \`session_start\`, \`play\`, \`first_audio\`, \`pause\`, \`ended\`, \`session_end\`, \`seek_start\`, \`seek_complete\`, \`rebuffer_start\`, \`fatal_interruption\`
- \`sessionId\` (or \`session_id\`)
- \`timestamp\` (ISO), or \`tsMs\` (epoch ms)

Optional fields:

- \`rollingUpdate: true\` or \`scenario: "rolling-update"\`
- \`seekId\` to pair seek start/complete events
`;
}

function main() {
  const { input, output, label } = parseArgs(process.argv.slice(2));
  const events = readEvents(input);
  const summary = analyzeEvents(events);
  const markdown = buildMarkdownReport(label, input, summary);

  const outputFile = path.resolve(output);
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, markdown, "utf8");

  console.log(`Wrote baseline report to ${output}`);
}

main();
