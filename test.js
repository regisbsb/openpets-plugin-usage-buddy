import assert from "node:assert/strict";
import {
  register,
  summaryLine,
  maxEntry,
  bandFor,
  prettyWindow,
  parseThresholds,
} from "./index.js";

let createTestHarness;
try {
  ({ createTestHarness } = await import("@open-pets/plugin-sdk/testing"));
} catch {
  ({ createTestHarness } = await import("./node_modules/@open-pets/plugin-sdk/dist/testing.js"));
}

const permissions = [
  "pet:speak",
  "pet:reaction",
  "commands",
  "status",
  "schedule",
  "network",
  "storage",
];
const locales = {
  en: JSON.parse(
    await (await import("node:fs/promises")).readFile(
      new URL("./locales/en.json", import.meta.url),
      "utf8",
    ),
  ),
};

const config = {
  pollSeconds: 20,
  port: 45455,
  providerFilter: "both",
  thresholds: "50,75,90,100",
  quietStatus: false,
};

const USAGE_URL = "http://127.0.0.1:45455/usage";

function contract({ claude5h, claude7d, codex7d }) {
  return {
    schema: 1,
    generated_at: "2026-08-25T12:34:56Z",
    providers: {
      claude: {
        display_name: "Claude",
        stale: false,
        error: null,
        windows: {
          five_hour: { utilization: claude5h, resets_at: "2026-08-25T17:00:00Z" },
          seven_day: { utilization: claude7d, resets_at: "2026-09-01T00:00:00Z" },
        },
      },
      codex: {
        display_name: "Codex",
        stale: false,
        error: null,
        windows: {
          seven_day: { utilization: codex7d, resets_at: "2026-09-01T00:00:00Z" },
        },
      },
    },
  };
}

// --- Pure helper unit tests -------------------------------------------------

const snapshot = contract({ claude5h: 12, claude7d: 1, codex7d: 3 });
assert.equal(
  summaryLine(snapshot, "both"),
  "Claude 5h: 12% 7d: 1% Codex 7d: 3%",
  "summaryLine rolls up every window led by display_name",
);
assert.equal(summaryLine(snapshot, "codex"), "Codex 7d: 3%", "summaryLine honors provider filter");
assert.equal(prettyWindow("seven_day_sonnet"), "7d Sonnet", "prettyWindow prettifies unknown suffixes");
assert.equal(maxEntry(snapshot, "both").pct, 12, "maxEntry finds the highest utilization");
assert.equal(maxEntry(snapshot, "both").name, "Claude", "maxEntry reports the provider display_name");
assert.deepEqual(parseThresholds("90, 50 ,75,100"), [50, 75, 90, 100], "parseThresholds sorts");
assert.equal(bandFor(12, "50,75,90,100"), 0, "12% is band 0 (chill)");
assert.equal(bandFor(80, "50,75,90,100"), 2, "80% is band 2 (toasty)");
assert.equal(bandFor(100, "50,75,90,100"), 4, "100% is band 4 (empty)");

// --- (a) First tick: informative summary + status, no band personality line -

const h = createTestHarness(register, { permissions, locales, config });
h.net.mock(USAGE_URL, { json: contract({ claude5h: 12, claude7d: 1, codex7d: 3 }) });

await h.start();

assert.ok(h.calls.commands.has("usage-now"), "registers the Usage Now command");
assert.ok(h.calls.schedules.has("poll"), "schedules the poll loop");
assert.equal(h.calls.speak.length, 1, "first run speaks exactly once");
assert.equal(
  h.calls.speak[0],
  "Claude 5h: 12% 7d: 1% Codex 7d: 3%",
  "first run speaks the informative summary (no band line)",
);
assert.ok(
  h.calls.status.some((status) => status.text === "Claude 5h: 12% 7d: 1% Codex 7d: 3%" && status.tone === "success"),
  "first run sets the summary status",
);
assert.equal(h.calls.react.length, 0, "first run does not react on a crossing");
assert.ok(h.calls.storage.has("band:claude:five_hour"), "first run seeds bands");

// --- (b) Upward crossing pushes a speak (with display name) AND a react ------

h.net.mock(USAGE_URL, { json: contract({ claude5h: 80, claude7d: 1, codex7d: 3 }) });
await h.clock.advance("20s");

assert.equal(h.calls.speak.length, 2, "upward crossing adds one spoken line");
assert.match(h.calls.speak[1], /^Claude/, "band line starts with the provider display name");
assert.match(h.calls.speak[1], /toasty/i, "band line uses the toasty template");
assert.match(h.calls.speak[1], /80% 5h/, "band line includes pct and window tokens");
assert.ok(h.calls.react.includes("working"), "upward crossing triggers a reaction");

// --- (c) No upward crossing stays quiet -------------------------------------

const speakCountAfterCrossing = h.calls.speak.length;
h.net.mock(USAGE_URL, { json: contract({ claude5h: 80, claude7d: 1, codex7d: 3 }) });
await h.clock.advance("20s");
assert.equal(h.calls.speak.length, speakCountAfterCrossing, "no new speak without an upward crossing");

h.expectNoErrors();
await h.stop();

// --- (d) Offline / thrown fetch sets warning status and does not speak -------

const offline = createTestHarness(register, { permissions, locales, config });
// No net mock registered -> ctx.net.fetch throws -> treated as offline.
await offline.start();

assert.equal(offline.calls.speak.length, 0, "offline monitor never speaks");
assert.ok(
  offline.calls.status.some((status) => status.text === "Usage monitor offline" && status.tone === "warning"),
  "offline monitor sets a warning status",
);
offline.expectNoErrors();
await offline.stop();

console.log("Usage Buddy tests passed.");
