import { describe, expect, it, vi } from 'vitest';
import { checkForAppUpdate, compareVersions } from '../electron/app-update';

describe('应用更新检查', () => {
  it('按语义版本判断稳定版与预发布版', () => {
    expect(compareVersions('0.1.10', '0.1.9')).toBe(1);
    expect(compareVersions('v1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBe(-1);
    expect(compareVersions('1.0.0-rc.2', '1.0.0-rc.1')).toBe(1);
  });

  it('返回最新版及是否需要更新', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      tag_name: 'v0.1.6',
      html_url: 'https://github.com/zzusp/prd-refinement-desktop/releases/tag/v0.1.6',
      published_at: '2026-09-16T00:00:00Z',
    }), { status: 200 }));
    await expect(checkForAppUpdate('0.1.5', fetcher)).resolves.toEqual({
      currentVersion: '0.1.5',
      latestVersion: '0.1.6',
      updateAvailable: true,
      releaseUrl: 'https://github.com/zzusp/prd-refinement-desktop/releases/tag/v0.1.6',
      publishedAt: '2026-09-16T00:00:00Z',
    });
  });

  it('不会把请求失败或无效响应误报为最新版', async () => {
    const unavailable = vi.fn(async () => new Response('', { status: 503 }));
    await expect(checkForAppUpdate('0.1.5', unavailable)).rejects.toThrow('HTTP 503');
    const invalid = vi.fn(async () => new Response(JSON.stringify({ tag_name: 'latest' }), { status: 200 }));
    await expect(checkForAppUpdate('0.1.5', invalid)).rejects.toThrow('无法识别的版本信息');
  });
});
