import { createCanvas, loadImage } from "canvas";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const outputPdf = path.join(root, "docs", "idlefront-project-history.pdf");

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN_X = 54;
const MARGIN_Y = 56;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN_X * 2;
const BOTTOM_PADDING = 60;

const canvas = createCanvas(PAGE_WIDTH, PAGE_HEIGHT, "pdf");
const ctx = canvas.getContext("2d");

const pages = [
  {
    title: "IdleFront Project Chronicle",
    subtitle: "Created 2026-09-09",
    body: [],
  },
];

const commits = execSync(
  'git log --date=short --pretty="%h|%ad|%s" --max-count=180',
  {
    cwd: root,
    encoding: "utf8",
  },
)
  .trim()
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => {
    const [hash, date, ...rest] = line.split("|");
    return { hash, date, subject: rest.join("|") };
  });

const commitByDate = (ts) => {
  const date = new Date(ts);
  for (const c of commits) {
    if (new Date(c.date) <= date) {
      return c;
    }
  }
  return (
    commits[commits.length - 1] ?? { hash: "N/A", date: "n/a", subject: "n/a" }
  );
};

const screenshotFiles = [
  "C:/Users/Administrator/.codex/codex-remote-attachments/019ffe9b-a534-7d42-8167-da6552cdacdc/2335F479-04FF-459C-ACD7-2F4AB5F4FF5A/1-Pasted-Image-1.jpg",
  "C:/Users/Administrator/.codex/codex-remote-attachments/019ffe9b-a534-7d42-8167-da6552cdacdc/7DD2DBA0-37F8-413C-BD19-08DA0E65805A/1-Pasted-Image-1.jpg",
  "C:/Users/Administrator/.codex/codex-remote-attachments/019ffe9b-a534-7d42-8167-da6552cdacdc/FB0A8F92-B771-4710-8860-3A42F38D7CB9/1-Pasted-Image-1.jpg",
  "C:/Users/Administrator/.codex/codex-remote-attachments/019ffe9b-a534-7d42-8167-da6552cdacdc/C5177997-47D3-464E-9456-F78CAC0FA3DC/1-Pasted-Image-1.jpg",
  "C:/Users/Administrator/.codex/codex-remote-attachments/019ffe9b-a534-7d42-8167-da6552cdacdc/DE55C423-E196-4304-B4A1-AA468B976512/1-Pasted-Image-1.jpg",
  "C:/Users/Administrator/.codex/codex-remote-attachments/019ffe9b-a534-7d42-8167-da6552cdacdc/8EF44C77-023A-4713-9504-05A52E1DFADE/1-Pasted-Image-1.jpg",
];

const screenshotMeta = [];
for (const file of screenshotFiles) {
  if (!fs.existsSync(file)) continue;
  const stat = fs.statSync(file);
  const c = commitByDate(stat.mtime);
  screenshotMeta.push({
    file,
    captured: stat.mtime.toISOString().slice(0, 10),
    commit: c.hash,
    date: c.date,
    subject: c.subject,
  });
}

function addPage(title, body) {
  pages.push({ title, subtitle: "", body: [...body] });
}

function sectionLines(lines) {
  return [...lines.map((l) => String(l)), ""];
}

addPage(
  "Project Positioning",
  sectionLines([
    "IdleFront is an independent, non-openfront-branded productized build built on the gameplay law profile",
    "of the OpenFront engine. It preserves core conquest mechanics, unit behavior, diplomacy, and infrastructure systems,",
    "while layering gameplay administration, account continuity, and UI/hosting direction for large-session operation.",
    "",
    "Current objective: preserve game law and behavior while improving stability, observability, and long-session pacing.",
  ]),
);

addPage(
  "OpenFront baseline summary",
  sectionLines([
    "OpenFront provides terrain-based conquest mechanics with territory growth, roads, ships, diplomacy, and",
    "AI pressure cycles that are the gameplay laws this build retains.",
    "",
    "IdleFront uses these mechanics as baseline behavior and is intentionally scoped to avoid redesigning",
    "core conquest pacing, combat rules, and structure progression logic.",
  ]),
);

addPage(
  "Timeline",
  sectionLines([
    ...commits.slice(0, 90).map((c) => `${c.date}  ${c.hash}  ${c.subject}`),
  ]),
);

addPage(
  "Playtest and engineering notes",
  sectionLines([
    "Recent implementation work concentrated on performance and multiplayer reliability for very large worlds.",
    "Primary themes were connection stability, replay startup flow, map viewport scale, UI consistency, and",
    "tooling for visual QA across builds.",
    "",
    "Ongoing items include long-session pacing validation, bot density balancing, and catch-up behavior",
    "for resumption edge cases.",
  ]),
);

addPage(
  "Sentiment analysis (command tone)",
  sectionLines([
    "Prompt tone is execution-oriented and high-velocity.",
    "Early iterations showed urgency with strong feedback on regressions, then stabilized when results were",
    "measurable and playability was restored.",
    "",
    "Recurring high-signal tone patterns:",
    '• "can you do X" = cooperative, direct, testable direction',
    '• "broken" / "can’t spawn" / "black screen" = defect-critical attention',
    '• "good progress" = acceptance loop close enough to continue play.',
  ]),
);

addPage(
  "Implementation state and checkpoint context",
  sectionLines([
    "All gameplay loops reported in this document are based on current branch state from v0.11 planning and",
    "subsequent stabilization work.",
    "",
    "This report intentionally includes commit IDs and timestamps for replayable validation.",
  ]),
);

for (let i = 0; i < screenshotMeta.length; i++) {
  const shot = screenshotMeta[i];
  addPage(
    `Screenshot Evidence ${i + 1}`,
    sectionLines([
      `Source file: ${path.basename(shot.file)}`,
      `Captured: ${shot.captured}`,
      `Stamped commit: ${shot.commit} (${shot.date})`,
      `Message: ${shot.subject}`,
      "",
      "Screenshot image is embedded on this page; commit linkage is intentional for auditability.",
    ]),
  );
}

const pageBodies = [];
let currentTitle = "IdleFront Project Chronicle";

let y = PAGE_HEIGHT - MARGIN_Y;
let pageIndex = 0;

function newPage() {
  if (pageIndex > 0) canvas.addPage(PAGE_WIDTH, PAGE_HEIGHT);
  const localCtx = pageIndex === 0 ? ctx : canvas.getContext("2d");
  localCtx.fillStyle = "#ffffff";
  localCtx.fillRect(0, 0, PAGE_WIDTH, PAGE_HEIGHT);
  localCtx.fillStyle = "#111111";
  localCtx.textBaseline = "top";
  localCtx.textAlign = "left";
  y = PAGE_HEIGHT - MARGIN_Y;
  localCtx.font = "bold 24px Arial";
  localCtx.fillText(pages[pageIndex].title ?? currentTitle, MARGIN_X, 48);
  localCtx.font = "10px Arial";
  localCtx.fillText(pages[pageIndex].subtitle || "", MARGIN_X, 78);
  localCtx.beginPath();
  localCtx.moveTo(MARGIN_X, 94);
  localCtx.lineTo(PAGE_WIDTH - MARGIN_X, 94);
  localCtx.strokeStyle = "#222222";
  localCtx.stroke();
  y = 116;
  pageBodies.push(localCtx);
  pageIndex += 1;
}

function measureTextWidth(text, font) {
  ctx.font = font;
  return ctx.measureText(text).width;
}

function wrapParagraph(ctxRef, text, maxWidth, font, indent = 0) {
  const cleaned = String(text).replace(/\s+/g, " ").trim();
  if (!cleaned) return [""];
  ctxRef.font = font;
  const words = cleaned.split(" ");
  const lines = [];
  let line = "";
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (measureTextWidth(test, font) <= maxWidth - indent) {
      line = test;
    } else {
      if (line) lines.push(line);
      line = w;
      if (measureTextWidth(w, font) > maxWidth - indent) {
        // hard-break long tokens
        let chunk = "";
        for (const ch of w) {
          const next = `${chunk}${ch}`;
          if (measureTextWidth(next, font) <= maxWidth - indent) chunk = next;
          else {
            lines.push(chunk);
            chunk = ch;
          }
        }
        line = chunk;
      }
    }
  }
  if (line) lines.push(line);
  return lines;
}

function ensureSpace(needed) {
  if (y + needed > PAGE_HEIGHT - BOTTOM_PADDING) {
    newPage();
  }
}

function drawTextBlock(ctxRef, paragraphs, opts = {}) {
  const {
    font = "11px Arial",
    lineHeight = 16,
    paragraphGap = 12,
    firstIndent = 0,
    listIndent = 16,
  } = opts;

  ctxRef.font = font;
  for (const para of paragraphs) {
    if (para === "") {
      y += paragraphGap;
      continue;
    }
    const isBullet = typeof para === "string" && para.trim().startsWith("•");
    const indent = isBullet ? listIndent : firstIndent;
    const lines = wrapParagraph(
      ctxRef,
      para,
      CONTENT_WIDTH - indent,
      font,
      indent,
    );
    for (const line of lines) {
      ensureSpace(lineHeight + 1);
      ctxRef.fillText(line, MARGIN_X + indent, y);
      y += lineHeight;
    }
    y += paragraphGap;
  }
}

const imageObjs = new Map();

for (const [pi, page] of pages.entries()) {
  currentTitle = page.title;
  newPage();
  const ctxRef = pageBodies[pi];
  y = 116;

  const body = page.body;

  if (page.title.includes("Screenshot Evidence")) {
    const idx = Number((page.title.match(/(\d+)/) ?? [0, 0])[1]) - 1;
    const shot = screenshotMeta[idx];
    if (shot && shot.file) {
      const img = imageObjs.get(shot.file) ?? (await loadImage(shot.file));
      imageObjs.set(shot.file, img);
      const targetW = Math.min(CONTENT_WIDTH, img.width);
      const targetH = (img.height / img.width) * targetW;
      const maxH = 290;
      const scale = targetH > maxH ? maxH / targetH : 1;
      const w = targetW * scale;
      const h = targetH * scale;
      ensureSpace(h + 20);
      ctxRef.drawImage(img, MARGIN_X, y, w, h);
      y += h + 14;
      ensureSpace(90);
    }
  }

  drawTextBlock(
    ctxRef,
    body,
    page.title.includes("Timeline")
      ? {
          font: '10px "Courier New", Menlo, Consolas, monospace',
          lineHeight: 14,
        }
      : {
          font: "12px Arial",
          lineHeight: 16,
        },
  );

  ctxRef.fillStyle = "#666";
  ctxRef.font = "10px Arial";
  ctxRef.fillText(
    `Page ${pageIndex}`,
    PAGE_WIDTH - MARGIN_X - 52,
    PAGE_HEIGHT - 24,
  );
}

if (!fs.existsSync(path.dirname(outputPdf)))
  fs.mkdirSync(path.dirname(outputPdf), { recursive: true });
const out = canvas.toBuffer("application/pdf");
fs.writeFileSync(outputPdf, out);

console.log(`Generated ${outputPdf}`);
console.log(`Pages: ${pages.length}`);
console.log(`Screenshots included: ${screenshotMeta.length}`);
