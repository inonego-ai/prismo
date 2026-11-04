const { app, BrowserWindow } = require("electron");
const path = require("node:path");

const asset = path.resolve(__dirname, "../../android/app/src/main/assets/renderer.html");
const patch = [
  "diff --git a/TooltipContentBuilder.cs b/TooltipContentBuilder.cs",
  "--- a/TooltipContentBuilder.cs",
  "+++ b/TooltipContentBuilder.cs",
  "@@ -63,5 +63,6 @@",
  " context.before();",
  "-        var oldValue = GetLongCSharpMethodWithMuchMoreContentThanTheScreenWidth(input);",
  "+        var newValue = GetLongCSharpMethodWithMuchMoreContentThanTheScreenWidth(input);",
  "+        var another = GetSomethingElseWithExtremelyLongLine(input, context, options);",
  " context.after();"
].join("\n");
const source = [
  "context.before();",
  "        var oldValue = GetLongCSharpMethodWithMuchMoreContentThanTheScreenWidth(input);",
  "        var newValue = GetLongCSharpMethodWithMuchMoreContentThanTheScreenWidth(input);",
  "        var another = GetSomethingElseWithExtremelyLongLine(input, context, options);",
  "context.after();"
].join("\n");

function measure(payload, scrollX) {
  window.Prismo.render(JSON.stringify(payload));
  const pane = document.querySelector(".render-scroll");
  if (pane) pane.scrollLeft = scrollX;
  const box = element => {
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  };
  const rows = [...document.querySelectorAll(".render-row")].slice(0, 10).map(row => {
    const numbers = [...row.querySelectorAll(".render-number")];
    return {
      height: box(row).height,
      code: box(row.querySelector(".render-code")),
      prefix: box(row.querySelector(".render-prefix")),
      numbers: numbers.map(box),
      background: getComputedStyle(row).backgroundColor,
      gutterBackground: numbers.length ? getComputedStyle(numbers[0]).backgroundColor : ""
    };
  });
  return {
    rows, scrolled: pane?.scrollLeft ?? 0, width: innerWidth,
    scrollWidth: pane?.scrollWidth ?? 0, clientWidth: pane?.clientWidth ?? 0
  };
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 390, height: 720,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  const results = [];
  const failures = [];
  const epsilon = 0.7;
  const approx = (a, b) => Math.abs(a - b) <= epsilon;
  try {
    await win.loadFile(asset);
    for (const width of [390, 950]) {
      await win.setBounds({ x: 0, y: 0, width, height: 720 });
      for (const fontSize of [4, 6, 12, 20]) {
        for (const wrap of [false, true]) {
          for (const mode of ["diff", "file"]) {
            const options = { fontSize, markdownFontSize: 18, lineHeight: 1.3, padding: 4,
              wrap, numbers: true, split: false, dark: true };
            const payload = { path: "TooltipContentBuilder.cs",
              mode, content: mode === "diff" ? patch : source, options };
            const outcome = await win.webContents.executeJavaScript(
              "(" + measure.toString() + ")(" + JSON.stringify(payload) + ",0)");
            results.push({ width, fontSize, wrap, mode, outcome });
            if (!outcome.rows.length) failures.push("No rows for " + mode);
            for (const row of outcome.rows) {
              if (!approx(row.prefix.y, row.code.y))
                failures.push("Misaligned prefix: " + JSON.stringify({ width, fontSize, mode }));
              if (!approx(row.height, row.code.height))
                failures.push("Row mismatch: " + JSON.stringify({ width, fontSize, mode }));
              if (!row.numbers.every(number => approx(number.y, row.code.y)))
                failures.push("Misaligned line number: " + JSON.stringify({ width, fontSize, mode }));
            }
            if (!wrap && fontSize === 12 && width === 390) {
              const scrolled = await win.webContents.executeJavaScript(
                "(" + measure.toString() + ")(" + JSON.stringify(payload) + ",200)");
              if (scrolled.scrolled <= 0) failures.push("Horizontal scrolling unavailable");
              if (!scrolled.rows.every(row => approx(row.numbers[0].x, 0)))
                failures.push("Gutter not sticky: " + mode);
              if (mode === "diff" &&
                  !scrolled.rows.every(row => approx(row.numbers[1].x, row.numbers[0].width)))
                failures.push("Second gutter column not sticky");
            }
          }
          const code = results.at(-1).outcome;
          const diff = results.at(-2).outcome;
          if (!approx(diff.rows[0].height, code.rows[0].height)) {
            failures.push("Diff and file line heights differ: " + fontSize + "/" + width);
          }
        }
      }
    }
    for (const fontSize of [4, 12]) {
      const payload = { path: "TooltipContentBuilder.cs", mode: "diff", content: patch,
        options: { fontSize, markdownFontSize: 18, lineHeight: 1.3, padding: 4, wrap: false,
          numbers: true, split: true, dark: true } };
      const split = await win.webContents.executeJavaScript(
        "(" + measure.toString() + ")(" + JSON.stringify(payload) + ",0)");
      results.push({ width: 950, fontSize, mode: "split", outcome: split });
      if (split.rows.length < 6 || split.rows.some(row => !approx(row.height, row.code.height)))
        failures.push("Side-by-side lines not aligned at " + fontSize + "px");
    }
    console.log("Shared code/diff rows: " + results.length + " scenarios");
    console.log("Smallest font: 4px; expected line height 5.2px");
    const small = results.find(result =>
      result.mode === "file" && result.fontSize === 4 && !result.wrap);
    if (!small || !approx(small.outcome.rows[0].height, 5.2))
      failures.push("4px font line height is clamped");
    const color = results.find(result =>
      result.mode === "diff" && result.fontSize === 12 && !result.wrap);
    if (!color?.outcome.rows.some(row => row.background.includes("239, 68, 68")))
      failures.push("Missing deletion tint");
    if (!color?.outcome.rows.some(row => row.background.includes("34, 197, 94")))
      failures.push("Missing addition tint");
    for (const [codeFont, markdownFont] of [[4, 18], [4, 26], [14, 26]]) {
      const options = { fontSize: codeFont, markdownFontSize: markdownFont,
        lineHeight: 1.3, padding: 4, wrap: false, numbers: true, split: false, dark: true };
      const codeSize = await win.webContents.executeJavaScript(
        `(function () {
          window.Prismo.render(${JSON.stringify(JSON.stringify({ path: "test.cs",
            mode: "file", content: "using System;", options }))});
          return getComputedStyle(document.querySelector(".render-view")).fontSize;
        })()`
      );
      const mdSize = await win.webContents.executeJavaScript(
        `(function () {
          window.Prismo.render(${JSON.stringify(JSON.stringify({ path: "README.md",
            mode: "markdown", content: "# Title\\n\\nText", options }))});
          return getComputedStyle(document.querySelector("#root")).fontSize;
        })()`
      );
      if (codeSize !== codeFont + "px" || mdSize !== markdownFont + "px") {
        failures.push("Independent font settings failed: "
          + codeFont + "/" + markdownFont + " -> " + codeSize + "/" + mdSize);
      }
    }
    if (failures.length) {
      console.error("FAIL", failures.join("\n"));
    } else {
      console.log("PASS: fixed gutters, baseline alignment, scrolling, tint, 4px, shared line heights");
    }
    app.exit(failures.length ? 1 : 0);
  } catch (error) {
    console.error("PROBE ERROR", error);
    app.exit(1);
  } finally {
    win.destroy();
  }
});
