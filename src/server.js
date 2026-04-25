import express from "express";
import { runScan } from "./crawler.js";

const app = express();
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-callback-secret");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});
app.use(express.json({ limit: "2mb" }));

const inFlight = new Map(); // scanId -> { status, currentUrl, pagesDone, pagesTotal }

app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/scan/:id", (req, res) => {
  const s = inFlight.get(req.params.id);
  if (!s) return res.status(404).json({ error: "not found" });
  res.json(s);
});

app.post("/scan", async (req, res) => {
  const { scanId, url, maxPages = 100, respectRobots = false, callbackUrl, callbackSecret } = req.body ?? {};
  if (!scanId || !url || !callbackUrl) {
    return res.status(400).json({ error: "scanId, url and callbackUrl are required" });
  }
  res.status(202).json({ accepted: true, scanId });

  inFlight.set(scanId, { status: "starting", currentUrl: null, pagesDone: 0, pagesTotal: null });

  runScan({
    scanId, url, maxPages, respectRobots, callbackUrl, callbackSecret,
    onUpdate: (patch) => inFlight.set(scanId, { ...(inFlight.get(scanId) ?? {}), ...patch }),
  }).catch((err) => {
    console.error("scan failed", scanId, err);
  }).finally(() => {
    setTimeout(() => inFlight.delete(scanId), 5 * 60 * 1000);
  });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`A11y crawler listening on :${port}`));