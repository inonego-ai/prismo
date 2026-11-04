# Prismo

[![Version](https://img.shields.io/badge/version-0.1.0-6366f1)](https://github.com/inonego-ai/prismo)
[![CI](https://github.com/inonego-ai/prismo/actions/workflows/ci.yml/badge.svg)](https://github.com/inonego-ai/prismo/actions/workflows/ci.yml)
[![Read-only](https://img.shields.io/badge/access-read--only-10b981)](#features)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

<p align="center">
  <img src="docs/images/file-tree.png" alt="Prismo file tree view" width="48%" />
  <img src="docs/images/code-diff.png" alt="Prismo code diff view" width="48%" />
</p>

View your PC's Git repositories from your Android device, without pushing or cloning your work.

## Features

- Browse repositories, folders, and files.
- Review staged, unstaged, and untracked changes with diffs.
- Explore commit history and changed files.
- Connect devices with a one-time QR code over a private connection.
- Restrict access to common sensitive paths.
- Optionally start the Windows desktop agent at login from the Settings menu (tray-only startup).

Git access is read-only. Connections authenticate both the Iroh peer identity and a per-device token; relays may observe connection metadata.

## Build from source

From the project root, build the Windows app:

```powershell
cd agent
npm ci
cd ../desktop
npm ci
npm run portable
```

For Android (JDK 21, Android SDK, and Node.js 24+ installed), build from the project root:

```powershell
cd renderer
npm ci
cd ..\android
.\gradlew.bat :app:assembleDebug
```

## License

[MIT](LICENSE) · [Third-party licenses](docs/OPEN_SOURCE_LICENSES.md)
