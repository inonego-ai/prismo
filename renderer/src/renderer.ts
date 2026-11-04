import { renderCodeView, renderDiffView } from "./diff-view.js";
import { marked } from "marked";
import hljs from "highlight.js/lib/common";
import DOMPurify from "dompurify";
import { normalizeGitDiffPaths } from "./git-diff-paths.js";
import "highlight.js/styles/github-dark.css";
import "./style.css";

type Mode = "diff" | "file" | "raw" | "markdown";
type Options = {
  fontSize: number; markdownFontSize: number; lineHeight: number; padding: number;
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
  document.documentElement.style.setProperty("--markdown-font", options.markdownFontSize + "px");
  document.documentElement.style.setProperty("--code-height", String(options.lineHeight));
  document.documentElement.style.setProperty("--code-pad", options.padding + "px");
  document.documentElement.classList.toggle("wrap", options.wrap);
  document.documentElement.classList.toggle("hide-numbers", !options.numbers);
  document.documentElement.classList.toggle("dark", options.dark);
}
function render(input: string) {
  const data = JSON.parse(input) as Payload;
  applyOptions(data.options);
  root.classList.toggle("markdown-preview", data.mode === "markdown");
  root.replaceChildren();
  if (!data.content) {
    root.textContent = data.mode === "diff" ? "변경 내용 없음" : "빈 파일";
    return;
  }
  if (data.mode === "markdown") {
    root.innerHTML = DOMPurify.sanitize(marked.parse(data.content, { async: false }) as string, {
      USE_PROFILES: { html: true },
      FORBID_TAGS: ["img", "iframe", "object", "embed", "form", "video", "audio"]
    });
    root.querySelectorAll<HTMLAnchorElement>("a").forEach(link => {
      link.removeAttribute("target");
      link.removeAttribute("download");
    });
    return;
  }
  if (data.mode === "diff") {
    renderDiffView(root, normalizeGitDiffPaths(data.content), data.options.split);
  } else if (data.mode === "file") {
    renderCodeView(root, data.content);
  } else {
    const pre = document.createElement("pre");
    pre.className = "raw";
    const code = document.createElement("code");
    code.textContent = data.content;
    pre.appendChild(code);
    root.appendChild(pre);
  }
  // Both views use the same source-line element and baseline.
  // Limit per-line grammar work on large files to keep the WebView responsive.
  if (data.mode !== "raw" && data.content.length < 80_000) {
    const language = lang(data.path);
    root.querySelectorAll<HTMLElement>(".render-code").forEach(code => paint(code, language));
  }
}
(window as typeof window & { Prismo: { render: (input: string) => void } }).Prismo = { render };
