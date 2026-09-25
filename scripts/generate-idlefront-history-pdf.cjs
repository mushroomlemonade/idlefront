const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const root = process.cwd();
const outputPdf = path.join(root, "docs", "idlefront-project-history.pdf");

class Pdf {
  constructor() {
    this.objects = [""];
    this.trailerRoot = null;
  }

  addObject(dict, data = null) {
    const id = this.objects.length;
    this.objects.push({ dict, data, isStream: data !== null });
    return id;
  }

  build() {
    const header = Buffer.from("%PDF-1.4\n%\u00E2\u00E3\u00CF\u00D3\n");
    const chunks = [];
    const offsets = [0];
    let cursor = header.length;

    for (let i = 1; i < this.objects.length; i++) {
      const obj = this.objects[i];
      offsets.push(cursor);
      let body;
      if (obj.isStream) {
        const len = obj.data.length;
        const head = `${i} 0 obj\n${obj.dict.replace("__LEN__", String(len))}\nstream\n`;
        const tail = "\nendstream\nendobj\n";
        body = Buffer.concat([Buffer.from(head), obj.data, Buffer.from(tail)]);
      } else {
        body = Buffer.from(`${i} 0 obj\n${obj.dict}\nendobj\n`);
      }
      chunks.push(body);
      cursor += body.length;
    }

    const xrefOffset = header.length + chunks.reduce((a, c) => a + c.length, 0);
    const xref = [
      "xref",
      `0 ${this.objects.length}`,
      "0000000000 65535 f ",
      ...offsets
        .slice(1)
        .map((off) => String(off).padStart(10, "0") + " 00000 n "),
    ];

    const trailer = [
      "trailer",
      `<< /Size ${this.objects.length} /Root ${this.trailerRoot} >>`,
      "startxref",
      String(xrefOffset),
      "%%EOF",
    ];

    return Buffer.concat([
      header,
      ...chunks,
      Buffer.from(xref.join("\n") + "\n"),
      Buffer.from(trailer.join("\n") + "\n"),
    ]);
  }
}

function escapePdf(text) {
  return String(text)
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)")
    .replace(/\r?\n/g, " ");
}

function wrapParagraph(text, maxChars) {
  const words = String(text).replace(/\s+/g, " ").trim().split(" ");
  if (!words.length) return [""];
  const lines = [];
  let line = "";

  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (next.length <= maxChars) {
      line = next;
      continue;
    }
    if (line) lines.push(line);
    if (w.length <= maxChars) {
      line = w;
      continue;
    }
    for (let i = 0; i < w.length; i += maxChars) {
      lines.push(w.slice(i, i + maxChars));
    }
    line = "";
  }
  if (line) lines.push(line);
  if (!lines.length) lines.push("");
  return lines;
}

function formatJpegDimensions(buf) {
  let i = 2;
  while (i < buf.length) {
    while (i < buf.length && buf[i] !== 0xff) i++;
    while (i < buf.length && buf[i] === 0xff) i++;
    if (i >= buf.length) break;
    const marker = buf[i++];
    const len = i + 1 < buf.length ? (buf[i] << 8) | buf[i + 1] : 0;
    const start = i + 2;
    const end = start + Math.max(0, len - 2);
    if (marker >= 0xc0 && marker <= 0xc3 && end <= buf.length && len >= 9) {
      return {
        width: buf.readUInt16BE(start + 3),
        height: buf.readUInt16BE(start + 1),
      };
    }
    i = end;
  }
  return { width: 600, height: 400 };
}

const commits = execSync(
  'git log --date=short --pretty="%h|%ad|%s" --max-count=140',
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

const screenshotFiles = [
  "C:/Users/Administrator/.codex/codex-remote-attachments/019ffe9b-a534-7d42-8167-da6552cdacdc/2335F479-04FF-459C-ACD7-2F4AB5F4FF5A/1-Pasted-Image-1.jpg",
  "C:/Users/Administrator/.codex/codex-remote-attachments/019ffe9b-a534-7d42-8167-da6552cdacdc/7DD2DBA0-37F8-413C-BD19-08DA0E65805A/1-Pasted-Image-1.jpg",
  "C:/Users/Administrator/.codex/codex-remote-attachments/019ffe9b-a534-7d42-8167-da6552cdacdc/FB0A8F92-B771-4710-8860-3A42F38D7CB9/1-Pasted-Image-1.jpg",
  "C:/Users/Administrator/.codex/codex-remote-attachments/019ffe9b-a534-7d42-8167-da6552cdacdc/C5177997-47D3-464E-9456-F78CAC0FA3DC/1-Pasted-Image-1.jpg",
  "C:/Users/Administrator/.codex/codex-remote-attachments/019ffe9b-a534-7d42-8167-da6552cdacdc/DE55C423-E196-4304-B4A1-AA468B976512/1-Pasted-Image-1.jpg",
  "C:/Users/Administrator/.codex/codex-remote-attachments/019ffe9b-a534-7d42-8167-da6552cdacdc/8EF44C77-023A-4713-9504-05A52E1DFADE/1-Pasted-Image-1.jpg",
];

const commitByDate = (ts) => {
  const date = new Date(ts);
  for (const c of commits) {
    if (new Date(c.date) <= date) return c;
  }
  return commits[commits.length - 1];
};

const shots = [];
for (const file of screenshotFiles) {
  if (!fs.existsSync(file)) continue;
  const buffer = fs.readFileSync(file);
  const { width, height } = formatJpegDimensions(buffer);
  const st = fs.statSync(file).mtime;
  const c = commitByDate(st);
  shots.push({
    file,
    buffer,
    width,
    height,
    captured: st.toISOString().slice(0, 10),
    commit: c?.hash ?? "N/A",
    commitDate: c?.date ?? "n/a",
    commitMsg: c?.subject ?? "n/a",
  });
}

const sections = [
  {
    title: "IdleFront Project Chronicle",
    lines: [
      "Created 2026-09-09 as a living operations report for the OpenFront-to-IdleFront evolution project.",
      "This document maps the project history, the preserved gameplay law, and major stability/performance milestones.",
      "OpenFront gameplay rules are retained as the canonical interaction model while interface, hosting, and persistence are adapted for IdleFront.",
      "",
      "Focus",
      "Core mechanics remain intact.",
      "Scale, pacing, reliability, and player-facing UX are the active frontier.",
      "",
      "This version is intended as an auditable checkpoint for multi-week play and coordinated handoff.",
    ],
  },
  {
    title: "OpenFront and IdleFront baseline",
    lines: [
      "OpenFront remains the gameplay substrate.",
      "Core systems retained: terrain conquest, bot behavior patterns, build ordering, combat math, diplomacy, transport pathing, and world initialization constraints.",
      "IdleFront focuses on operational layers around this substrate rather than reinventions of rule math:",
      "• long-run test workflows",
      "• performance-aware iteration",
      "• user-account continuity",
      "• lobby and spawn lifecycle adjustments",
      "• UI/UX redesign for cross-platform use.",
    ],
  },
  {
    title: "Sentiment analysis of prompting language",
    lines: [
      "Language signals across this project record a direct, high-velocity collaboration pattern: concrete requests, explicit acceptance criteria, and rapid retests.",
      "Constructive intent is high where actionable bug fixes are proposed clearly.",
      "Criticality spikes in phases with blocked playtest loops (spawn stalls, black screens, catch-up stalls, and server errors).",
      "Once root causes are isolated and reproducible, feedback shifts to iterative optimization and architecture-level change.",
    ],
  },
];

sections.push({
  title: "Commit timeline (latest first)",
  lines: [
    "The list below tracks active development work in this branch. It is intentionally broad for audit and continuity.",
    ...commits.slice(0, 90).map((c) => `${c.date} ${c.hash} ${c.subject}`),
  ],
});

for (let i = 0; i < shots.length; i++) {
  const s = shots[i];
  sections.push({
    title: `Screenshot evidence ${i + 1}`,
    lines: [
      `Captured: ${s.captured}`,
      `Committed: ${s.commit} (${s.commitDate})`,
      `Commit message: ${s.commitMsg}`,
      "Image is embedded on this page as visual proof-of-iteration.",
      `Source: ${s.file}`,
    ],
    image: s,
  });
}

const pdf = new Pdf();
const fontObj = pdf.addObject(
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
);
const pagesObj = pdf.addObject("<< /Type /Pages /Count 0 /Kids [ ] >>");
const catalogObj = pdf.addObject(`<< /Type /Catalog /Pages ${pagesObj} 0 R >>`);
pdf.trailerRoot = `${catalogObj} 0 R`;
const pageIds = [];

function appendSection(title, lines, imageInfo = null) {
  const wrapped = [];
  for (const line of lines) {
    if (!line) {
      wrapped.push("");
      continue;
    }
    wrapped.push(...wrapParagraph(line, 88));
  }

  const xImage = 56;
  const imageRef = imageInfo
    ? pdf.addObject(
        `<< /Type /XObject /Subtype /Image /Width ${imageInfo.width} /Height ${imageInfo.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${imageInfo.buffer.length} >>`,
        imageInfo.buffer,
      )
    : null;

  let cursor = 0;
  let firstPage = true;
  while (cursor < wrapped.length) {
    let y = firstPage ? 700 : 744;
    const chunks = ["BT"];

    if (firstPage) {
      chunks.push("/F1 20 Tf");
      chunks.push("1 0 0 1 48 760 Tm");
      chunks.push(`(${escapePdf(title)}) Tj`);
      chunks.push("1 0 0 1 0 -28 Tm");
      chunks.push("/F1 11 Tf");
      chunks.push("0 0 0 rg");
      if (imageRef) {
        const scaleW = 500;
        const scale = Math.min(
          scaleW / imageInfo.width,
          220 / imageInfo.height,
          1,
        );
        const w = imageInfo.width * scale;
        const h = imageInfo.height * scale;
        const yImageTop = 392;
        chunks.push(
          `BT /F1 10 Tf 0 0 0 rg 1 0 0 1 ${xImage} ${yImageTop + h + 16} Tm (${escapePdf("Screenshot evidence")}) Tj ET`,
        );
        chunks.push("q");
        chunks.push(
          `${w.toFixed(2)} 0 0 ${h.toFixed(2)} ${xImage} ${yImageTop} cm`,
        );
        chunks.push(`/Im${imageRef} Do`);
        chunks.push("Q");
        y = yImageTop - 16;
      }
    } else {
      chunks.push("/F1 11 Tf");
      chunks.push("0 0 0 rg");
    }

    while (cursor < wrapped.length && y > 64) {
      const text = wrapped[cursor];
      chunks.push(`1 0 0 1 48 ${y.toFixed(2)} Tm`);
      chunks.push(`(${escapePdf(text)}) Tj`);
      chunks.push("T*");
      y -= 16;
      cursor += 1;
    }

    chunks.push("ET");
    const contentId = pdf.addObject(
      "<< /Length __LEN__ >>",
      Buffer.from(chunks.join("\n")),
    );
    const resources = imageRef
      ? `<< /Font << /F1 ${fontObj} 0 R >> /XObject << /Im${imageRef} ${imageRef} 0 R >> >>`
      : `<< /Font << /F1 ${fontObj} 0 R >> >>`;

    pageIds.push(
      pdf.addObject(
        `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 612 792] /Resources ${resources} /Contents ${contentId} 0 R >>`,
      ),
    );
    firstPage = false;
  }
}

for (const section of sections) {
  appendSection(section.title, section.lines, section.image ?? null);
}

pdf.objects[pagesObj].dict =
  `<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.join(" 0 R ")}] >>`;

const result = pdf.build();
fs.mkdirSync(path.dirname(outputPdf), { recursive: true });
fs.writeFileSync(outputPdf, result);
console.log(`Generated ${outputPdf}`);
console.log(`Pages: ${pageIds.length}`);
console.log(`Commits: ${commits.length}, screenshots: ${shots.length}`);
