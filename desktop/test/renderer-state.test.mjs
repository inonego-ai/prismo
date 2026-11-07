import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";

const source = readFileSync(new URL("../renderer.mjs", import.meta.url), "utf8");
const normalState = {
  running: false, connection: { ready: false },
  pairing: { active: false, expiresAt: 0 },
  repositories: [], devices: [], connectedDevices: 0, serverError: null
};

function element() {
  const listeners = new Map();
  return {
    listeners, open: false, scrollTop: 0,
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener(type, callback) { listeners.set(type, callback); },
    append() {}, replaceChildren() {}, setAttribute() {}, removeAttribute() {},
    showModal() { this.open = true; },
    close() { this.open = false; }
  };
}

function mount(responses, api = {}) {
  const elements = new Map();
  const intervals = [];
  const documentListeners = new Map();
  const document = {
    hidden: false,
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, element());
      return elements.get(id);
    },
    createElement: element,
    addEventListener(type, callback) { documentListeners.set(type, callback); }
  };
  const window = { prismo: {
    state: () => responses.shift(), onPCUpdate() {}, ...api
  } };
  runInNewContext(source, {
    document, window, Date,
    setTimeout: () => 1, clearTimeout() {},
    setInterval(callback) { intervals.push(callback); }
  });
  return { elements, documentListeners, intervals };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

test("ignores a stale state-refresh failure after a newer action", async () => {
  let rejectStale;
  const stale = new Promise((_, reject) => { rejectStale = reject; });
  const { elements, documentListeners } = mount([
    Promise.resolve(normalState), stale, Promise.resolve(normalState)
  ]);
  await settle();
  documentListeners.get("visibilitychange")();
  elements.get("refresh-button").listeners.get("click")();
  rejectStale(new Error("stale network failure"));
  await settle();
  assert.equal(elements.get("toast").textContent, undefined);
});

test("reports a state-refresh failure when no newer action exists", async () => {
  const { elements } = mount([Promise.reject(new Error("network failure"))]);
  await settle();
  assert.equal(elements.get("toast").textContent, "상태를 불러올 수 없습니다.");
});

test("a repeated server startup failure reports each failed attempt", async () => {
  const failed = { ...normalState, serverError: "연결을 시작할 수 없습니다." };
  const { elements } = mount([Promise.resolve(failed)], {
    startServer: async () => failed
  });
  await settle();
  const toast = elements.get("toast");
  toast.textContent = "";
  elements.get("power-button").listeners.get("click")();
  await settle();
  assert.equal(toast.textContent, failed.serverError);
});

test("expired pairing immediately restores the register button during a pending sync", async () => {
  const active = {
    ...normalState,
    running: true, connection: { ready: true },
    pairing: { active: true, expiresAt: Date.now() + 60_000, qr: "data:qr", link: "prismo:pair" }
  };
  const { elements, intervals } = mount([Promise.resolve(active)], {
    pairingState: () => new Promise(() => {})
  });
  await settle();
  assert.equal(elements.get("pair-button").hidden, true);
  assert.equal(elements.get("pair-active").open, true);
  active.pairing.expiresAt = Date.now() - 1000;
  intervals[0]();
  assert.equal(elements.get("pair-active").open, false);
  assert.equal(elements.get("pair-button").hidden, false);
});
