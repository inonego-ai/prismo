const STARTUP_ARGUMENT = "--prismo-startup";

export function createLoginStartup(app, {
  platform = process.platform,
  executablePath = process.execPath,
  portableExecutablePath = process.env.PORTABLE_EXECUTABLE_FILE
} = {}) {
  const supported = platform === "win32" && app.isPackaged;
  const options = {
    path: portableExecutablePath || executablePath,
    args: [STARTUP_ARGUMENT]
  };

  function get() {
    if (!supported) return { supported: false, enabled: false };
    const current = app.getLoginItemSettings(options);
    return {
      supported: true,
      enabled: Boolean(current.openAtLogin && current.executableWillLaunchAtLogin !== false)
    };
  }

  function set(enabled) {
    if (!supported || typeof enabled !== "boolean") throw Error("Invalid startup setting");
    app.setLoginItemSettings({ ...options, openAtLogin: enabled });
    return get();
  }

  return {
    get, set,
    isStartupLaunch: args => args.includes(STARTUP_ARGUMENT)
  };
}
