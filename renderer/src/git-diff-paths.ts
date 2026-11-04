function decodeQuotedPath(token: string): string {
  const source = token.slice(1, -1);
  let result = "";
  let octets: number[] = [];
  const flushOctets = () => {
    if (!octets.length) return;
    const encoded = octets.map(byte => "%" + byte.toString(16).padStart(2, "0")).join("");
    try {
      result += decodeURIComponent(encoded);
    } catch {
      result += octets.map(byte => "\\" + byte.toString(8).padStart(3, "0")).join("");
    }
    octets = [];
  };

  for (let index = 0; index < source.length; index++) {
    const character = source[index]!;
    if (character !== "\\") {
      flushOctets();
      result += character;
      continue;
    }

    const next = source[index + 1];
    if (next && /[0-7]/.test(next)) {
      let octal = next;
      index++;
      for (let count = 1; count < 3 && /[0-7]/.test(source[index + 1] ?? ""); count++) {
        octal += source[++index]!;
      }
      octets.push(parseInt(octal, 8));
      continue;
    }

    flushOctets();
    index++;
    const escaped = source[index];
    result += escaped === "t" ? "\t" : escaped === "n" ? "\n"
      : escaped === "r" ? "\r" : escaped === "b" ? "\b"
      : escaped === "f" ? "\f" : escaped === "v" ? "\v"
      : escaped === "a" ? "\u0007" : escaped ?? "";
  }
  flushOctets();

  // Leave other quoted escapes for diff2html; only normalize display-safe paths.
  return /[\u0000-\u001f\u007f"\\]/.test(result) ? token : '"' + result + '"';
}

function normalizeHeaderPath(token: string, keepQuotes = true): string {
  if (!/^"(?:\\.|[^"\\])*"$/.test(token)) return token;
  const decoded = decodeQuotedPath(token);
  return keepQuotes || decoded === token ? decoded : decoded.slice(1, -1);
}

/** Decode Git's UTF-8 octal escapes in file headers before diff2html parses them. */
export function normalizeGitDiffPaths(diff: string): string {
  let inFileHeader = false;
  return diff.split("\n").map(line => {
    const ending = line.endsWith("\r") ? "\r" : "";
    const content = ending ? line.slice(0, -1) : line;
    if (content.startsWith("diff --git ")) {
      inFileHeader = true;
      return content.replace(/"(?:\\.|[^"\\])*"/g, normalizeHeaderPath) + ending;
    }
    if (inFileHeader && /^(?:---|\+\+\+) /.test(content)) {
      return content.replace(/"(?:\\.|[^"\\])*"/g, normalizeHeaderPath) + ending;
    }
    if (inFileHeader && /^(?:rename from|rename to|copy from|copy to) /.test(content)) {
      return content.replace(/"(?:\\.|[^"\\])*"/g,
        token => normalizeHeaderPath(token, false)) + ending;
    }
    if (content.startsWith("@@ ") || content === "GIT binary patch") inFileHeader = false;
    return line;
  }).join("\n");
}
