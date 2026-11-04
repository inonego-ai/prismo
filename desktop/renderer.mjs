const element = id => document.getElementById(id);
const ui = {
  serverDot: element("server-dot"), serverLabel: element("server-label"),
  power: element("power-button"), pcUpdate: element("pc-update-button"),
  settingsButton: element("settings-button"), settingsDialog: element("settings-dialog"),
  closeSettings: element("close-settings-button"),
  loginStartup: element("login-startup-toggle"), loginStartupHint: element("login-startup-hint"),
  status: element("connection-status"),
  empty: element("pair-placeholder"), message: element("pair-message"),
  active: element("pair-active"), qr: element("qr-image"), countdown: element("countdown"),
  pair: element("pair-button"), pairLabel: element("pair-label"),
  cancel: element("cancel-pair-button"), copyLink: element("copy-pair-link-button"),
  refresh: element("refresh-button"),
  devices: element("devices-count"), revoke: element("revoke-button"),
  add: element("add-button"), repoCount: element("repo-count"),
  list: element("repository-list"), toast: element("toast")
};
let state = null;
let busy = false;
let lastFullSync = 0;
let refreshing = false;
let actionRevision = 0;
let notificationTimer;

function notify(message) {
  ui.toast.textContent = message;
  ui.toast.classList.add("show");
  clearTimeout(notificationTimer);
  notificationTimer = setTimeout(() => ui.toast.classList.remove("show"), 3200);
}
function countdown() {
  const expiry = state?.pairing?.expiresAt;
  if (!expiry) return;
  const seconds = Math.max(0, Math.ceil((expiry - Date.now()) / 1000));
  ui.countdown.textContent = String(Math.floor(seconds / 60)).padStart(2, "0")
    + ":" + String(seconds % 60).padStart(2, "0");
  if (seconds === 0) {
    if (ui.active.open) ui.active.close();
    ui.empty.hidden = false;
    ui.message.textContent = "연결 코드 만료됨";
    ui.pair.disabled = false;
  }
}
function repositoryRow(repo) {
  const row = document.createElement("div");
  row.className = "repo-item";
  const info = document.createElement("div");
  info.className = "repo-meta";
  const title = document.createElement("div");
  title.className = "repo-name";
  title.textContent = repo.name;
  title.title = repo.name;
  const details = document.createElement("div");
  details.className = "repo-detail";
  details.textContent = repo.issue === "temporary" ? "일시적으로 상태를 조회할 수 없음"
    : repo.branch == null ? "접근할 수 없음"
    : repo.branch + "  ·  " + repo.changes + "개 변경";
  const location = document.createElement("div");
  location.className = "repo-detail";
  location.textContent = repo.path;
  location.title = repo.path;
  info.append(title, details, location);

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "repo-remove";
  remove.title = "저장소 해제";
  remove.setAttribute("aria-label", repo.name + " 해제");
  remove.disabled = busy;
  const icon = document.createElement("img");
  icon.src = "./icons/trash-2.svg";
  icon.alt = "";
  remove.append(icon);
  remove.addEventListener("click", () =>
    perform(() => window.prismo.removeRepository(repo.id)));
  row.append(info, remove);
  return row;
}
function renderConnection(next) {
  const ready = next.running && next.connection.ready;
  const active = ready && next.pairing.active && next.pairing.expiresAt > Date.now();
  ui.serverDot.classList.toggle("live", next.running);
  ui.serverLabel.textContent = next.running ? "서버 실행 중" : "서버 중지됨";
  ui.power.title = next.running ? "서버 중지" : "서버 시작";
  ui.power.setAttribute("aria-label", ui.power.title);
  ui.power.disabled = busy;
  ui.status.textContent = ready ? "준비됨" : "연결 필요";
  ui.status.classList.toggle("ready", ready);

  if (active && !ui.active.open) ui.active.showModal();
  if (!active && ui.active.open) ui.active.close();
  ui.empty.hidden = active;
  if (active) {
    ui.qr.src = next.pairing.qr;
    countdown();
  } else {
    ui.qr.removeAttribute("src");
    ui.message.textContent = !next.running ? "서버가 중지됨"
      : next.connection.reason === "install" ? "연결 설정 필요"
      : ready && next.connectedDevices > 0 ? "기기 연결됨"
      : ready ? "새 기기를 연결하세요"
      : "연결 설정 필요";
  }
  ui.pair.hidden = active;
  ui.pair.disabled = busy || !next.running;
  ui.pairLabel.textContent = ready ? "QR 생성" : "연결 설정";
  ui.cancel.disabled = busy;
  ui.copyLink.disabled = busy;
  ui.refresh.disabled = busy;
  ui.devices.textContent = "연결된 기기 " + next.connectedDevices + "대";
  ui.revoke.hidden = next.connectedDevices === 0;
  ui.revoke.disabled = busy;
}
function render(next) {
  state = next;
  lastFullSync = Date.now();
  renderConnection(next);
  ui.add.disabled = busy;
  ui.repoCount.textContent = String(next.repositories.length);
  ui.list.replaceChildren();
  if (next.repositories.length === 0) {
    const empty = document.createElement("div");
    empty.className = "repo-empty";
    empty.textContent = "등록된 저장소 없음";
    ui.list.append(empty);
  } else {
    next.repositories.forEach(repo => ui.list.append(repositoryRow(repo)));
  }
  if (next.serverError) notify(next.serverError);
}
function renderPairing(next) {
  if (!state) return;
  state = { ...state, ...next };
  renderConnection(state);
}
async function perform(action) {
  if (busy) return;
  actionRevision++;
  busy = true;
  if (state) render(state);
  try {
    const next = await action();
    if (Array.isArray(next?.repositories)) render(next);
    else renderPairing(next);
  } catch (error) {
    notify((error?.message ?? "작업을 완료하지 못했습니다.").replace(
      /^Error invoking remote method '[^']+': /, ""
    ));
  } finally {
    busy = false;
    if (state) render(state);
  }
}
async function refreshState() {
  if (refreshing || busy) return;
  refreshing = true;
  const revision = actionRevision;
  try {
    const next = await window.prismo.state();
    if (!busy && revision === actionRevision) render(next);
  } catch {
    notify("상태를 불러올 수 없습니다.");
  } finally {
    refreshing = false;
    lastFullSync = Date.now();
  }
}
ui.settingsButton.addEventListener("click", async () => {
  ui.settingsButton.disabled = true;
  try {
    const current = await window.prismo.getLoginStartup();
    ui.loginStartup.checked = current.enabled;
    ui.loginStartup.disabled = !current.supported;
    ui.loginStartupHint.textContent = current.supported
      ? "로그인하면 Prismo를 트레이에서 시작합니다."
      : "Windows 배포판에서 사용할 수 있습니다.";
    ui.settingsDialog.showModal();
  } catch { notify("설정을 불러올 수 없습니다."); }
  finally { ui.settingsButton.disabled = false; }
});
ui.closeSettings.addEventListener("click", () => ui.settingsDialog.close());
ui.loginStartup.addEventListener("change", async () => {
  const requested = ui.loginStartup.checked;
  ui.loginStartup.disabled = true;
  try {
    const result = await window.prismo.setLoginStartup(requested);
    ui.loginStartup.checked = result.enabled;
    if (result.enabled !== requested) notify("Windows 시작 설정이 적용되지 않았습니다.");
  } catch {
    ui.loginStartup.checked = !requested;
    notify("Windows 시작 설정을 변경할 수 없습니다.");
  } finally { ui.loginStartup.disabled = false; }
});
ui.pcUpdate.addEventListener("click", async () => {
  ui.pcUpdate.disabled = true;
  try {
    const result = await window.prismo.checkPCUpdate();
    notify(result.message);
  } catch { notify("업데이트 확인 실패"); }
  finally { ui.pcUpdate.disabled = false; }
});
window.prismo.onPCUpdate(result => {
  ui.pcUpdate.title = result.message;
  ui.pcUpdate.setAttribute("aria-label", "PC 업데이트: " + result.message);
});
ui.power.addEventListener("click", () => perform(() =>
  state?.running ? window.prismo.stopServer() : window.prismo.startServer()
));
ui.pair.addEventListener("click", () => perform(() =>
  state?.connection?.ready ? window.prismo.beginPairing() : window.prismo.setupConnection()
));
ui.cancel.addEventListener("click", () => perform(() => window.prismo.cancelPairing()));
ui.copyLink.addEventListener("click", async () => {
  try {
    await window.prismo.copyPairingLink();
    notify("연결 링크 복사됨");
  } catch { notify("연결 링크를 복사할 수 없습니다."); }
});
ui.active.addEventListener("cancel", event => {
  event.preventDefault();
  perform(() => window.prismo.cancelPairing());
});
ui.revoke.addEventListener("click", () => perform(() => window.prismo.revokeDevices()));
ui.refresh.addEventListener("click", () => perform(() => window.prismo.state()));
ui.add.addEventListener("click", () => perform(() => window.prismo.addRepository()));
refreshState();
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void refreshState();
});
setInterval(() => {
  if (document.hidden) return;
  countdown();
  if (busy) return;
  if (!state || Date.now() - lastFullSync >= 8000) {
    refreshState();
  } else if (state.pairing?.active) {
    const expiresAt = state.pairing.expiresAt;
    window.prismo.pairingState().then(next => {
      if (!busy && state?.pairing?.expiresAt === expiresAt) renderPairing(next);
    }).catch(() => {});
  }
}, 1000);
