import assert from "node:assert/strict";
import test from "node:test";
import { createLoginStartup } from "../login-startup.mjs";

function mockApp() {
  let enabled = false;
  const calls = [];
  return {
    isPackaged: true,
    calls,
    getLoginItemSettings(options) {
      calls.push({ type: "get", ...options });
      return { openAtLogin: enabled, executableWillLaunchAtLogin: enabled };
    },
    setLoginItemSettings(options) {
      calls.push({ type: "set", ...options });
      enabled = options.openAtLogin;
    }
  };
}

test("Windows portable autostart uses the original EXE, not the extracted executable", () => {
  const app = mockApp();
  const startup = createLoginStartup(app, {
    platform: "win32",
    executablePath: "C:\\Temp\\prismo-unpacked.exe",
    portableExecutablePath: "C:\\Apps\\Prismo-Windows-Portable.exe"
  });
  assert.deepEqual(startup.get(), { supported: true, enabled: false });
  assert.deepEqual(startup.set(true), { supported: true, enabled: true });
  assert.deepEqual(app.calls[1], {
    type: "set",
    path: "C:\\Apps\\Prismo-Windows-Portable.exe",
    args: ["--prismo-startup"],
    openAtLogin: true
  });
  assert.equal(startup.isStartupLaunch(["Prismo.exe", "--prismo-startup"]), true);
  assert.equal(startup.isStartupLaunch(["Prismo.exe"]), false);
  assert.equal(startup.set(false).enabled, false);
});

test("installed Windows app uses its own executable path and validates changes", () => {
  const app = mockApp();
  const startup = createLoginStartup(app, {
    platform: "win32",
    executablePath: "C:\\Program Files\\Prismo\\Prismo.exe",
    portableExecutablePath: undefined
  });
  assert.throws(() => startup.set("yes"), /Invalid startup setting/);
  startup.set(true);
  assert.equal(app.calls[0].path, "C:\\Program Files\\Prismo\\Prismo.exe");
});

test("development and non-Windows builds cannot change login settings", () => {
  const app = mockApp();
  app.isPackaged = false;
  const startup = createLoginStartup(app, { platform: "win32" });
  assert.deepEqual(startup.get(), { supported: false, enabled: false });
  assert.throws(() => startup.set(true), /Invalid startup setting/);
  assert.equal(app.calls.length, 0);
});
