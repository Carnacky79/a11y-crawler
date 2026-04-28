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

// Common demo / theme leftover paths that typically return 404 on production
// WordPress installs (e.g. theme demo content not imported).
const WP_DEMO_PATTERNS = [
  /\/wp\//i,            // /wp/<theme>/...
  /\/wotech(\/|$)/i,    // demo theme namespace
  /\/demo(\/|$)/i,
  /\/sample-page/i,
];

function isWordPressSystemUrl(u) {
  try {
    const url = new URL(u);
    const full = url.pathname + url.search;
    return WP_PATH_PATTERNS.some((re) => re.test(full))
      || WP_DEMO_PATTERNS.some((re) => re.test(full));
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
        const resp = await page.goto(next, { waitUntil: "networkidle2", timeout: 15000 });
        const httpStatus = resp?.status?.() ?? 0;
        // Skip 4xx/5xx pages: they are not real content and pollute the report
        // (e.g. WordPress demo theme leftover URLs returning 404).
        if (httpStatus >= 400) {
          pageStatus = "skipped";
          console.warn("skip non-200", next, httpStatus);
          await page.close().catch(() => {});
          await postCallback(callbackUrl, callbackSecret, {
            type: "page", scanId, url: next, title: null, status: pageStatus, axeRaw: null,
          });
          scanned++;
          continue;
        }
        title = await page.title().catch(() => null);

        // Wait for delayed client-side scripts (e.g. accessibility plugins
        // that apply DOM fixes after page load) before running axe-core.
        await new Promise((r) => setTimeout(r, 4000));

        await page.addScriptTag({ path: axePath });

        // ===== 1) AXE-CORE: extended ruleset =====
        // Strictly WCAG 2.0/2.1/2.2 Level A & AA — the legal scope of the
        // European Accessibility Act / EN 301 549. We deliberately exclude:
        //  - "best-practice": noisy `region` rule and similar non-normative checks
        //  - "ACT": overlap with WCAG rules, often redundant
        //  - "wcag2aaa" / "wcag21aaa" / "wcag22aaa": AAA is out of EAA scope
        //    (e.g. color-contrast-enhanced is AAA).
        axeRaw = await page.evaluate(async () => {
          // eslint-disable-next-line no-undef
          return await axe.run(document, {
            runOnly: {
              type: "tag",
              values: [
                "wcag2a", "wcag2aa",
                "wcag21a", "wcag21aa",
                "wcag22aa",
              ],
            },
            resultTypes: ["violations", "passes"],
          });
        });

        // ===== 1-bis) AXE-CORE: best-practice (advisory only) =====
        // Eseguiamo una seconda passata sulle regole categorizzate da axe come
        // "best-practice" (es. region, heading-order, landmark-one-main,
        // page-has-heading-one, scrollable-region-focusable). Queste NON sono
        // mappate su Success Criteria WCAG livello A/AA, quindi non costituiscono
        // non conformità ai fini EAA / EN 301 549. Le marchiamo con prefisso
        // "bp-" sul rule_id così la UI/export possono mostrarle separatamente
        // ed escluderle dai conteggi di conformità.
        try {
          const bpRaw = await page.evaluate(async () => {
            // eslint-disable-next-line no-undef
            return await axe.run(document, {
              runOnly: { type: "tag", values: ["best-practice"] },
              resultTypes: ["violations"],
            });
          });
          if (bpRaw && Array.isArray(bpRaw.violations) && axeRaw && Array.isArray(axeRaw.violations)) {
            const tagged = bpRaw.violations.map((v) => ({
              ...v,
              id: `bp-${v.id}`,
              tags: Array.isArray(v.tags) ? [...v.tags, "best-practice"] : ["best-practice"],
            }));
            axeRaw.violations = axeRaw.violations.concat(tagged);
          }
        } catch (e) {
          console.warn("best-practice pass failed", e.message);
        }

        // ===== POST-PROCESS: filter false-positive nested-interactive =====
        // axe-core flags nested-interactive on raw DOM markup even when the
        // nested interactive descendants are effectively removed from the
        // accessibility tree via aria-hidden="true" + tabindex="-1" or
        // the `inert` attribute. We re-evaluate each flagged node and drop
        // it if all interactive descendants are AT-hidden.
        try {
          if (axeRaw && Array.isArray(axeRaw.violations)) {
            const niIdx = axeRaw.violations.findIndex((v) => v.id === "nested-interactive");
            if (niIdx !== -1) {
              const ni = axeRaw.violations[niIdx];
              const targets = ni.nodes.map((n) => Array.isArray(n.target) ? n.target[0] : n.target);
              const keepFlags = await page.evaluate((sels) => {
                const INTERACTIVE = "a[href],button,input,select,textarea,[role='button'],[role='link'],[role='checkbox'],[role='radio'],[role='menuitem'],[role='tab'],[tabindex]:not([tabindex='-1'])";
                function isATHidden(el) {
                  let cur = el;
                  while (cur && cur !== document.body) {
                    if (cur.getAttribute && cur.getAttribute("aria-hidden") === "true") return true;
                    if (cur.hasAttribute && cur.hasAttribute("inert")) return true;
                    cur = cur.parentElement;
                  }
                  return false;
                }
                return sels.map((sel) => {
                  try {
                    const el = document.querySelector(sel);
                    if (!el) return true; // keep if we can't resolve
                    const inner = el.querySelectorAll(INTERACTIVE);
                    if (inner.length === 0) return true;
                    // keep (= real violation) only if at least one nested
                    // interactive descendant is NOT AT-hidden / inert
                    for (const child of inner) {
                      if (child === el) continue;
                      const tabindex = child.getAttribute("tabindex");
                      const ariaHidden = isATHidden(child);
                      if (!ariaHidden && tabindex !== "-1") return true;
                    }
                    return false; // all nested interactives are AT-hidden → drop
                  } catch {
                    return true;
                  }
                });
              }, targets);
              const filteredNodes = ni.nodes.filter((_, i) => keepFlags[i]);
              if (filteredNodes.length === 0) {
                axeRaw.violations.splice(niIdx, 1);
              } else {
                ni.nodes = filteredNodes;
              }
            }
          }
        } catch (e) {
          console.warn("nested-interactive post-filter failed", e.message);
        }

        // ===== 2) KEYBOARD ACCESSIBILITY CHECKS =====
        // Detects focus-visible removed, positive tabindex, focus traps,
        // missing skip links — covers WCAG 2.1.1, 2.4.3, 2.4.7.
        const keyboardIssues = await page.evaluate(() => {
          const out = [];

          // NOTE: focus-visible cannot be reliably detected via getComputedStyle
          // because :focus-visible pseudo-class state is not reflected. Removed
          // to avoid systematic false positives. axe-core covers basic cases.

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

          // NOTE: skip-link detection removed. Heuristics based on first
          // anchor + text matching produced systematic false positives on
          // sites that DO have a skip link rendered after a hidden landmark
          // or via JS. axe-core's `bypass` rule already covers WCAG 2.4.1.

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
          // Tolerance raised: scrollbars, off-canvas menus, and fixed-width
          // ads/embeds commonly cause minor overflow that is not a real
          // WCAG 1.4.10 violation. Only flag when overflow exceeds 50px.
          if (mobileOverflow.docWidth > mobileOverflow.viewWidth + 50) {
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