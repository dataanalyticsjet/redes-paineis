import type { ParsedWorkbook } from "./workbook";

const SELLER_ID_PATTERN = /(?<!\d)\d{19}(?!\d)/g;

export function extractSpecialSellerCodes(parsed: ParsedWorkbook): string[] {
  const preferredHeader = parsed.headers.find((header) => {
    const normalized = header.trim().toLocaleLowerCase();
    return normalized === "商家id" || normalized.includes("seller especial") || normalized.includes("seller id");
  });
  const sourceHeaders = preferredHeader ? [preferredHeader] : parsed.headers;
  const codes = new Set<string>();

  for (const row of parsed.rows) {
    for (const header of sourceHeaders) {
      const value = String(row[header] ?? "");
      for (const code of value.match(SELLER_ID_PATTERN) ?? []) codes.add(code);
    }
  }

  return [...codes].sort((left, right) => left.localeCompare(right));
}
