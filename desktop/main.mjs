import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, shell, Tray } from "electron";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import QRCode from "qrcode";
import electronUpdater from "electron-updater";
import { findPairAddress } from "./connection.mjs";
import { createUpdateCheckGate } from "./update-check.mjs";

const execute = promisify(execFile);
const { autoUpdater } = electronUpdater;
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = false;
const here = dirname(fileURLToPath(import.meta.url));
const agentRoot = app.isPackaged ? join(process.resourcesPath, "agent") : resolve(here, "../agent");
const dist = join(agentRoot, "dist");
const { createApp } = await import(pathToFileURL(join(dist, "api.js")).href);
const { PairingStore } = await import(pathToFileURL(join(dist, "pairing.js")).href);
const { loadGitHubSource } = await import(pathToFileURL(join(dist, "releaseConfig.js")).href);
const { UpdateStore } = await import(pathToFileURL(join(dist, "updates.js")).href);
const { addRepository, listRepositories, removeRepository } =
  await import(pathToFileURL(join(dist, "config.js")).href);
const { getRepositorySummaries } = await import(pathToFileURL(join(dist, "git.js")).href);
const pairing = new PairingStore();
const updates = new UpdateStore();
let releaseSource = null;
let pcUpdateState = { kind: "idle", message: "" };
const updateCheck = createUpdateCheckGate();
const PORT = 3000;
const WINDOW_PAGE = pathToFileURL(join(here, "index.html")).href;
const HEALTH_URL = "http://127.0.0.1:" + PORT + "/health";

let window = null;
let tray = null;
let quitting = false;
let shutdown = null;
let server = null;
let serverError = "";
let connectionCache = null;
let cacheTime = 0;
let privateConnectionCheck = null;
let privateConnectionCheckedAt = 0;
let privateConnectionReady = false;
const primary = app.requestSingleInstanceLock();
if (!primary) app.quit();
else app.on("second-instance", () => {
  showWindow();
});

async function health() {
  try {
    const response = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(1000) });
    if (!response.ok) return false;
    const value = await response.json();
    return value.service === "Prismo" && value.status === "ok";
  } catch { return false; }
}
async function startAgent() {
  if (server) return true;
  if (await health()) {
    serverError = "서버가 다른 창에서 실행 중입니다.";
    return false;
  }
  try {
    const instance = createApp(pairing, updates, privateConnectionAvailable);
    await instance.listen({ host: "127.0.0.1", port: PORT });
    server = instance;
    serverError = "";
    return true;
  } catch {
    serverError = "서버를 시작할 수 없습니다.";
    return false;
  }
}
async function stopAgent() {
  pairing.cancel();
  if (!server) return;
  const instance = server;
  server = null;
  await instance.close();
}
function showWindow() {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}
function quitPrismo() {
  if (!shutdown) {
    shutdown = stopAgent().catch(() => {}).finally(() => {
      quitting = true;
      app.quit();
    });
  }
  return shutdown;
}
function createTray() {
  tray = new Tray(join(here, "mark.ico"));
  tray.setToolTip("Prismo");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Prismo 열기", click: showWindow },
    { type: "separator" },
    { label: "종료", click: () => { void quitPrismo(); } }
  ]));
  tray.on("double-click", showWindow);
}
function tailscaleBinary() {
  const paths = [
    process.env.ProgramFiles && join(process.env.ProgramFiles, "Tailscale", "tailscale.exe"),
    process.env["ProgramFiles(x86)"] && join(process.env["ProgramFiles(x86)"], "Tailscale", "tailscale.exe"),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Tailscale", "tailscale.exe")
  ].filter(Boolean);
  return paths.find(path => existsSync(path)) ?? null;
}
async function tailscale(args) {
  const executable = tailscaleBinary();
  if (!executable) throw Error("Tailscale not installed");
  return (await execute(executable, args, {
    timeout: 9500, maxBuffer: 512 * 1024, windowsHide: true
  })).stdout;
}
async function inspectConnection(force = false) {
  const now = Date.now();
  if (!force && connectionCache && now - cacheTime < 5000) return connectionCache;
  let result = { ready: false, reason: "setup", address: null };
  if (!tailscaleBinary()) {
    result = { ready: false, reason: "install", address: null };
  } else {
    try {
      const status = JSON.parse(await tailscale(["status", "--json"]));
      if (status.BackendState !== "Running") {
        result = { ready: false, reason: "login", address: null };
      } else {
        const serve = JSON.parse(await tailscale(["serve", "status", "--json"]));
        const address = findPairAddress(status, serve);
        if (address) result = { ready: true, reason: "", address };
      }
    } catch {
      result = { ready: false, reason: "setup", address: null };
    }
  }
  connectionCache = result;
  cacheTime = now;
  return result;
}

function privateConnectionAvailable() {
  if (privateConnectionCheck) return privateConnectionCheck;
  if (Date.now() - privateConnectionCheckedAt < 1000) {
    return Promise.resolve(privateConnectionReady);
  }
  privateConnectionCheck = inspectConnection(true)
    .then(connection => connection.ready)
    .catch(() => false)
    .then(ready => {
      privateConnectionReady = ready;
      privateConnectionCheckedAt = Date.now();
      return ready;
    })
    .finally(() => { privateConnectionCheck = null; });
  return privateConnectionCheck;
}

function sendUpdateStatus(kind, message) {
  pcUpdateState = { kind, message };
  if (window && !window.isDestroyed()) {
    window.webContents.send("prismo:pc-update", pcUpdateState);
  }
  return pcUpdateState;
}
function updateManifestAvailable() {
  return app.isPackaged && !process.env.PORTABLE_EXECUTABLE_FILE &&
    existsSync(join(process.resourcesPath, "app-update.yml"));
}
async function executableSigned() {
  if (!app.isPackaged || process.platform !== "win32") return false;
  const escaped = process.execPath.replaceAll("'", "''");
  try {
    const { stdout } = await execute("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      "(Get-AuthenticodeSignature -LiteralPath '" + escaped + "').Status"
    ], { timeout: 10_000, windowsHide: true });
    return stdout.trim() === "Valid";
  } catch { return false; }
}
function releasePage() {
  if (!releaseSource) return null;
  return "https://github.com/" + releaseSource.owner +
    "/" + releaseSource.repo + "/releases/latest";
}
function configurePCUpdates() {
  autoUpdater.on("checking-for-update", () =>
    sendUpdateStatus("checking", "업데이트 확인 중"));
  autoUpdater.on("update-not-available", () =>
    sendUpdateStatus("current", "최신 버전"));
  autoUpdater.on("error", () =>
    sendUpdateStatus("error", "업데이트를 확인할 수 없습니다."));
  autoUpdater.on("download-progress", item =>
    sendUpdateStatus("downloading", "다운로드 " + Math.round(item.percent) + "%"));
  autoUpdater.on("update-available", info => {
    updateCheck.track((async () => {
      sendUpdateStatus("available", "새 버전 " + info.version);
      if (!window || window.isDestroyed()) return;
      try {
        const result = await dialog.showMessageBox(window, {
          title: "Prismo 업데이트", type: "info",
          message: "새 버전 " + info.version + "이 있습니다.",
          buttons: ["나중에", "다운로드"], defaultId: 1, cancelId: 0
        });
        if (result.response !== 1) return;
        try { await autoUpdater.downloadUpdate(); }
        catch { sendUpdateStatus("error", "다운로드하지 못했습니다."); }
      } catch {
        sendUpdateStatus("error", "업데이트 확인을 완료하지 못했습니다.");
      }
    })());
  });
  autoUpdater.on("update-downloaded", info => {
    updateCheck.track((async () => {
      sendUpdateStatus("ready", "새 버전 " + info.version + " 준비됨");
      if (!window || window.isDestroyed()) return;
      try {
        const result = await dialog.showMessageBox(window, {
          title: "Prismo 업데이트", type: "info",
          message: "새 버전을 설치할까요?",
          detail: "Prismo가 종료되고 설치가 시작됩니다.",
          buttons: ["나중에", "설치"], defaultId: 1, cancelId: 0
        });
        if (result.response === 1) autoUpdater.quitAndInstall(false, true);
      } catch {
        sendUpdateStatus("error", "설치 확인을 열 수 없습니다.");
      }
    })());
  });
}
async function checkPCUpdate(automatic = false) {
  if (!releaseSource) return sendUpdateStatus("unconfigured", "릴리스 저장소 미설정");
  if (!updateManifestAvailable() || !(await executableSigned())) {
    if (!automatic) {
      const url = releasePage();
      if (url) await shell.openExternal(url);
    }
    return sendUpdateStatus("manual", "GitHub 릴리스 열기");
  }
  return updateCheck.run(async () => {
    sendUpdateStatus("checking", "업데이트 확인 중");
    try {
      await autoUpdater.checkForUpdates();
    } catch {
      sendUpdateStatus("error", "업데이트 확인 실패");
    }
    return pcUpdateState;
  });
}

let previousQR = null;
function pairingLink(connection, pending) {
  return connection.address + "/#pair=" + encodeURIComponent(pending.secret);
}
async function pairingState() {
  const running = Boolean(server);
  const connection = await inspectConnection();
  if (!running || !connection.ready) pairing.cancel();
  const pending = running && connection.ready ? pairing.current() : null;
  if (!pending) previousQR = null;
  const qr = pending ? previousQR?.secret === pending.secret ? previousQR.image
    : await QRCode.toDataURL(
      pairingLink(connection, pending),
      { margin: 2, width: 232, color: { dark: "#151515", light: "#FFFFFF" } }
    ) : null;
  if (pending && qr) previousQR = { secret: pending.secret, image: qr };
  return {
    running, serverError, connection,
    pairing: pending ? { active: true, expiresAt: pending.expiresAt, qr } : { active: false },
    connectedDevices: pairing.count()
  };
}
async function snapshot() {
  const connection = await pairingState();
  const summaries = await getRepositorySummaries(await listRepositories());
  const repositories = summaries.map(({ repo, status, issue }) => ({
    id: repo.id, name: repo.name, path: repo.path, issue,
    branch: status?.branch ?? null, changes: status?.changes.length ?? null
  }));
  return { ...connection, repositories };
}
function registerHandlers() {
  const handle = (channel, callback) => ipcMain.handle(channel, (event, ...args) => {
    if (!window || event.sender !== window.webContents
      || event.senderFrame !== window.webContents.mainFrame
      || event.senderFrame.url !== WINDOW_PAGE) {
      throw Error("Unauthorized window");
    }
    return callback(event, ...args);
  });
  handle("prismo:state", () => snapshot());
  handle("prismo:pairing-state", () => pairingState());
  handle("prismo:check-pc-update", () => checkPCUpdate());
  handle("prismo:start-server", async () => {
    await startAgent();
    return snapshot();
  });
  handle("prismo:stop-server", async () => {
    await stopAgent();
    return snapshot();
  });
  handle("prismo:add-repository", async () => {
    const result = await dialog.showOpenDialog(window, {
      title: "저장소 선택", properties: ["openDirectory"]
    });
    if (!result.canceled && result.filePaths[0]) {
      await addRepository(result.filePaths[0]);
    }
    return snapshot();
  });
  handle("prismo:remove-repository", async (_event, id) => {
    if (typeof id !== "string") throw Error("Invalid repository");
    const selected = (await listRepositories()).find(repo => repo.id === id);
    if (selected) {
      const answer = await dialog.showMessageBox(window, {
        type: "question", title: "저장소 해제",
        buttons: ["취소", "해제"], defaultId: 0, cancelId: 0,
        message: selected.name + "의 연결을 해제할까요?"
      });
      if (answer.response === 1) await removeRepository(id);
    }
    return snapshot();
  });
  handle("prismo:setup-connection", async () => {
    const connection = await inspectConnection(true);
    if (connection.reason === "install") {
      await shell.openExternal("https://tailscale.com/download/windows");
      return snapshot();
    }
    if (connection.reason === "login") {
      // Opens the interactive login flow in the system browser.
      try { await tailscale(["up"]); } catch { /* Login may require user interaction. */ }
      return snapshot();
    }
    if (!connection.ready) {
      try {
        await tailscale(["serve", "--bg", "3000"]);
      } catch (error) {
        const output = String(error?.stdout ?? "") + "\n" + String(error?.stderr ?? "");
        const approvalURL = output.match(/https:\/\/login\.tailscale\.com\/f\/serve\?node=[^\s]+/)?.[0];
        if (approvalURL) {
          await shell.openExternal(approvalURL);
        } else {
          throw Error("연결 설정을 완료할 수 없습니다.");
        }
      }
    }
    await inspectConnection(true);
    return snapshot();
  });
  handle("prismo:copy-pairing-link", async () => {
    const connection = await inspectConnection(true);
    const pending = pairing.current();
    if (!server || !connection.ready || !pending) {
      throw Error("연결 코드가 없습니다.");
    }
    clipboard.writeText(pairingLink(connection, pending));
    return true;
  });
  handle("prismo:begin-pairing", async () => {
    if (!server) throw Error("서버를 먼저 시작하세요.");
    const connection = await inspectConnection(true);
    if (!connection.ready) throw Error("연결 설정을 완료하세요.");
    pairing.issue();
    return pairingState();
  });
  handle("prismo:cancel-pairing", async () => {
    pairing.cancel();
    return pairingState();
  });
  handle("prismo:revoke-devices", async () => {
    const answer = await dialog.showMessageBox(window, {
      type: "warning", title: "기기 연결 해제",
      buttons: ["취소", "모두 해제"], defaultId: 0, cancelId: 0,
      message: "연결된 기기를 모두 해제할까요?"
    });
    if (answer.response === 1) await pairing.revokeAll();
    return pairingState();
  });
}
function openWindow() {
  window = new BrowserWindow({
    width: 750, height: 370, minWidth: 640, minHeight: 350,
    backgroundColor: "#090909", title: "Prismo",
    icon: join(here, "mark.png"),
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#090909", symbolColor: "#c5c5c5", height: 40 },
    show: false, autoHideMenuBar: true,
    webPreferences: {
      preload: join(here, "preload.cjs"),
      contextIsolation: true, nodeIntegration: false, sandbox: true
    }
  });
  window.on("close", event => {
    if (!quitting && tray) {
      event.preventDefault();
      window.hide();
    }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-attach-webview", event => event.preventDefault());
  window.webContents.on("will-navigate", event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, reply) => {
    reply(false);
  });
  window.once("ready-to-show", () => window?.show());
  window.loadFile(join(here, "index.html"));
}
if (primary) {
  app.whenReady().then(async () => {
    await pairing.initialize();
    await updates.initialize();
    releaseSource = await loadGitHubSource();
    configurePCUpdates();
    registerHandlers();
    await startAgent();
    createTray();
    openWindow();
    if (releaseSource && updateManifestAvailable()) {
      setTimeout(() => { void checkPCUpdate(true); }, 12_000);
    }
  }).catch(error => {
    dialog.showErrorBox("Prismo", error.message);
    app.quit();
  });
  app.on("before-quit", event => {
    if (!quitting) {
      event.preventDefault();
      void quitPrismo();
    }
  });
}
