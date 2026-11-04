import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { html, parse } from "diff2html";
import { transform } from "esbuild";

const source = await readFile(new URL("../src/git-diff-paths.ts", import.meta.url), "utf8");
const transformed = await transform(source, { loader: "ts", format: "esm" });
const { normalizeGitDiffPaths } = await import(
  "data:text/javascript;base64," + Buffer.from(transformed.code).toString("base64")
);

test("Git UTF-8 octal path escapes render as the original filename", () => {
  const diff = String.raw`diff --git "a/caf\303\251.ts" "b/caf\303\251.ts"
new file mode 100644
--- /dev/null
+++ "b/caf\303\251.ts"
@@ -0,0 +1 @@
+hello
`;
  const normalized = normalizeGitDiffPaths(diff);
  assert.match(normalized, /diff --git "a\/café\.ts" "b\/café\.ts"/);
  assert.match(normalized, /\+\+\+ "b\/café\.ts"/);
  assert.equal(parse(normalized)[0]?.newName, "café.ts");
  assert.match(html(normalized, { drawFileList: false }), /class="d2h-file-name">café\.ts</);
});

test("only Git file headers are normalized; matching hunk text remains intact", () => {
  const diff = String.raw`diff --git "a/caf\303\251.ts" "b/caf\303\251.ts"
--- "a/caf\303\251.ts"
+++ "b/caf\303\251.ts"
@@ -1 +1 @@
-before
+after
++
+"b/caf\303\251.ts"
`;
  const normalized = normalizeGitDiffPaths(diff);
  assert.match(normalized, /\+\+\+ "b\/café\.ts"/);
  assert.ok(normalized.endsWith('+"b/caf\\303\\251.ts"\n'));
});

test("mixed quoted and unquoted rename paths keep the non-ASCII destination", () => {
  const diff = String.raw`diff --git a/plain.ts "b/caf\303\251.ts"
similarity index 100%
rename from plain.ts
rename to "caf\303\251.ts"
`;
  const normalized = normalizeGitDiffPaths(diff);
  assert.match(normalized, /diff --git a\/plain\.ts "b\/café\.ts"/);
  assert.match(normalized, /rename to café\.ts/);
  assert.equal(parse(normalized)[0]?.newName, "café.ts");
  assert.match(html(normalized, { drawFileList: false }), /plain\.ts → café\.ts/);
});
