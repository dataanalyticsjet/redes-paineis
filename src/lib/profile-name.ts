const LATIN_SCRIPT = /\p{Script=Latin}/u;
const LETTER = /\p{L}/u;
const PARTICLES = new Set(["da", "das", "de", "do", "dos"]);

function titleCaseLatinPart(part: string): string {
  const lower = part.toLocaleLowerCase("pt-BR");
  const characters = Array.from(lower);
  const firstLetterIndex = characters.findIndex((character) => LETTER.test(character));
  if (firstLetterIndex < 0) return lower;
  characters[firstLetterIndex] = characters[firstLetterIndex].toLocaleUpperCase("pt-BR");
  return characters.join("");
}

/** Formats Latin-script names for display while leaving other writing systems intact. */
export function formatCollaboratorName(value: string): string {
  const name = value.trim().replace(/\s+/gu, " ");
  if (!name) return "";

  let wordIndex = 0;
  return name.split(/(\s+)/u).map((word) => {
    if (!word || /^\s+$/u.test(word)) return word;
    const letters = Array.from(word).filter((character) => LETTER.test(character));
    if (letters.some((character) => !LATIN_SCRIPT.test(character))) {
      wordIndex += 1;
      return word;
    }
    const formatted = word.split(/([-’'])/u).map((part) => {
      if (part === "-" || part === "’" || part === "'") return part;
      const lower = part.toLocaleLowerCase("pt-BR");
      if (wordIndex > 0 && PARTICLES.has(lower)) return lower;
      return titleCaseLatinPart(part);
    }).join("");
    wordIndex += 1;
    return formatted;
  }).join("");
}
