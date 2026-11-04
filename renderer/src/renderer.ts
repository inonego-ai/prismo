import { html } from "diff2html";
import hljs from "highlight.js/lib/common";
import DOMPurify from "dompurify";
import { normalizeGitDiffPaths } from "./git-diff-paths.js";
import "diff2html/bundles/css/diff2html.min.css";
import "highlight.js/styles/github-dark.css";
import "./style.css";

type Mode = "diff" | "file" | "raw";
type Options = {
  fontSize: number; lineHeight: number; padding: number;
  wrap: boolean; numbers: boolean; split: boolean; dark: boolean;
};
type Payload = { mode: Mode; content: string; path: string; options: Options };

const root = document.querySelector("#root") as HTMLElement;
const extensions: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
  kt: "kotlin", java: "java", cs: "csharp", py: "python", rs: "rust",
  go: "go", cpp: "cpp", h: "cpp", c: "c", json: "json", xml: "xml",
  html: "xml", css: "css", sh: "bash", yml: "yaml", yaml: "yaml", md: "markdown"
};
function lang(path: string): string | undefined {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const detected = extensions[ext];
  return detected && hljs.getLanguage(detected) ? detected : undefined;
}
function paint(code: HTMLElement, language?: string) {
  if (!language) return;
  const value = code.textContent ?? "";
  try {
    code.innerHTML = DOMPurify.sanitize(hljs.highlight(value, { language }).value, {
      ALLOWED_TAGS: ["span"], ALLOWED_ATTR: ["class"]
    });
  }
  catch { /* Keep unformatted text when a grammar cannot process a line. */ }
}
function applyOptions(options: Options) {
  document.documentElement.style.setProperty("--code-font", options.fontSize + "px");
  document.documentElement.style.setProperty("--code-height", String(options.lineHeight));
  document.documentElement.style.setProperty("--code-pad", options.padding + "px");
  document.documentElement.classList.toggle("wrap", options.wrap);
  document.documentElement.classList.toggle("hide-numbers", !options.numbers);
  document.documentElement.classList.toggle("dark", options.dark);
}
function render(input: string) {
  const data = JSON.parse(input) as Payload;
  applyOptions(data.options);
  root.replaceChildren();
  if (!data.content) {
    root.textContent = data.mode === "diff" ? "변경 내용 없음" : "빈 파일";
    return;
  }
  if (data.mode === "diff") {
    const diffMarkup = html(normalizeGitDiffPaths(data.content), {
      drawFileList: false,
      matching: "lines",
      outputFormat: data.options.split ? "side-by-side" : "line-by-line"
    });
    root.innerHTML = DOMPurify.sanitize(diffMarkup, { USE_PROFILES: { html: true } });
    const language = lang(data.path);
    root.querySelectorAll<HTMLElement>(".d2h-code-line-ctn").forEach(code => paint(code, language));
    return;
  }
  const pre = document.createElement("pre");
  pre.className = data.mode === "raw" ? "raw" : "source";
  const code = document.createElement("code");
  code.textContent = data.content;
  pre.appendChild(code);
  root.appendChild(pre);
  if (data.mode === "file") paint(code, lang(data.path));
}
(window as typeof window & { Prismo: { render: (input: string) => void } }).Prismo = { render };
