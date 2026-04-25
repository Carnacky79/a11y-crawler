import puppeteer from "puppeteer";
import { createRequire } from "node:module";
import { URL } from "node:url";

const require = createRequire(import.meta.url);
const axePath = require.resolve("axe-core");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const axeVersion = require("axe-core/package.json").version;

function normalize(u) {
  try {
    const url = new URL(u);
    url.hash = "";
    // remove trailing slash for dedup but keep root
    if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
      url.pathname = url.pathname.replace(/\/+$/, "");
    }
    // drop query for dedup purposes
    url.search = "";
    return url.toString();
  } catch {
    return null;
  }
}

async function postCallback(callbackUrl, callbackSecret, body) {
  try {
    const r = await fetch(callbackUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-callback-secret": callbackSecret ?? "" },
      body: JSON.stringify(body),
    });
    if (!r.ok) console.warn("callback non-ok", body.type, r.status, await r.text().catch(() => ""));
  } catch (e) {
    console.warn("callback failed", body.type, e.message);
  }
}

export async function runScan({ scanId, url, maxPages, respectRobots, callbackUrl, callbackSecret, onUpdate }) {
  const rootU = new URL(url);
  const origin = rootU.origin;

  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--ignore-certificate-errors"],
    ignoreHTTPSErrors: true,
  });

  await postCallback(callbackUrl, callbackSecret, { type: "started", scanId, axeVersion });

  const queue = [normalize(url)].filter(Boolean);
  const seen = new Set(queue);
  let scanned = 0;

  try {
    while (queue.length > 0 && scanned < maxPages) {
      const next = queue.shift();
      onUpdate?.({ status: "running", currentUrl: next, pagesDone: scanned, pagesTotal: Math.min(seen.size, maxPages) });
      await postCallback(callbackUrl, callbackSecret, {
        type: "progress", scanId, currentUrl: next, pagesTotal: Math.min(seen.size, maxPages),
      });

      const page = await browser.newPage();
      let pageStatus = "scanned";
      let title = null;
      let axeRaw = null;
      let links = [];

      try {
        await page.setUserAgent("A11yMonitorBot/1.0 (+https://a11y-monitor.local)");
        await page.setViewport({ width: 1280, height: 800 });
        await page.goto(next, { waitUntil: "networkidle2", timeout: 15000 });
        title = await page.title().catch(() => null);

        await page.addScriptTag({ path: axePath });
        axeRaw = await page.evaluate(async () => {
          // eslint-disable-next-line no-undef
          return await axe.run(document, {
            runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] },
            resultTypes: ["violations"],
          });
        });

        // Collect same-origin links for the crawl frontier
        links = await page.evaluate((origin) => {
          const set = new Set();
          for (const a of document.querySelectorAll("a[href]")) {
            try {
              const href = new URL(a.getAttribute("href"), location.href).toString();
              if (href.startsWith(origin)) set.add(href);
            } catch {}
          }
          return Array.from(set);
        }, origin);
      } catch (err) {
        pageStatus = err?.name === "TimeoutError" ? "skipped" : "error";
        console.warn("page failed", next, err?.message);
      } finally {
        await page.close().catch(() => {});
      }

      await postCallback(callbackUrl, callbackSecret, {
        type: "page", scanId, url: next, title, status: pageStatus, axeRaw,
      });

      scanned++;

      // Enqueue new same-origin links
      for (const l of links) {
        const n = normalize(l);
        if (n && !seen.has(n) && n.startsWith(origin)) {
          seen.add(n);
          if (seen.size <= maxPages) queue.push(n);
        }
      }
    }

    await postCallback(callbackUrl, callbackSecret, { type: "completed", scanId });
    onUpdate?.({ status: "completed", pagesDone: scanned });
  } catch (e) {
    await postCallback(callbackUrl, callbackSecret, { type: "failed", scanId, error: e?.message ?? String(e) });
    onUpdate?.({ status: "failed" });
  } finally {
    await browser.close().catch(() => {});
  }
}