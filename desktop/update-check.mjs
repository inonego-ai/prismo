const VERSION = /^v?(\d+)\.(\d+)\.(\d+)$/;

function versionParts(value) {
  const match = VERSION.exec(value);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}

export function compareReleaseVersions(current, latest) {
  const a = versionParts(current);
  const b = versionParts(latest);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return Math.sign(b[index] - a[index]);
  }
  return 0;
}

export async function checkLatestGitHubRelease(source, currentVersion, fetcher = fetch) {
  const url = `https://api.github.com/repos/${source.owner}/${source.repo}/releases/latest`;
  const response = await fetcher(url, {
    headers: {
      "User-Agent": "Prismo-Desktop",
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28"
    },
    signal: AbortSignal.timeout(12_000)
  });
  if (response.status === 404) {
    await response.body?.cancel();
    return { kind: "unpublished", message: "아직 공개된 Prismo 릴리스가 없습니다." };
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw Error("GitHub release lookup failed: " + response.status);
  }
  const release = await response.json();
  if (!release || typeof release !== "object" || release.draft || release.prerelease
    || typeof release.tag_name !== "string" || !/^v\d+\.\d+\.\d+$/.test(release.tag_name)) {
    return { kind: "error", message: "릴리스 버전을 확인할 수 없습니다." };
  }
  const comparison = compareReleaseVersions(currentVersion, release.tag_name);
  if (comparison === null) return { kind: "error", message: "릴리스 버전을 비교할 수 없습니다." };
  if (comparison > 0) {
    return {
      kind: "available",
      message: "새 버전 " + release.tag_name + "이 있습니다. 이 실행 방식은 수동 설치가 필요합니다."
    };
  }
  return { kind: "current", message: "현재 최신 버전입니다 (" + currentVersion + ")." };
}

export function createUpdateCheckGate() {
  let active = null;
  let interactions = [];
  return {
    track(interaction) {
      const pending = Promise.resolve(interaction);
      pending.catch(() => {});
      interactions.push(pending);
    },
    run(check) {
      if (active) return active;
      interactions = [];
      const operation = Promise.resolve().then(async () => {
        const result = await check();
        for (let index = 0; index < interactions.length; index++) {
          await interactions[index];
        }
        return result;
      });
      const shared = operation.finally(() => {
        if (active === shared) active = null;
      });
      active = shared;
      return shared;
    }
  };
}
