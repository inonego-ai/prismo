import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const bundles = [
  ["diff2html", "MIT", "LICENSE.md", "https://github.com/rtfpessoa/diff2html"],
  ["highlight.js", "BSD-3-Clause", "LICENSE", "https://github.com/highlightjs/highlight.js"],
  ["diff", "BSD-3-Clause", "LICENSE", "https://github.com/kpdecker/jsdiff"],
  ["@profoundlogic/hogan", "Apache-2.0", "LICENSE", "https://github.com/ProfoundLogic/hogan.js-ProfoundLogic"],
  ["dompurify", "(MPL-2.0 OR Apache-2.0)", "LICENSE", "https://github.com/cure53/DOMPurify"]
];
const meta = JSON.parse(await readFile(resolve(root, "build/renderer-meta.json"), "utf8"));
const packaged = new Set(Object.keys(meta.inputs).map(path =>
  path.match(/^node_modules\/((?:@[^/]+\/)?[^/]+)\//)?.[1]
).filter(Boolean));
const expectedPackages = new Set(bundles.map(([name]) => name));
for (const name of packaged) {
  if (!expectedPackages.has(name)) throw Error("Unreviewed bundled dependency: " + name);
}
for (const name of expectedPackages) {
  if (!packaged.has(name)) throw Error("License listed but package not bundled: " + name);
}
const parts = [
  "Prismo — bundled JavaScript renderer third-party notices",
  "Generated from the installed npm packages. Retain with redistributed APKs.",
  "These notices do not cover Android/Gradle dependencies, which are collected separately."
];
for (const [name, expected, licenseFile, url] of bundles) {
  const location = resolve(root, "node_modules", name);
  const info = JSON.parse(await readFile(resolve(location, "package.json"), "utf8"));
  if (info.license !== expected) throw Error(name + " license changed: " + info.license);
  const license = (await readFile(resolve(location, licenseFile), "utf8")).trim();
  parts.push("=".repeat(70), name + " v" + info.version + " (" + expected + ")", url, "", license);
}
const output = parts.join("\n") + "\n";
for (const file of [
  resolve(root, "../android/app/src/main/assets/renderer-licenses.txt"),
  resolve(root, "../docs/RENDERER_THIRD_PARTY_NOTICES.txt")
]) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, output, "utf8");
}
console.log("Generated notices for " + bundles.length + " renderer libraries");
