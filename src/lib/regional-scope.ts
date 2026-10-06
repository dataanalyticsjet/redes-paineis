import type { ParsedWorkbook, WorkbookRow } from "./workbook";

function normalized(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9\u4e00-\u9fff]/gi, "").toLowerCase();
}

export function regionalColumn(parsed: ParsedWorkbook): string | undefined {
  for (const candidate of ["Regional responsável", "Regional mais recente", "Regional Remetente", "Regional Origem", "Nome da regional", "Regional 区域", "Regional", "区域"]) {
    const header = parsed.headers.find((header) => normalized(header) === normalized(candidate));
    if (header) return header;
  }
  return parsed.regionColumn && parsed.headers.includes(parsed.regionColumn) ? parsed.regionColumn : undefined;
}

function withRows(parsed: ParsedWorkbook, rows: WorkbookRow[], region: string): ParsedWorkbook {
  return { ...parsed, rows, metadata: { ...parsed.metadata, rowCount: rows.length }, warnings: [...parsed.warnings, `Visualização restrita à regional ${region}.`] };
}

export function filterWorkbookForRegion(parsed: ParsedWorkbook, region: string): ParsedWorkbook {
  const column = regionalColumn(parsed);
  const expected = region.trim().toUpperCase();
  // Unknown ownership must never grant access to the complete workbook.
  const rows = column ? parsed.rows.filter((row) => String(row[column] ?? "").trim().toUpperCase() === expected) : [];
  return withRows(parsed, rows, expected);
}

export function filterWorkbookForBase(parsed: ParsedWorkbook, base: string): ParsedWorkbook {
  const column = parsed.baseColumn ?? parsed.headers.find((header) => normalized(header).includes("base"));
  const expected = base.trim().toUpperCase();
  const rows = column ? parsed.rows.filter((row) => String(row[column] ?? "").trim().toUpperCase() === expected) : [];
  return withRows(parsed, rows, expected);
}

function sellerColumn(parsed: ParsedWorkbook): string | undefined {
  for (const candidate of ["Id Seller/remetente", "global_seller_id", "Id Seller", "Seller", "商家ID", "Seller ID"]) {
    const header = parsed.headers.find((header) => normalized(header) === normalized(candidate));
    if (header) return header;
  }
  return undefined;
}

export function filterSellerReferenceForRegion(parsed: ParsedWorkbook, performance: ParsedWorkbook | null, region: string, special = false, allowedSellerIds?: Set<string>): ParsedWorkbook {
  const scoped = performance ? filterWorkbookForRegion(performance, region) : null;
  const idColumn = scoped ? sellerColumn(scoped) : undefined;
  const allowed = allowedSellerIds ?? new Set(scoped && idColumn ? scoped.rows.map((row) => String(row[idColumn] ?? "").trim()) : []);
  if (special) {
    const codes = new Set<string>();
    const column = sellerColumn(parsed);
    for (const row of parsed.rows) {
      for (const header of column ? [column] : parsed.headers) {
        for (const code of String(row[header] ?? "").match(/(?<!\d)\d{19}(?!\d)/g) ?? []) {
          if (allowed.has(code)) codes.add(code);
        }
      }
    }
    return withRows({ ...parsed, headers: ["商家ID"] }, [...codes].map((code) => ({ "商家ID": code })), region);
  }
  const column = sellerColumn(parsed);
  return withRows(parsed, column ? parsed.rows.filter((row) => allowed.has(String(row[column] ?? "").trim())) : [], region);
}

export function filterSellerReferenceForBase(parsed: ParsedWorkbook, performance: ParsedWorkbook | null, base: string, special = false): ParsedWorkbook {
  const scoped = performance ? filterWorkbookForBase(performance, base) : null;
  const idColumn = scoped ? sellerColumn(scoped) : undefined;
  const allowed = new Set(scoped && idColumn ? scoped.rows.map((row) => String(row[idColumn] ?? "").trim()) : []);
  if (special) {
    const codes = new Set<string>();
    const column = sellerColumn(parsed);
    for (const row of parsed.rows) for (const header of column ? [column] : parsed.headers) {
      for (const code of String(row[header] ?? "").match(/(?<!\d)\d{19}(?!\d)/g) ?? []) if (allowed.has(code)) codes.add(code);
    }
    return withRows({ ...parsed, headers: ["商家ID"] }, [...codes].map((code) => ({ "商家ID": code })), base);
  }
  const column = sellerColumn(parsed);
  return withRows(parsed, column ? parsed.rows.filter((row) => allowed.has(String(row[column] ?? "").trim())) : [], base);
}

// Read one row at a time: concurrent viewers must not materialize the global
// seller workbook (hundreds of thousands of rows) in each request's memory.
export async function readRegionalWorkbook(body: ReadableStream<Uint8Array>, region: string, idsOnly = false) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let prefix = "", suffix = "", currentRow = "";
  let stage: "prefix" | "rows" | "suffix" = "prefix";
  let rowsComplete = false;
  let depth = 0, inString = false, escaped = false;
  let regionKey: string | undefined, sellerKey: string | undefined;
  const rows: WorkbookRow[] = [];
  const sellerIds = new Set<string>();
  const expected = region.trim().toUpperCase();
  function consume(text: string) {
    if (stage === "prefix") {
      prefix += text;
      const marker = /"rows"\s*:\s*\[/.exec(prefix);
      if (!marker) return;
      const start = marker.index + marker[0].length;
      text = prefix.slice(start);
      prefix = prefix.slice(0, start - 1);
      const header = JSON.parse(prefix + "[]}") as ParsedWorkbook;
      regionKey = regionalColumn(header);
      sellerKey = sellerColumn(header);
      stage = "rows";
    }
    if (stage === "suffix") { suffix += text; return; }
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (depth === 0) {
        if (char === "]") { stage = "suffix"; rowsComplete = true; suffix += text.slice(i + 1); break; }
        if (char === "{" ) { depth = 1; currentRow = "{"; }
        else if (!/[\s,]/.test(char)) throw new Error("Formato inválido de linha na planilha salva.");
        continue;
      }
      currentRow += char;
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
      } else if (char === '"') inString = true;
      else if (char === "{" || char === "[") depth++;
      else if (char === "}" || char === "]") depth--;
      if (depth === 0) {
        const row = JSON.parse(currentRow) as WorkbookRow;
        if (regionKey && String(row[regionKey] ?? "").trim().toUpperCase() === expected) {
          if (!idsOnly) rows.push(row);
          if (sellerKey && row[sellerKey] != null) sellerIds.add(String(row[sellerKey]).trim());
        }
        currentRow = "";
      }
    }
  }
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) { consume(decoder.decode()); break; }
      consume(decoder.decode(value, { stream: true }));
    }
    if (!rowsComplete) throw new Error("A planilha salva está incompleta.");
    const parsed = JSON.parse(prefix + "[]" + suffix) as ParsedWorkbook;
    return { parsed: withRows(parsed, rows, expected), sellerIds };
  } finally { reader.releaseLock(); }
}
