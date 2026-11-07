import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../style.css", import.meta.url), "utf8");
const renderer = readFileSync(new URL("../renderer.mjs", import.meta.url), "utf8");

test("existing top controls remain available", () => {
  for (const id of ["power-button", "pc-update-button", "settings-button"]) {
    assert.ok(html.includes('id="' + id + '"'), id);
  }
});

test("devices and repositories have matching scrollable panels and fixed actions", () => {
  assert.match(html, /class="surface pair-panel"/);
  assert.match(html, /class="surface repo-panel"/);
  assert.match(html, /id="device-list"/);
  assert.match(html, /id="repository-list"/);
  assert.match(html, /class="pair-footer"/);
  assert.match(html, /class="repo-footer"/);
  assert.match(css, /\.workspace\s*\{[^}]*align-items:stretch/);
  assert.match(css, /\.device-list\s*\{[^}]*overflow-y:auto/);
  assert.match(css, /\.repo-list\s*\{[^}]*overflow-y:auto/);
  assert.match(css, /\.pair-footer, \.repo-footer\s*\{[^}]*flex-shrink:0/);
  assert.match(renderer, /ui\.list\.scrollTop = repoScroll/);
  assert.match(renderer, /ui\.deviceList\.scrollTop = scroll/);
});

test("device registration shows QR and the same manually copyable link", () => {
  for (const id of ["pair-active", "qr-image", "pair-link",
                    "copy-pair-link-button", "countdown"]) {
    assert.ok(html.includes('id="' + id + '"'), id);
  }
  assert.match(html, /새 기기 등록/);
});
