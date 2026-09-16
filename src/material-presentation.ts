import type { BundleState, MaterialFile, MaterialRole } from './material-types.js';

export const materialStateLabels: Record<BundleState, string> = {
  draft: '待识别',
  indexing: '识别与索引中',
  'needs-materials': '待补充资料',
  ready: '索引就绪',
  failed: '索引失败',
  cancelled: '已取消',
};

export const materialFileStateLabels: Record<MaterialFile['status'], string> = {
  registered: '待读取',
  reading: '读取中',
  read: '已读取',
  blocked: '需要处理',
  excluded: '已排除',
};

export const materialRoleLabels: Record<MaterialRole, string> = {
  primary: '主 PRD',
  supplement: '补充资料',
  historical: '历史参考',
};

export function formatMaterialSize(bytes?: number) {
  if (bytes === undefined) return '未记录';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
