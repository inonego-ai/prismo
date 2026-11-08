import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, shell, Tray } from "electron";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import QRCode from "qrcode";
import electronUpdater from "electron-updater";
import { PrismoHost } from "./iroh.mjs";
import { flushTransportLog, logTransportFailure } from "./transport-log.mjs";
import { checkLatestGitHubRelease, createUpdateCheckGate } from "./update-check.mjs";
import { createLoginStartup } from "./login-startup.mjs";

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
const loginStartup = createLoginStartup(app);
const startedAtLogin = loginStartup.isStartupLaunch(process.argv);
const WINDOW_PAGE = pathToFileURL(join(here, "index.html")).href;

let window = null;
let tray = null;
let quitting = false;
let shutdown = null;
let server = null;
let host = null;
let serverError = "";
let agentOperation = Promise.resolve();
function runAgentOperation(action) {
  const operation = agentOperation.then(action);
  agentOperation = operation.then(() => {}, () => {});
  return operation;
}
const primary = app.requestSingleInstanceLock();
if (!primary) app.quit();
else app.on("second-instance", (_event, commandLine) => {
  if (!loginStartup.isStartupLaunch(commandLine)) showWindow();
});

async function approveDevice(name, signal) {
  if (signal.aborted || !window || window.isDestroyed()) return false;
  showWindow();
  const answer = await dialog.showMessageBox(window, {
    type: "question", title: "새 기기 등록",
    message: "이 기기를 등록할까요?", detail: name,
    buttons: ["취소", "등록"], defaultId: 0, cancelId: 0, signal
  });
  return !signal.aborted && answer.response === 1;
}

function startAgent() {
  return runAgentOperation(async () => {
    if (shutdown || quitting) return false;
    if (server) return true;
    const instance = createApp(pairing, updates, approveDevice);
    let endpoint = null;
    try {
      await instance.ready();
      endpoint = new PrismoHost(instance, peerID => pairing.hasPeer(peerID));
      await endpoint.start();
      host = endpoint;
      server = instance;
      serverError = "";
      return true;
    } catch (error) {
      if (endpoint) await endpoint.stop().catch(cause => {
        logTransportFailure("startup-cleanup", cause);
      });
      await instance.close().catch(cause => {
        logTransportFailure("agent-cleanup", cause);
      });
      logTransportFailure("startup", error);
      serverError = "연결을 시작할 수 없습니다.";
      return false;
    }
  });
}
function stopAgent() {
  return runAgentOperation(async () => {
    pairing.cancel();
    if (!server) return;
    const instance = server;
    const endpoint = host;
    server = null;
    host = null;
    try {
      if (endpoint) await endpoint.stop();
    } finally {
      await instance.close();
    }
  });
}
function showWindow() {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}
function quitPrismo() {
  if (!shutdown) {
    shutdown = stopAgent().catch(error => {
      logTransportFailure("shutdown", error);
    }).finally(async () => {
      await flushTransportLog();
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
function connectionState() {
  return { ready: Boolean(host), pcID: host?.id ?? null };
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
    return updateCheck.run(async () => {
      sendUpdateStatus("checking", "업데이트 확인 중");
      try {
        const result = await checkLatestGitHubRelease(releaseSource, app.getVersion());
        if (result.kind === "available" && !automatic && window && !window.isDestroyed()) {
          const choice = await dialog.showMessageBox(window, {
            title: "Prismo 업데이트", type: "info",
            message: result.message,
            detail: "자동 다운로드·설치는 코드 서명된 NSIS 설치형에서 지원합니다.",
            buttons: ["닫기", "다운로드 페이지 열기"], defaultId: 0, cancelId: 0
          });
          if (choice.response === 1) await shell.openExternal(releasePage());
        }
        return sendUpdateStatus(result.kind, result.message);
      } catch {
        return sendUpdateStatus("error", "업데이트 정보를 확인하지 못했습니다.");
      }
    });
  }
  await updateCheck.run(async () => {
    sendUpdateStatus("checking", "업데이트 확인 중");
    try {
      await autoUpdater.checkForUpdates();
    } catch {
      sendUpdateStatus("error", "업데이트 확인 실패");
    }
  });
  return pcUpdateState;
}

let previousQR = null;
function pairingLink(connection, pending) {
  return "prismo://pair?v=1&pc=" + encodeURIComponent(connection.pcID) +
    "&code=" + encodeURIComponent(pending.secret);
}
async function pairingState() {
  const running = Boolean(server);
  const connection = connectionState();
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
    pairing: pending ? { active: true, expiresAt: pending.expiresAt, qr,
      link: pairingLink(connection, pending) } : { active: false },
    connectedDevices: pairing.count(), devices: pairing.list(host?.onlinePeers())
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
  handle("prismo:get-login-startup", () => loginStartup.get());
  handle("prismo:set-login-startup", (_event, enabled) => loginStartup.set(enabled));
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
  handle("prismo:copy-pairing-link", async () => {
    const connection = connectionState();
    const pending = pairing.current();
    if (!server || !connection.ready || !pending) {
      throw Error("연결 코드가 없습니다.");
    }
    clipboard.writeText(pairingLink(connection, pending));
    return true;
  });
  handle("prismo:begin-pairing", async () => {
    if (!server) throw Error("서버를 먼저 시작하세요.");
    const connection = connectionState();
    if (!connection.ready) throw Error("연결 설정을 완료하세요.");
    pairing.issue();
    return pairingState();
  });
  handle("prismo:cancel-pairing", async () => {
    pairing.cancel();
    return pairingState();
  });
  handle("prismo:revoke-device", async (_event, id) => {
    if (!pairing.list().some(device => device.id === id)) throw Error("기기를 찾을 수 없습니다.");
    const answer = await dialog.showMessageBox(window, {
      title: "기기 연결 해제", message: "이 기기의 연결을 해제할까요?",
      buttons: ["취소", "해제"], defaultId: 0, cancelId: 0
    });
    if (answer.response === 1) {
      const peerID = pairing.peerID(id);
      await pairing.revoke(id);
      if (peerID) await host?.disconnectPeer(peerID);
    }
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
  window.once("ready-to-show", () => {
    if (!startedAtLogin) window?.show();
  });
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
