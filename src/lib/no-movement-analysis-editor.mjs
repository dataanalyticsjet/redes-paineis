/** @typedef {{ text: string, bold: boolean }} AnalysisRun */

const boldSpan = /(?<!\\)\*\*(?=\S)(.+?)(?<=\S)(?<!\\)\*\*/g;

function decodeEscapedText(value) {
  return value.replace(/\\([\\*])/g, "$1");
}

function encodePlainText(value) {
  return value.replace(/\\/g, "\\\\").replace(/\*/g, "\\*");
}

/**
 * Parse the narrowly supported Markdown subset into safe text/strong runs.
 * No HTML is interpreted or accepted.
 * @param {string} markdown
 * @returns {AnalysisRun[]}
 */
export function parseAnalysisMarkdown(markdown) {
  const runs = [];
  const append = (text, bold) => {
    if (!text) return;
    const previous = runs.at(-1);
    if (previous && previous.bold === bold && previous.text !== "\n") previous.text += text;
    else runs.push({ text, bold });
  };

  const lines = markdown.split("\n");
  lines.forEach((line, index) => {
    let cursor = 0;
    for (const match of line.matchAll(boldSpan)) {
      const start = match.index ?? 0;
      append(decodeEscapedText(line.slice(cursor, start)), false);
      append(decodeEscapedText(match[1] ?? ""), true);
      cursor = start + match[0].length;
    }
    append(decodeEscapedText(line.slice(cursor)), false);
    if (index < lines.length - 1) runs.push({ text: "\n", bold: false });
  });
  return runs;
}

/**
 * Serialize editor runs to the backend's safe Markdown subset.
 * @param {AnalysisRun[]} runs
 */
export function serializeAnalysisRuns(runs) {
  let output = "";
  let activeBold = false;
  const setBold = next => {
    if (activeBold === next) return;
    output += "**";
    activeBold = next;
  };

  for (const run of runs) {
    const pieces = run.text.split("\n");
    pieces.forEach((piece, index) => {
      if (piece) {
        setBold(Boolean(run.bold));
        output += encodePlainText(piece);
      }
      if (index < pieces.length - 1) {
        setBold(false);
        output += "\n";
      }
    });
  }
  setBold(false);
  return output;
}
