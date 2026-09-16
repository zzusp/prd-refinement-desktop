import type { AppUpdateResult } from '../src/types.js';

export const RELEASES_URL = 'https://github.com/zzusp/prd-refinement-desktop/releases/latest';
const LATEST_RELEASE_API = 'https://api.github.com/repos/zzusp/prd-refinement-desktop/releases/latest';

type ReleasePayload = {
  tag_name?: unknown;
  html_url?: unknown;
  published_at?: unknown;
};

function versionParts(value: string) {
  const normalized = value.trim().replace(/^v/i, '');
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(normalized);
  if (!match) throw new Error(`无法识别版本号：${value}`);
  return {
    normalized,
    numbers: match.slice(1, 4).map(Number),
    prerelease: match[4]?.split('.'),
  };
}

export function compareVersions(left: string, right: string) {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < 3; index++) {
    if (a.numbers[index] !== b.numbers[index])
      return a.numbers[index] > b.numbers[index] ? 1 : -1;
  }
  if (!a.prerelease && !b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index++) {
    const leftPart = a.prerelease[index];
    const rightPart = b.prerelease[index];
    if (leftPart === rightPart) continue;
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    const leftNumber = /^\d+$/.test(leftPart) ? Number(leftPart) : undefined;
    const rightNumber = /^\d+$/.test(rightPart) ? Number(rightPart) : undefined;
    if (leftNumber !== undefined && rightNumber !== undefined)
      return leftNumber > rightNumber ? 1 : -1;
    if (leftNumber !== undefined) return -1;
    if (rightNumber !== undefined) return 1;
    return leftPart.localeCompare(rightPart) > 0 ? 1 : -1;
  }
  return 0;
}

export async function checkForAppUpdate(
  currentVersion: string,
  fetcher: typeof fetch = fetch,
): Promise<AppUpdateResult> {
  versionParts(currentVersion);
  let response: Response;
  try {
    response = await fetcher(LATEST_RELEASE_API, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'prd-refinement-desktop',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error('无法连接更新服务，请检查网络后重试');
  }
  if (!response.ok)
    throw new Error(`更新服务暂不可用（HTTP ${response.status}），请稍后重试`);
  let payload: ReleasePayload;
  try {
    payload = (await response.json()) as ReleasePayload;
  } catch {
    throw new Error('更新服务返回了无法识别的版本信息');
  }
  if (
    typeof payload.tag_name !== 'string' ||
    typeof payload.html_url !== 'string' ||
    typeof payload.published_at !== 'string'
  )
    throw new Error('更新服务返回了无法识别的版本信息');
  const latestVersion = versionParts(payload.tag_name).normalized;
  if (!payload.html_url.startsWith('https://github.com/zzusp/prd-refinement-desktop/releases/'))
    throw new Error('更新服务返回了非官方发布地址');
  return {
    currentVersion: versionParts(currentVersion).normalized,
    latestVersion,
    updateAvailable: compareVersions(latestVersion, currentVersion) > 0,
    releaseUrl: payload.html_url,
    publishedAt: payload.published_at,
  };
}
