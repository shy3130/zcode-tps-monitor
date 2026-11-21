import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { snapshot } from "./scripts/lib/collect-core.mjs";

const numbers = new Intl.NumberFormat("en-US");
const seconds = (ms) => ms == null ? "—" : `${(ms / 1000).toFixed(1)} 秒`;
const rateText = (rate) => rate == null ? "—" : `${numbers.format(rate)} tok/s`;
const netTime = (ms) => ms > 0 && ms < 1000 ? `${ms} 毫秒` : seconds(ms || null);

function rateTooltip(text, summary, estimating) {
  const lines = [estimating ? `${text} · 流式估算` : text];
  if (summary) {
    const { sessionTurns, turn, current } = summary;
    const count = sessionTurns == null ? "—" : numbers.format(sessionTurns);
    if (turn) {
      const label = current ? "本轮" : "最近一轮";
      lines.push(`会话 ${count} 轮 · ${label} ${turn.requests} 段`);
      const reasoning = turn.totalReasoning > 0 ? ` · 思考 ${numbers.format(turn.totalReasoning)} tok` : "";
      lines.push(`首字 ${seconds(turn.ttftMs)} · 输出 ${numbers.format(turn.totalOutput)} tok${reasoning}`);
      lines.push(turn.rated > 0
        ? `峰值 ${rateText(turn.peak)} · 均速 ${rateText(turn.tokPerSec)}`
        : "峰值 / 均速 · 样本过短");
      lines.push(`净生成 ${netTime(turn.genMs)} · 总用时 ${seconds(turn.totalMs)}`);
    } else {
      lines.push(`会话 ${count} 轮 · ${current ? "本轮等待请求完成" : "暂无请求统计"}`);
    }
  }
  lines.push("点击打开监控面板");
  return lines.join("\n").slice(0, 200);
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
  const fileFor = (sessionId) => join(directory, `${encodeURIComponent(sessionId)}.json`);

  function show(sessionId) {
    const estimate = estimates.get(sessionId);
    const rate = estimate?.rate ?? completed.get(sessionId);
    const text = rate == null ? "— tok/s" : `${estimate ? "≈" : ""}${rate.toFixed(1)} tok/s`;
    const tooltip = rateTooltip(text, summaries.get(sessionId), Boolean(estimate));
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
