const DEFAULT_MESSAGE = "Usage Buddy is watching your quota.";
const MAX_MESSAGE_LENGTH = 120;
const FETCH_TIMEOUT_MS = 4000;

// Ordered band names, low -> high. Index is the count of thresholds a
// utilization percent has met or exceeded (see bandFor).
const BAND_NAMES = ["chill", "steady", "toasty", "low", "empty"];

const NUMBER_WORDS = {
  one: "1", two: "2", three: "3", four: "4", five: "5",
  six: "6", seven: "7", eight: "8", nine: "9", ten: "10",
  fifteen: "15", thirty: "30", sixty: "60",
};
const UNIT_WORDS = {
  hour: "h", hours: "h", day: "d", days: "d",
  week: "w", weeks: "w", month: "mo", months: "mo",
  minute: "m", minutes: "m", min: "m",
};

function cleanMessage(value) {
  if (typeof value !== "string") return DEFAULT_MESSAGE;

  const cleaned = value
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_MESSAGE_LENGTH)
    .trim();

  return cleaned || DEFAULT_MESSAGE;
}

export function normalizeConfig(raw) {
  const config = raw && typeof raw === "object" ? raw : {};
  const pollSeconds = Number(config.pollSeconds);
  const port = Number(config.port);
  const filter = config.providerFilter;
  return {
    pollSeconds: Number.isFinite(pollSeconds) ? Math.max(5, pollSeconds) : 20,
    port: Number.isFinite(port) && port > 0 ? Math.trunc(port) : 45455,
    providerFilter: filter === "claude" || filter === "codex" ? filter : "both",
    thresholds: typeof config.thresholds === "string" ? config.thresholds : "50,75,90,100",
    quietStatus: config.quietStatus === true,
  };
}

export function parseThresholds(value) {
  const parsed = String(value ?? "")
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((num) => Number.isFinite(num))
    .sort((a, b) => a - b);
  return parsed.length > 0 ? parsed : [50, 75, 90, 100];
}

export function selectedProviders(providerFilter) {
  if (providerFilter === "claude") return ["claude"];
  if (providerFilter === "codex") return ["codex"];
  return ["claude", "codex"];
}

// five_hour -> 5h, seven_day -> 7d, seven_day_sonnet -> 7d Sonnet, foo_bar -> Foo Bar.
export function prettyWindow(key) {
  const tokens = String(key ?? "").split("_").filter(Boolean);
  const out = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i].toLowerCase();
    const next = i + 1 < tokens.length ? tokens[i + 1].toLowerCase() : null;
    if (token in NUMBER_WORDS && next && next in UNIT_WORDS) {
      out.push(NUMBER_WORDS[token] + UNIT_WORDS[next]);
      i += 1;
    } else if (token in NUMBER_WORDS) {
      out.push(NUMBER_WORDS[token]);
    } else if (token in UNIT_WORDS) {
      out.push(UNIT_WORDS[token]);
    } else {
      out.push(token.charAt(0).toUpperCase() + token.slice(1));
    }
  }
  return out.join(" ") || String(key ?? "");
}

function providerWindows(provider) {
  return provider && provider.windows && typeof provider.windows === "object"
    ? provider.windows
    : {};
}

function displayName(providerId, provider) {
  const name = provider && typeof provider.display_name === "string" ? provider.display_name : "";
  return name || providerId;
}

// Informative roll-up of every window for the selected providers, each group
// led by its provider display_name. Providers without windows are omitted.
export function summaryLine(snapshot, providerFilter) {
  const providers = snapshot && snapshot.providers ? snapshot.providers : {};
  const groups = [];
  for (const id of selectedProviders(providerFilter)) {
    const provider = providers[id];
    if (!provider) continue;
    const windows = providerWindows(provider);
    const parts = [];
    for (const [key, window] of Object.entries(windows)) {
      const pct = window && Number.isFinite(Number(window.utilization)) ? Number(window.utilization) : null;
      if (pct === null) continue;
      parts.push(`${prettyWindow(key)}: ${pct}%`);
    }
    if (parts.length === 0) continue;
    groups.push(`${displayName(id, provider)} ${parts.join(" ")}`);
  }
  return groups.join(" ");
}

// Highest utilization across selected, usable providers/windows, or null.
export function maxEntry(snapshot, providerFilter) {
  const providers = snapshot && snapshot.providers ? snapshot.providers : {};
  let best = null;
  for (const id of selectedProviders(providerFilter)) {
    const provider = providers[id];
    if (!provider || provider.stale === true || provider.error) continue;
    const windows = providerWindows(provider);
    for (const [key, window] of Object.entries(windows)) {
      const pct = window && Number.isFinite(Number(window.utilization)) ? Number(window.utilization) : null;
      if (pct === null) continue;
      if (!best || pct > best.pct) {
        best = {
          providerId: id,
          name: displayName(id, provider),
          key,
          pct,
          resets_at: window && window.resets_at ? window.resets_at : null,
        };
      }
    }
  }
  return best;
}

// A provider is usable when present, fresh, error-free, and has at least one
// window. If none of the selected providers is usable, the monitor is offline.
export function isOffline(snapshot, providerFilter) {
  if (!snapshot || typeof snapshot !== "object") return true;
  const providers = snapshot.providers || {};
  for (const id of selectedProviders(providerFilter)) {
    const provider = providers[id];
    if (!provider || provider.stale === true || provider.error) continue;
    if (Object.keys(providerWindows(provider)).length > 0) return false;
  }
  return true;
}

export function bandFor(pct, thresholds) {
  const value = Number(pct);
  if (!Number.isFinite(value)) return 0;
  let band = 0;
  for (const threshold of parseThresholds(thresholds)) {
    if (value >= threshold) band += 1;
  }
  return band;
}

export function bandName(band) {
  return BAND_NAMES[Math.min(Math.max(band, 0), BAND_NAMES.length - 1)];
}

export function toneFor(pct) {
  const value = Number(pct);
  if (value >= 100) return "error";
  if (value >= 75) return "warning";
  if (value >= 50) return "info";
  return "success";
}

export function reactionFor(pct) {
  const value = Number(pct);
  if (value >= 100) return "error";
  if (value >= 90) return "waiting";
  if (value >= 75) return "working";
  if (value >= 50) return "thinking";
  return "idle";
}

export function pokemonLine(ctx, entry, thresholds) {
  const key = "line." + bandName(bandFor(entry.pct, thresholds));
  return ctx.t(key, {
    name: entry.name,
    pct: entry.pct,
    window: prettyWindow(entry.key),
  });
}

function storageKey(providerId, windowKey) {
  return `band:${providerId}:${windowKey}`;
}

async function fetchSnapshot(ctx, port) {
  const url = "http://127.0.0.1:" + port + "/usage";
  try {
    const res = await ctx.net.fetch(url, { method: "GET", timeoutMs: FETCH_TIMEOUT_MS });
    if (!res || !res.ok) return null;
    const body = res.json !== undefined ? res.json : JSON.parse(res.text);
    return body && typeof body === "object" ? body : null;
  } catch {
    return null;
  }
}

// Persist the current band for every selected provider/window. Used to seed on
// first run and to keep every window's stored band fresh on later ticks.
async function persistBands(ctx, snapshot, providerFilter, thresholds) {
  const providers = snapshot && snapshot.providers ? snapshot.providers : {};
  for (const id of selectedProviders(providerFilter)) {
    const provider = providers[id];
    if (!provider) continue;
    for (const [key, window] of Object.entries(providerWindows(provider))) {
      const pct = window && Number.isFinite(Number(window.utilization)) ? Number(window.utilization) : null;
      if (pct === null) continue;
      await ctx.storage.set(storageKey(id, key), bandFor(pct, thresholds));
    }
  }
}

export async function tick(ctx, { first = false } = {}) {
  const config = normalizeConfig(await ctx.config.get());
  const snapshot = await fetchSnapshot(ctx, config.port);

  if (!snapshot || isOffline(snapshot, config.providerFilter)) {
    await ctx.status.set({ text: ctx.t("status.offline"), tone: "warning" });
    return;
  }

  const summary = cleanMessage(summaryLine(snapshot, config.providerFilter));
  const top = maxEntry(snapshot, config.providerFilter);
  const maxPct = top ? top.pct : 0;
  const tone = toneFor(maxPct);
  const thresholds = parseThresholds(config.thresholds);

  if (!config.quietStatus || tone === "warning" || tone === "error") {
    await ctx.status.set({ text: summary, tone });
  }

  if (first) {
    await ctx.pet.speak(summary);
    await persistBands(ctx, snapshot, config.providerFilter, thresholds);
    return;
  }

  if (top) {
    const key = storageKey(top.providerId, top.key);
    const previous = await ctx.storage.get(key);
    const nextBand = bandFor(top.pct, thresholds);
    if (typeof previous === "number" && nextBand > previous) {
      await ctx.pet.speak(cleanMessage(pokemonLine(ctx, top, thresholds)));
      await ctx.pet.react(reactionFor(top.pct));
    }
  }

  await persistBands(ctx, snapshot, config.providerFilter, thresholds);
}

export function register(OpenPetsPlugin) {
  OpenPetsPlugin.register({
    async start(ctx) {
      const config = normalizeConfig(await ctx.config.get());

      await ctx.commands.register(
        {
          id: "usage-now",
          title: ctx.t("commands.usageNow.title"),
          description: ctx.t("commands.usageNow.description"),
        },
        async () => {
          const current = normalizeConfig(await ctx.config.get());
          const snapshot = await fetchSnapshot(ctx, current.port);
          if (!snapshot || isOffline(snapshot, current.providerFilter)) {
            await ctx.status.set({ text: ctx.t("status.offline"), tone: "warning" });
            return;
          }
          await ctx.pet.speak(cleanMessage(summaryLine(snapshot, current.providerFilter)));
        },
      );

      await ctx.schedule.every("poll", config.pollSeconds * 1000, () => tick(ctx));
      await tick(ctx, { first: true });
    },

    async stop(ctx) {
      await ctx?.schedule?.cancelAll?.();
      await ctx?.status?.clear?.();
    },
  });
}

if (typeof globalThis.OpenPetsPlugin !== "undefined") {
  register(globalThis.OpenPetsPlugin);
}
