import { chromium } from "playwright";
import { flowFor } from "./games/index.mjs";
import { runSteps } from "./games/steps.mjs";

const timeoutMs = Number(process.env.PULSE_TIMEOUT_MS ?? 45_000);
const iframeFallbackMs = Number(process.env.PULSE_IFRAME_FALLBACK_MS ?? 12_000);
const headless = process.env.PULSE_HEADLESS !== "false";
const slackWebhookUrl = process.env.PULSE_SLACK_WEBHOOK_URL ?? "";
const slackSend = process.env.PULSE_SLACK_SEND === "true";
const canvasSelectors = ["#gameParent canvas", "canvas"];
const iframeSelectors = ["iframe"];
const readySelectors = [...canvasSelectors, ...iframeSelectors];

function list(value) {
  return new Set(
    (value ?? "")
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  );
}

function items(value, envName) {
  if (!value) {
    throw new Error(`${envName} is required`);
  }

  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function siteName(baseUrl) {
  const hostname = new URL(baseUrl).hostname.replace(/^www\./, "");
  return hostname.split(".")[0];
}

function gameName(slug) {
  return slug
    .replace(/-originals$/, "")
    .split("-")
    .map((word) =>
      word.length === 1
        ? word.toUpperCase()
        : word[0].toUpperCase() + word.slice(1),
    )
    .join(" ");
}

function configuredSites() {
  const only = list(process.env.PULSE_ONLY_SITES);
  return items(process.env.PULSE_SITES, "PULSE_SITES")
    .map((raw) => {
      const baseUrl = raw.replace(/\/$/, "");
      return { name: siteName(baseUrl), baseUrl };
    })
    .filter(
      (site) =>
        !only.size ||
        only.has(site.name) ||
        only.has(new URL(site.baseUrl).hostname),
    );
}

function configuredGames() {
  const only = list(process.env.PULSE_ONLY_GAMES);
  return items(process.env.PULSE_GAMES, "PULSE_GAMES")
    .map((raw) => {
      const slug = raw.replace(/^\/?originals\//, "").replace(/^\//, "");
      return {
        name: gameName(slug),
        slug,
      };
    })
    .filter((game) => {
      const slugKey = game.slug.toLowerCase();
      return !only.size || only.has(slugKey);
    });
}

async function discoverSlugs(context, site) {
  const slugs = new Set();
  for (const path of ["/games/originals", "/originals"]) {
    const page = await context.newPage();
    try {
      await page.goto(`${site.baseUrl}${path}`, {
        waitUntil: "domcontentloaded",
        timeout: timeoutMs,
      });
      const found = await page.$$eval('a[href*="/originals/"]', (links) =>
        links
          .map(
            (link) =>
              new URL(link.href).pathname.match(/\/originals\/([^/?#]+)/)?.[1],
          )
          .filter(Boolean),
      );
      found.forEach((slug) => slugs.add(slug));
    } catch (error) {
      console.log(
        `SKIP ${site.name}${path} discovery failed: ${error instanceof Error ? error.message : error}`,
      );
    } finally {
      await page.close().catch(() => undefined);
    }
  }
  return slugs;
}

async function buildTargets(context) {
  const targets = [];
  const games = configuredGames();

  for (const site of configuredSites()) {
    const visible = await discoverSlugs(context, site);
    if (!visible.size) {
      console.log(`SKIP ${site.name} no visible originals found`);
      continue;
    }

    for (const game of games) {
      if (!visible.has(game.slug)) {
        console.log(`SKIP ${site.name}/${game.name} not visible`);
        continue;
      }
      targets.push({
        site: site.name,
        name: game.name,
        slug: game.slug,
        url: `${site.baseUrl}/originals/${game.slug}`,
      });
    }
  }

  return targets;
}

async function isVisible(frame, selector) {
  try {
    const locator = frame.locator(selector).first();
    return (await locator.count()) > 0 && (await locator.isVisible());
  } catch {
    return false;
  }
}

async function waitForGame(page) {
  const started = Date.now();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      for (const selector of canvasSelectors) {
        if (await isVisible(frame, selector)) {
          return selector;
        }
      }
    }

    if (Date.now() - started >= iframeFallbackMs) {
      for (const frame of page.frames()) {
        for (const selector of iframeSelectors) {
          if (await isVisible(frame, selector)) {
            return selector;
          }
        }
      }
    }

    await page.waitForTimeout(300);
  }
  return null;
}

async function checkGame(context, game) {
  const page = await context.newPage();
  const started = Date.now();
  const failedRequests = [];

  page.on("requestfailed", (request) => {
    const failure = request.failure();
    if (failedRequests.length < 3) {
      failedRequests.push(
        `${request.method()} ${request.url()}${failure?.errorText ? ` :: ${failure.errorText}` : ""}`,
      );
    }
  });

  try {
    const response = await page.goto(game.url, {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    });
    const status = response?.status() ?? 0;
    if (status >= 400) {
      throw new Error(`HTTP ${status}`);
    }

    const ready = await waitForGame(page);

    const flow = flowFor(game.slug);
    const flowResult = flow ? await runSteps(flow.steps, page) : { ok: true, failed: null };

    return {
      ...game,
      ok: flowResult.ok,
      ready,
      ms: Date.now() - started,
      error: flowResult.ok ? null : `failed step: ${flowResult.failed}`,
      failedRequests,
    };
  } catch (error) {
    return {
      ...game,
      ok: false,
      ready: null,
      ms: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
      failedRequests,
    };
  } finally {
    await page.close().catch(() => undefined);
  }
}

async function maybeNotify(results) {
  const failed = results.filter((result) => !result.ok);
  if (!failed.length) {
    console.log("Slack: no failures, no message sent.");
    return;
  }

  const bySite = new Map();
  for (const result of failed) {
    const games = bySite.get(result.site) ?? new Map();
    if (!games.has(result.name)) {
      games.set(result.name, result.error ?? "failed");
    }
    bySite.set(result.site, games);
  }

  const lines = ["PULSE: URGENT! 🚨 Non-working games detected:"];
  for (const [site, games] of bySite) {
    lines.push(`${site}:`);
    for (const [game, error] of games) {
      lines.push(`- ${game}: ${error}`);
    }
  }
  const text = lines.join("\n");

  if (!slackWebhookUrl) {
    console.log(`Slack: dry-run, no webhook configured. Would post:\n${text}`);
    return;
  }

  if (!slackSend) {
    console.log(`Slack: dry-run, no message sent. Would post:\n${text}`);
    return;
  }

  const response = await fetch(slackWebhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!response.ok) {
    throw new Error(`Slack webhook failed: HTTP ${response.status}`);
  }
}

function printResults(results) {
  for (const result of results) {
    const label = `${result.site}/${result.name}`.padEnd(28);
    if (result.ok) {
      console.log(
        `OK   ${label} ${String(result.ms).padStart(5)}ms ${result.ready}`,
      );
    } else {
      console.log(
        `FAIL ${label} ${String(result.ms).padStart(5)}ms ${result.error}`,
      );
      for (const request of result.failedRequests) {
        console.log(`     ${request}`);
      }
    }
  }

  const failed = results.filter((result) => !result.ok);
  console.log(
    `\nSummary: ${results.length - failed.length}/${results.length} healthy`,
  );
}

async function main() {
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    ignoreHTTPSErrors: true,
  });

  try {
    const targets = await buildTargets(context);
    if (!targets.length) {
      throw new Error(
        "No visible games selected. Check PULSE_SITES/PULSE_GAMES/PULSE_ONLY_*.",
      );
    }

    const results = [];
    for (const game of targets) {
      results.push(await checkGame(context, game));
    }
    printResults(results);
    await maybeNotify(results);

    if (results.some((result) => !result.ok)) {
      process.exitCode = 1;
    }
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
