import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { snapshot } from "./scripts/lib/collect-core.mjs";

const numbers = new Intl.NumberFormat("en-US");
const compactNumbers = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const compact = (value) => compactNumbers.format(value).replace(/K$/, "k");
const rateValue = (value) => value < 1000 ? value.toFixed(1) : compact(value);
const countText = (value) => value == null ? "—" : numbers.format(value);
const englishCount = (value, noun) => `${countText(value)} ${noun}${value === 1 ? "" : "s"}`;
const seconds = (ms, unit) => ms == null ? "—" : `${(ms / 1000).toFixed(1)} ${unit}`;
const netTime = (ms, copy) => ms > 0 && ms < 1000 ? `${ms} ${copy.milliseconds}` : seconds(ms || null, copy.seconds);

const chinese = {
  live: "流式估算",
  last: "最近一段",
  turns: (count) => `会话 ${countText(count)} 轮`,
  segments: (count, current) => `${current ? "本轮" : "最近一轮"} ${countText(count)} 段`,
  waiting: "本轮等待请求完成",
  empty: "暂无请求统计",
  output: "输出",
  reasoning: "思考",
  peak: "峰值",
  avg: "均速",
  tooShort: "样本过短",
  first: "首字",
  net: "净生成",
  total: "总用时",
  seconds: "秒",
  milliseconds: "毫秒",
  open: "点击打开监控面板",
};

const english = {
  live: "Live estimate",
  last: "Last segment",
  turns: (count) => englishCount(count, "turn"),
  segments: (count, current) => `${englishCount(count, "segment")} ${current ? "this" : "last"} turn`,
  waiting: "Waiting for request to finish",
  empty: "No request stats",
  output: "Output",
  reasoning: "Reasoning",
  peak: "Peak",
  avg: "Avg",
  tooShort: "Sample too short",
  first: "TTFT",
  net: "Net gen",
  total: "Total",
  seconds: "s",
  milliseconds: "ms",
  open: "Open TPS monitor",
};

const copyForLocale = (locale) => /^zh(?:[-_]|$)/i.test(locale) ? chinese : english;

function rateTooltip(text, summary, rateLabel, copy) {
  const lines = [rateLabel ? `${text} · ${rateLabel}` : text];
  if (summary) {
    const { sessionTurns, turn, current } = summary;
    const turns = copy.turns(sessionTurns);
    if (turn) {
      const reasoning = turn.totalReasoning > 0 ? ` · ${copy.reasoning} ${compact(turn.totalReasoning)} tok` : "";
      lines.push(
        `${turns} · ${copy.segments(turn.requests, current)}`,
        "",
        `${copy.output} ${compact(turn.totalOutput)} tok${reasoning}`,
        turn.rated > 0
          ? `${copy.peak} ${rateValue(turn.peak)} · ${copy.avg} ${rateValue(turn.tokPerSec)} tok/s`
          : `${copy.peak} / ${copy.avg} · ${copy.tooShort}`,
        `${copy.first} ${seconds(turn.ttftMs, copy.seconds)} · ${copy.net} ${netTime(turn.genMs, copy)}`,
        `${copy.total} ${seconds(turn.totalMs, copy.seconds)}`,
      );
    } else {
      lines.push(`${turns} · ${current ? copy.waiting : copy.empty}`);
    }
  }
  const tooltip = [...lines, "", copy.open].join("\n");
  // Fit long English cards without cutting a value or the monitor action.
  if (tooltip.length <= 200) return tooltip;
  const body = lines.filter(Boolean).join("\n");
  const limit = 199 - copy.open.length;
  const end = body.length <= limit ? body.length : Math.max(0, body.lastIndexOf("\n", limit));
  return `${body.slice(0, end)}\n${copy.open}`;
}

function supportsDesktopVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:\+[\w.-]+)?$/.exec(version);
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  return major > 3 || (major === 3 && (minor > 18 || (minor === 18 && patch >= 2)));
}

export async function activate(ctx) {
  // The extension API version is also 1.4.0 on ZCode 3.18.0 and 3.18.1.
  let version;
  try {
    const manifest = join(process.resourcesPath, "app.asar", "package.json");
    ({ version } = JSON.parse(readFileSync(manifest, "utf8")));
  } catch {
    ctx.log.warn("Could not determine the ZCode Desktop version. TPS requires ZCode 3.18.2 or later.");
    return;
  }
  if (!supportsDesktopVersion(version)) {
    ctx.log.warn(`TPS requires ZCode 3.18.2 or later (installed: ${version}).`);
    return;
  }

  const directory = join(ctx.extension.dataPath, "rates");
  const completed = new Map();
  const estimates = new Map();
  const summaries = new Map();
  let copy = copyForLocale(Intl.DateTimeFormat().resolvedOptions().locale);
  const fileFor = (sessionId) => join(directory, `${encodeURIComponent(sessionId)}.json`);

  function show(sessionId) {
    const estimate = estimates.get(sessionId);
    const rate = estimate?.rate ?? completed.get(sessionId);
    const text = rate == null ? "— tok/s" : `${rateValue(rate)} tok/s`;
    const rateLabel = estimate ? copy.live : rate == null ? "" : copy.last;
    const tooltip = rateTooltip(text, summaries.get(sessionId), rateLabel, copy);
    ctx.slots.update("tps", { text, tooltip }, sessionId ? { sessionId } : "app");
  }

  async function refreshStats(sessionId, current = false) {
    try {
      const { queryTurn } = await import("./scripts/token-rate.mjs");
      current ||= estimates.has(sessionId);
      summaries.set(sessionId, { ...queryTurn(sessionId, { current, composer: true }), current });
      show(sessionId);
    } catch (error) {
      ctx.log.warn("Could not refresh TPS details", error);
    }
  }

  function restore(sessionId) {
    if (!completed.has(sessionId)) {
      let rate = null;
      try {
        const saved = JSON.parse(readFileSync(fileFor(sessionId), "utf8"));
        if (Number.isFinite(saved) && saved > 0) rate = saved;
      } catch (error) {
        if (error.code !== "ENOENT") ctx.log.warn("Could not read saved token rate", error);
      }
      completed.set(sessionId, rate);
    }
    show(sessionId);
    return refreshStats(sessionId);
  }

  function restoreVisible(sessions) {
    return Promise.all(sessions
      .filter(({ sessionId }) => !estimates.has(sessionId))
      .map(({ sessionId }) => restore(sessionId)));
  }

  show(null);
  ctx.env?.onDidChange?.(({ locale }) => {
    const next = copyForLocale(locale);
    if (next === copy) return;
    copy = next;
    show(null);
    for (const sessionId of new Set([...completed.keys(), ...estimates.keys()])) show(sessionId);
  });
  ctx.views.register("dashboard", {
    entry: "./dashboard/index.html",
    tools: {
      sessions: {
        async run(_input, { view }) {
          const { querySessions } = await import("./scripts/token-rate.mjs");
          const data = querySessions();
          const sessions = data.sessions.map((session) => {
            const estimate = estimates.get(session.sessionId)?.rate;
            const requestRate = estimate ?? completed.get(session.sessionId);
            if (requestRate == null) return session;
            return { ...session, requestRate, requestRateEstimated: estimate != null };
          });
          return { ...data, sessions, focusedSessionId: view.sessionId };
        },
      },
      metrics: { run: () => snapshot({}) },
    },
  });
  ctx.commands.register("open-dashboard", ({ scope }) => {
    const target = scope.kind === "session" ? { sessionId: scope.sessionId }
      : scope.kind === "workspace" ? { workspace: scope.workspace }
        : "app";
    return ctx.views.open("dashboard", target);
  });
  ctx.workbench.onDidChange(({ sessions }) => restoreVisible(sessions));
  ctx.models.onDidGenerate(({ sessionId, requestId, phase, outputTokensPerSecond: rate }) => {
    if (!Number.isFinite(rate) || rate <= 0) return;
    const previous = estimates.get(sessionId);
    const newRequest = !previous || previous.requestId !== requestId;
    if (newRequest) summaries.delete(sessionId);
    if (phase === "streaming") {
      estimates.set(sessionId, { requestId, rate });
      show(sessionId);
      return newRequest ? refreshStats(sessionId, true) : undefined;
    }

    estimates.delete(sessionId);
    completed.set(sessionId, rate);
    show(sessionId);
    const destination = fileFor(sessionId);
    try {
      mkdirSync(directory, { recursive: true });
      writeFileSync(`${destination}.tmp`, JSON.stringify(rate), { mode: 0o600 });
      renameSync(`${destination}.tmp`, destination);
    } catch (error) {
      ctx.log.warn("Could not save completed token rate", error);
    }
    return refreshStats(sessionId, true);
  });
  await restoreVisible(await ctx.workbench.visibleSessions());
}
