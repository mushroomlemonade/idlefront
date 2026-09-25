import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const outputPdf = path.join(root, "docs", "idlefront-project-history.pdf");

function esc(s) {
  return String(s)
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)")
    .replace(/\r?\n/g, " ");
}

function readImageDim(buf) {
  if (buf.length > 2 && buf.readUInt16BE(0) === 0xffd8) {
    let i = 2;
    while (i < buf.length) {
      while (i < buf.length && buf[i] !== 0xff) i++;
      while (i < buf.length && buf[i] === 0xff) i++;
      if (i >= buf.length) break;
      const marker = buf[i++];
      if (marker === 0xda || marker === 0xd9) break;
      const len = buf.readUInt16BE(i);
      const start = i + 2;
      const end = start + (len - 2);
      if (marker >= 0xc0 && marker <= 0xc3 && end <= buf.length) {
        const components = buf[start + 6];
        const height = buf.readUInt16BE(start + 1);
        const width = buf.readUInt16BE(start + 3);
        const cs =
          components === 1
            ? "/DeviceGray"
            : components === 4
              ? "/DeviceCMYK"
              : "/DeviceRGB";
        return { width, height, colorspace: cs, filter: "DCTDecode" };
      }
      i = end;
    }
  }
  return {
    width: 600,
    height: 400,
    colorspace: "/DeviceRGB",
    filter: "DCTDecode",
  };
}

function textLines(lines, x, yStart, size = 11) {
  const out = [`BT\n/F1 ${size} Tf\n0 0 0 rg`];
  let y = yStart;
  for (const line of lines) {
    if (line === "") {
      y -= 12;
      continue;
    }
    out.push(`1 0 0 1 ${x} ${y.toFixed(2)} Tm`);
    out.push(`(${esc(line)}) Tj`);
    y -= size + 4;
  }
  out.push("ET");
  return out.join("\n");
}

const commits = execSync(
  'git log --date=short --pretty="%h|%ad|%s" --max-count=80',
  { cwd: root, encoding: "utf8" },
)
  .trim()
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => {
    const [hash, date, ...rest] = line.split("|");
    return { hash, date, subject: rest.join("|") };
  });

const shots = [
  "C:/Users/Administrator/.codex/codex-remote-attachments/019ffe9b-a534-7d42-8167-da6552cdacdc/2335F479-04FF-459C-ACD7-2F4AB5F4FF5A/1-Pasted-Image-1.jpg",
  "C:/Users/Administrator/.codex/codex-remote-attachments/019ffe9b-a534-7d42-8167-da6552cdacdc/7DD2DBA0-37F8-413C-BD19-08DA0E65805A/1-Pasted-Image-1.jpg",
  "C:/Users/Administrator/.codex/codex-remote-attachments/019ffe9b-a534-7d42-8167-da6552cdacdc/FB0A8F92-B771-4710-8860-3A42F38D7CB9/1-Pasted-Image-1.jpg",
  "C:/Users/Administrator/.codex/codex-remote-attachments/019ffe9b-a534-7d42-8167-da6552cdacdc/C5177997-47D3-464E-9456-F78CAC0FA3DC/1-Pasted-Image-1.jpg",
  "C:/Users/Administrator/.codex/codex-remote-attachments/019ffe9b-a534-7d42-8167-da6552cdacdc/DE55C423-E196-4304-B4A1-AA468B976512/1-Pasted-Image-1.jpg",
  "C:/Users/Administrator/.codex/codex-remote-attachments/019ffe9b-a534-7d42-8167-da6552cdacdc/8EF44C77-023A-4713-9504-05A52E1DFADE/1-Pasted-Image-1.jpg",
];

const shotData = shots.map((filePath) => {
  const buffer = fs.readFileSync(filePath);
  const meta = fs.statSync(filePath);
  const mtime = meta.mtime;
  const mtext = mtime.toISOString().slice(0, 10);
  const dim = readImageDim(buffer);
  const commit =
    commits.find((c) => new Date(c.date) <= mtime) ??
    commits[commits.length - 1];
  return {
    filePath,
    buffer,
    mtext,
    ...dim,
    commit: commit ? commit.hash : "N/A",
    subject: commit ? commit.subject : "n/a",
    date: commit ? commit.date : "n/a",
  };
});

const objects = [];
function addObj(content, isStream = false, streamOptions = null) {
  const id = objects.length + 1;
  objects.push({ id, content, isStream, streamOptions });
  return id;
}

const fontId = addObj("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
const pagesId = addObj("PLACEHOLDER-PAGES");
const catalogId = addObj(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);

const imageIds = [];

for (const shot of shotData) {
  const imgId = addObj(
    `<< /Type /XObject /Subtype /Image /Width ${shot.width} /Height ${shot.height} /ColorSpace ${shot.colorspace} /BitsPerComponent 8 /Filter /${shot.filter} /Length ${shot.buffer.length} >>`,
    true,
    { streamData: shot.buffer },
  );
  imageIds.push(imgId);
}

const pageIds = [];

function addTextPage(title, lines) {
  const body = [
    "BT",
    "/F1 20 Tf",
    "1 0 0 1 40 760 Tm",
    `(${esc(title)}) Tj`,
    "ET",
    textLines(lines, 40, 725, 11),
  ].join("\n");
  const contentId = addObj(`<< /Length ${Buffer.byteLength(body)} >>`, true, {
    streamData: Buffer.from(body),
  });
  const pageId = addObj(
    `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`,
  );
  pageIds.push(pageId);
}

addTextPage("OpenFront and IdleFront Project Chronicle", [
  "OpenFront is a persistent RTS strategy codebase with OpenFront terrain-based conquest mechanics and naval logistics.",
  "",
  "IdleFront is an independent modified version, built as a standalone product with persistent game flow and",
  "long-session support.",
  "",
  "The design contract used here: preserve OpenFront gameplay laws while evolving UI, orchestration, and hosting patterns.",
  "",
  "Legal/operational guardrails are handled in repository policy docs and licensing notices, including AGPL and copyright notices.",
]);

addTextPage("Timeline of Development Commit Sequence", [
  "Early foundation and compatibility baseline",
  ...commits.slice(0, 35).map((c) => `${c.date} | ${c.hash} | ${c.subject}`),
]);

addTextPage("Sentiment Analysis of Prompting Language", [
  "Overall sentiment trajectory: high-velocity execution + high-precision iteration + tolerance dips when regressions appear.",
  "Dominant polarity: urgent but constructive during production-ready phases.",
  "Positive signals: “good progress,” “can you do X,” “looks promising,” and repeated requests for deeper playtesting.",
  "Stress indicators: “black screen,” “can’t connect,” “laggy,” repeated spawn/timer blocking issues, and 30+ sec response loops.",
  "Expected impact: team confidence increases when playability is restored and evidence pages are provided quickly.",
]);

for (const [i, shotId] of imageIds.entries()) {
  const shot = shotData[i];
  const scale = Math.min(500 / shot.width, 360 / shot.height, 1);
  const w = shot.width * scale;
  const h = shot.height * scale;
  const x = 56;
  const y = 230;
  const lines = [
    `Capture: ${shot.filePath}`,
    `Captured: ${shot.mtext}`,
    `Stamped commit: ${shot.commit} (${shot.date})`,
    `Message: ${shot.subject}`,
    "Image embedded in native PDF for in-doc verification.",
  ];

  const body = [
    "BT\n/F1 20 Tf\n1 0 0 1 40 760 Tm\n",
    `(${esc(`Screenshot ${i + 1} / ${shotData.length}`)}) Tj\n`,
    `ET\n`,
    `q\n${w.toFixed(2)} 0 0 ${h.toFixed(2)} ${x} ${y} cm\n/Im${shotId} Do\nQ\n`,
    textLines(lines, 40, y - 20, 10),
  ].join("");
  const contentId = addObj(`<< /Length ${Buffer.byteLength(body)} >>`, true, {
    streamData: Buffer.from(body),
  });
  const res = `<< /Font << /F1 ${fontId} 0 R >> /XObject << /Im${shotId} ${shotId} 0 R >> >>`;
  const pageId = addObj(
    `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Resources ${res} /Contents ${contentId} 0 R >>`,
  );
  pageIds.push(pageId);
}

objects[pagesId - 1].content =
  `<< /Type /Pages /Kids [${pageIds.join(" 0 R ")} ] /Count ${pageIds.length} >>`;

let body = Buffer.from("");
const offsets = [0];
const chunks = [];
for (const obj of objects) {
  let entry;
  if (obj.isStream) {
    const dict = obj.content;
    const stream = obj.streamOptions.streamData;
    entry = Buffer.concat([
      Buffer.from(`${obj.id} 0 obj\n${dict}\nstream\n`),
      stream,
      Buffer.from("\nendstream\nendobj\n"),
    ]);
  } else {
    entry = Buffer.from(`${obj.id} 0 obj\n${obj.content}\nendobj\n`);
  }
  offsets.push(body.length + entry.length);
  chunks.push(entry);
  body = Buffer.concat([body, entry]);
}

const header = Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n");
const xrefStart = header.length + body.length;
let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
let running = header.length;
for (let i = 0; i < objects.length; i++) {
  xref += `${String(running).padStart(10, "0")} 00000 n \n`;
  if (i === 0) {
    running += Buffer.byteLength(`1 0 obj\n${objects[i].content}\nendobj\n`);
    continue;
  }
  running += chunks[i - 1].length;
}

const trailer = `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;

let out = Buffer.concat([header, body]);
out = Buffer.concat([out, Buffer.from(xref), Buffer.from(trailer)]);

fs.mkdirSync(path.dirname(outputPdf), { recursive: true });
fs.writeFileSync(outputPdf, out);

console.log(`Generated ${outputPdf}`);
console.log(
  `Includes ${commits.length} commits and ${shotData.length} screenshot pages.`,
);
