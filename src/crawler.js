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

// WordPress system paths/patterns to ignore when wordpressMode is enabled.
const WP_PATH_PATTERNS = [
  /\/wp-admin(\/|$)/i,
  /\/wp-login\.php/i,
  /\/wp-json(\/|$)/i,
  /\/wp-content\/uploads\//i,
  /\/wp-includes(\/|$)/i,
  /\/xmlrpc\.php/i,
  /\/feed\/?$/i,
  /\/comments\/feed/i,
  /\/trackback\/?$/i,
  /\/author\//i,
  /\/tag\//i,
  /\/category\//i,
  /\/page\/\d+/i,
  /\/\?(p|page_id|preview|replytocom|attachment_id)=/i,
];

function isWordPressSystemUrl(u) {
  try {
    const url = new URL(u);
    const full = url.pathname + url.search;
    return WP_PATH_PATTERNS.some((re) => re.test(full));
  } catch {
    return false;
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

export async function runScan({ scanId, url, maxPages, respectRobots, wordpressMode, callbackUrl, callbackSecret, onUpdate }) {
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

        // Wait for delayed client-side scripts (e.g. accessibility plugins
        // that apply DOM fixes after page load) before running axe-core.
        await new Promise((r) => setTimeout(r, 4000));

        await page.addScriptTag({ path: axePath });

        // ===== 1) AXE-CORE: extended ruleset =====
        // Includes WCAG 2.0/2.1/2.2 A & AA, ACT rules and Deque best-practice
        // for the widest possible automatic coverage of EAA / EN 301 549.
        axeRaw = await page.evaluate(async () => {
          // eslint-disable-next-line no-undef
          return await axe.run(document, {
            runOnly: {
              type: "tag",
              values: [
                "wcag2a", "wcag2aa",
                "wcag21a", "wcag21aa",
                "wcag22aa",
                "best-practice",
                "ACT",
              ],
            },
            resultTypes: ["violations", "passes"],
          });
        });

        // ===== 2) KEYBOARD ACCESSIBILITY CHECKS =====
        // Detects focus-visible removed, positive tabindex, focus traps,
        // missing skip links — covers WCAG 2.1.1, 2.4.3, 2.4.7.
        const keyboardIssues = await page.evaluate(() => {
          const out = [];

          // a) :focus { outline: none } without alternative
          const focusables = Array.from(document.querySelectorAll(
            'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])'
          )).slice(0, 50);
          let removedOutline = 0;
          for (const el of focusables) {
            try {
              el.focus({ preventScroll: true });
              const cs = getComputedStyle(el);
              const noOutline = cs.outlineStyle === "none" || cs.outlineWidth === "0px";
              const noBoxShadow = cs.boxShadow === "none";
              const noBorderChange = true; // best-effort
              if (noOutline && noBoxShadow && noBorderChange) removedOutline++;
            } catch {}
          }
          if (focusables.length > 0 && removedOutline / focusables.length > 0.5) {
            out.push({
              id: "focus-visible-missing",
              impact: "serious",
              description: "Many interactive elements appear to have no visible focus indicator (outline:none without alternative). WCAG 2.4.7 Focus Visible.",
              tags: ["wcag2aa", "wcag247", "keyboard"],
              nodes: [{ html: "", target: ["body"] }],
              helpUrl: "https://www.w3.org/WAI/WCAG21/Understanding/focus-visible.html",
            });
          }

          // b) Positive tabindex (anti-pattern)
          const positives = document.querySelectorAll('[tabindex]:not([tabindex="0"]):not([tabindex="-1"])');
          if (positives.length > 0) {
            out.push({
              id: "tabindex-positive",
              impact: "moderate",
              description: `${positives.length} element(s) use positive tabindex which disrupts the natural focus order. WCAG 2.4.3 Focus Order.`,
              tags: ["wcag2a", "wcag243", "keyboard"],
              nodes: Array.from(positives).slice(0, 5).map((n) => ({
                html: n.outerHTML.slice(0, 200),
                target: [n.tagName.toLowerCase()],
              })),
              helpUrl: "https://www.w3.org/WAI/WCAG21/Understanding/focus-order.html",
            });
          }

          // c) Skip link presence
          const firstLink = document.querySelector("a[href^='#']");
          const hasSkipLink = firstLink && /skip|salta|content|main/i.test(firstLink.textContent || "");
          const hasMainLandmark = document.querySelector("main, [role='main']");
          if (!hasSkipLink && hasMainLandmark) {
            out.push({
              id: "skip-link-missing",
              impact: "moderate",
              description: "No skip-to-content link detected as the first focusable element. Recommended for keyboard users. WCAG 2.4.1 Bypass Blocks.",
              tags: ["wcag2a", "wcag241", "keyboard", "best-practice"],
              nodes: [{ html: "", target: ["body"] }],
              helpUrl: "https://www.w3.org/WAI/WCAG21/Understanding/bypass-blocks.html",
            });
          }

          return out;
        });

        // ===== 3) RESPONSIVE / REFLOW CHECK (WCAG 1.4.10) =====
        // Test mobile (375px) and 200% zoom for horizontal overflow.
        const reflowIssues = [];
        try {
          await page.setViewport({ width: 375, height: 800, deviceScaleFactor: 1 });
          await new Promise((r) => setTimeout(r, 500));
          const mobileOverflow = await page.evaluate(() => {
            return {
              docWidth: document.documentElement.scrollWidth,
              viewWidth: window.innerWidth,
            };
          });
          if (mobileOverflow.docWidth > mobileOverflow.viewWidth + 5) {
            reflowIssues.push({
              id: "reflow-mobile-overflow",
              impact: "serious",
              description: `Horizontal scrolling required at 375px viewport (content ${mobileOverflow.docWidth}px > viewport ${mobileOverflow.viewWidth}px). WCAG 1.4.10 Reflow.`,
              tags: ["wcag21aa", "wcag1410", "responsive"],
              nodes: [{ html: "", target: ["html"] }],
              helpUrl: "https://www.w3.org/WAI/WCAG21/Understanding/reflow.html",
            });
          }

          // 200% zoom simulation
          await page.setViewport({ width: 640, height: 800, deviceScaleFactor: 2 });
          await new Promise((r) => setTimeout(r, 300));
          const zoomOverflow = await page.evaluate(() => ({
            docWidth: document.documentElement.scrollWidth,
            viewWidth: window.innerWidth,
          }));
          if (zoomOverflow.docWidth > zoomOverflow.viewWidth + 10) {
            reflowIssues.push({
              id: "reflow-zoom-overflow",
              impact: "moderate",
              description: "Content overflows horizontally at 200% zoom equivalent. WCAG 1.4.4 Resize Text / 1.4.10 Reflow.",
              tags: ["wcag2aa", "wcag144", "wcag1410"],
              nodes: [{ html: "", target: ["html"] }],
              helpUrl: "https://www.w3.org/WAI/WCAG21/Understanding/reflow.html",
            });
          }

          // restore desktop viewport
          await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
        } catch (e) {
          console.warn("reflow check failed", e.message);
        }

        // ===== Merge custom checks into axe results =====
        const customViolations = [...keyboardIssues, ...reflowIssues].map((v) => ({
          id: v.id,
          impact: v.impact,
          description: v.description,
          help: v.description,
          helpUrl: v.helpUrl,
          tags: v.tags,
          nodes: v.nodes.map((n) => ({
            html: n.html,
            target: n.target,
            failureSummary: v.description,
          })),
        }));
        if (axeRaw && Array.isArray(axeRaw.violations)) {
          axeRaw.violations = axeRaw.violations.concat(customViolations);
        }

        // ===== 4) AI SEMANTIC CHECKS (alt, heading, label, language) =====
        try {
          const semanticData = await page.evaluate(() => {
            const altTexts = Array.from(document.querySelectorAll("img[alt]"))
              .filter((img) => img.getAttribute("alt").trim().length > 0)
              .slice(0, 30)
              .map((img) => ({
                src: img.getAttribute("src") || "",
                alt: img.getAttribute("alt") || "",
              }));

            const headings = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6"))
              .slice(0, 40)
              .map((h) => ({
                level: parseInt(h.tagName.substring(1), 10),
                text: (h.textContent || "").trim().slice(0, 200),
              }))
              .filter((h) => h.text.length > 0);

            const formLabels = [];
            for (const f of document.querySelectorAll("input,select,textarea")) {
              const type = f.tagName === "INPUT" ? (f.getAttribute("type") || "text") : f.tagName.toLowerCase();
              if (type === "hidden" || type === "submit" || type === "button") continue;
              const name = f.getAttribute("name") || f.getAttribute("id") || "";
              let label = "";
              const aria = f.getAttribute("aria-label");
              if (aria) label = aria;
              else if (f.id) {
                const lbl = document.querySelector(`label[for="${f.id}"]`);
                if (lbl) label = (lbl.textContent || "").trim();
              }
              if (!label) {
                const parentLabel = f.closest("label");
                if (parentLabel) label = (parentLabel.textContent || "").trim();
              }
              formLabels.push({
                type, name, label: label.slice(0, 120),
                placeholder: f.getAttribute("placeholder") || "",
              });
              if (formLabels.length >= 20) break;
            }

            // Plain text sample from main content
            const main = document.querySelector("main, [role='main'], article") || document.body;
            const text = (main.textContent || "").replace(/\s+/g, " ").trim().slice(0, 2000);

            return { altTexts, headings, formLabels, textSample: text };
          });

          // Derive AI endpoint from callbackUrl base
          const base = callbackUrl.replace(/\/functions\/v1\/scan-callback\/?$/, "");
          const aiUrl = `${base}/functions/v1/analyze-with-ai`;

          const aiRes = await fetch(aiUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url: next, ...semanticData }),
          });

          if (aiRes.ok) {
            const aiData = await aiRes.json();
            const aiViolations = (aiData?.violations ?? []).map((v) => ({
              id: v.id,
              impact: v.impact,
              description: v.description,
              help: v.description,
              helpUrl: v.help_url,
              tags: v.wcag_tags,
              nodes: [{
                html: v.html_snippet || "",
                target: [v.selector || "body"],
                failureSummary: v.description,
              }],
            }));
            if (axeRaw && Array.isArray(axeRaw.violations) && aiViolations.length > 0) {
              axeRaw.violations = axeRaw.violations.concat(aiViolations);
            }
          } else {
            console.warn("AI analysis non-ok", aiRes.status);
          }
        } catch (e) {
          console.warn("AI semantic check failed", e.message);
        }

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
        if (!n || seen.has(n) || !n.startsWith(origin)) continue;
        if (wordpressMode && isWordPressSystemUrl(n)) {
          seen.add(n);
          continue;
        }
        seen.add(n);
        if (seen.size <= maxPages) queue.push(n);
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