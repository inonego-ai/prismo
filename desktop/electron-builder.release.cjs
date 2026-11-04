const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const base = require("./package.json").build;
const config = JSON.parse(readFileSync(resolve(__dirname, "../release-config.json"), "utf8"));
const github = config.github;

function valid(segment) {
  return typeof segment === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(segment);
}
if (!github || !valid(github.owner) || !valid(github.repo)) {
  throw Error("Set GitHub owner/repo in release-config.json before building an installer.");
}
const hasSigning = Boolean(
  process.env.CSC_LINK || process.env.WIN_CSC_LINK || process.env.CSC_NAME
);
const publisherName = process.env.PRISMO_WINDOWS_PUBLISHER;
if (!hasSigning || !publisherName || !publisherName.trim()) {
  throw Error("A Windows signing certificate and matching publisher name are required.");
}

module.exports = {
  ...base,
  directories: { ...base.directories, output: "release-installer" },
  win: { ...base.win, target: ["nsis"], publisherName: [publisherName] },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true
  },
  publish: {
    provider: "github",
    owner: github.owner,
    repo: github.repo
  }
};
