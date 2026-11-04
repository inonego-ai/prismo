import { parse } from "diff2html/lib-esm/diff-parser.js";

type DiffLine = ReturnType<typeof parse>[number]["blocks"][number]["lines"][number];

function element(tag: string, className: string, content?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}

function status(line: DiffLine | null): string {
  return line?.type === "insert" ? "added"
    : line?.type === "delete" ? "deleted" : "context";
}

function splitChanges(lines: DiffLine[]): Array<[DiffLine | null, DiffLine | null]> {
  const result: Array<[DiffLine | null, DiffLine | null]> = [];
  let removed: DiffLine[] = [];
  let added: DiffLine[] = [];

  function flush() {
    for (let index = 0; index < Math.max(removed.length, added.length); index++) {
      result.push([removed[index] ?? null, added[index] ?? null]);
    }
    removed = [];
    added = [];
  }

  for (const line of lines) {
    if (line.type === "delete") removed.push(line);
    else if (line.type === "insert") added.push(line);
    else {
      flush();
      result.push([line, line]);
    }
  }
  flush();
  return result;
}

function lineNumber(value: number | undefined, side: "old" | "new"): HTMLElement {
  return element("span", "render-number render-number-" + side,
    value === undefined ? "" : String(value));
}

function linePrefix(line: DiffLine | null): HTMLElement {
  return element("span", "render-prefix", line?.content.charAt(0) ?? " ");
}

function lineCode(line: DiffLine | null): HTMLElement {
  return element("span", "render-code", line?.content.slice(1) ?? "");
}

function unifiedRow(line: DiffLine): HTMLElement {
  const row = element("div", "render-row diff-row diff-" + status(line));
  row.append(lineNumber(line.oldNumber, "old"),
    lineNumber(line.newNumber, "new"), linePrefix(line), lineCode(line));
  return row;
}

function splitRow(left: DiffLine | null, right: DiffLine | null): HTMLElement {
  const row = element("div", "render-split-row");
  for (const [line, side] of [[left, "old"], [right, "new"]] as const) {
    const half = element("div", "render-row render-split-half diff-" + status(line)
      + (line ? "" : " diff-empty"));
    half.append(lineNumber(side === "old" ? line?.oldNumber : line?.newNumber, side),
      linePrefix(line), lineCode(line));
    row.appendChild(half);
  }
  return row;
}

function makeView(container: HTMLElement, className: string, maxNumber: number): HTMLElement {
  const scroll = element("div", "render-scroll");
  const view = element("div", "render-view " + className);
  view.style.setProperty("--render-number-width",
    Math.max(3, String(maxNumber).length + 1) + "ch");
  scroll.appendChild(view);
  container.appendChild(scroll);
  return view;
}

export function renderCodeView(container: HTMLElement, source: string): void {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  if (source.endsWith("\n")) lines.pop();
  const view = makeView(container, "code-view", lines.length);
  const fragment = document.createDocumentFragment();
  for (let index = 0; index < lines.length; index++) {
    const row = element("div", "render-row code-row");
    row.append(lineNumber(index + 1, "new"),
      element("span", "render-prefix", " "), element("span", "render-code", lines[index]));
    fragment.appendChild(row);
  }
  view.appendChild(fragment);
}

export function renderDiffView(container: HTMLElement, patch: string, split: boolean): void {
  const files = parse(patch);
  if (files.length === 0) {
    container.textContent = "표시할 변경 내용이 없습니다.";
    return;
  }
  const maxNumber = files.reduce((maximum, file) => {
    for (const block of file.blocks) {
      for (const line of block.lines) {
        maximum = Math.max(maximum, line.oldNumber ?? 0, line.newNumber ?? 0);
      }
    }
    return maximum;
  }, 0);
  const view = makeView(container, "diff-view" + (split ? " diff-split" : ""), maxNumber);
  const fragment = document.createDocumentFragment();
  for (const file of files) {
    if (file.isBinary || file.isTooBig || file.blocks.length === 0) {
      fragment.appendChild(element("div", "diff-empty-message",
        file.isBinary ? "바이너리 파일의 변경사항은 텍스트로 표시할 수 없습니다."
          : "표시할 텍스트 변경사항이 없습니다."));
      continue;
    }
    for (const block of file.blocks) {
      fragment.appendChild(element("div", "diff-hunk", block.header));
      if (split) {
        for (const [left, right] of splitChanges(block.lines)) {
          fragment.appendChild(splitRow(left, right));
        }
      } else {
        for (const line of block.lines) fragment.appendChild(unifiedRow(line));
      }
    }
  }
  view.appendChild(fragment);
}
