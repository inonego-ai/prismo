const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("prismo", Object.freeze({
  state: () => ipcRenderer.invoke("prismo:state"),
  pairingState: () => ipcRenderer.invoke("prismo:pairing-state"),
  checkPCUpdate: () => ipcRenderer.invoke("prismo:check-pc-update"),
  getLoginStartup: () => ipcRenderer.invoke("prismo:get-login-startup"),
  setLoginStartup: enabled => ipcRenderer.invoke("prismo:set-login-startup", enabled),
  onPCUpdate: callback => {
    const listener = (_event, info) => callback(info);
    ipcRenderer.on("prismo:pc-update", listener);
    return () => ipcRenderer.removeListener("prismo:pc-update", listener);
  },
  startServer: () => ipcRenderer.invoke("prismo:start-server"),
  stopServer: () => ipcRenderer.invoke("prismo:stop-server"),
  addRepository: () => ipcRenderer.invoke("prismo:add-repository"),
  removeRepository: id => ipcRenderer.invoke("prismo:remove-repository", id),
  setupConnection: () => ipcRenderer.invoke("prismo:setup-connection"),
  beginPairing: () => ipcRenderer.invoke("prismo:begin-pairing"),
  copyPairingLink: () => ipcRenderer.invoke("prismo:copy-pairing-link"),
  cancelPairing: () => ipcRenderer.invoke("prismo:cancel-pairing"),
  revokeDevices: () => ipcRenderer.invoke("prismo:revoke-devices")
}));