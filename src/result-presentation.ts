import type { AuditIssue, Feature, PrdProject, RequirementDetail, SourceRef, SourceUnit } from './types.js';

const internalSourcePattern = /\[S-[^\]]+\]\s*/g;

export function readableContext(value?: string) {
  if (!value) return '';
  return value
    .replace(/资料角色：[^。]+。[^\n]*\n?/g, '')
    .replace(/<\/?source-structure-context>/g, '')
    .replace(/表格原始位置：[^\n]+\n?/g, '')
    .replace(internalSourcePattern, '')
    .trim();
}

export function sourceExcerpt(unit: SourceUnit, ref?: SourceRef) {
  const text = unit.asset?.extractedText ?? unit.excerpt;
  return ref?.start !== undefined && ref.end !== undefined ? text.slice(ref.start, ref.end) : text;
}

export function requirementSourceRefs(requirement: RequirementDetail):SourceRef[] {
  const legacy = requirement as RequirementDetail & { sourceUnitIds?: string[] };
  if (Array.isArray(requirement.sourceRefs)) return requirement.sourceRefs;
  return (legacy.sourceUnitIds ?? []).map(sourceUnitId => ({ sourceUnitId }));
}

export function requirementText(requirement: RequirementDetail) {
  const legacy = requirement as RequirementDetail & { title?: string; behavior?: string };
  return requirement.text?.trim() || legacy.title?.trim() || legacy.behavior?.trim() || '需求内容待读取';
}

export function sourceHeading(unit: SourceUnit) {
  const context = readableContext(unit.context);
  const path = context.match(/章节路径：([^\n]+)/)?.[1]?.split('→').map(value => value.trim()).filter(Boolean);
  const heading = path?.at(-1);
  const label = unit.label?.trim();
  return heading || (label && label.length <= 80 ? label : '') || '原文内容';
}

export function sourcePosition(unit: SourceUnit) {
  const file = unit.logicalPath || unit.location.split(' · ')[0] || '来源文件';
  let location = unit.location;
  if (location.startsWith(`${file} · `)) location = location.slice(file.length + 3);
  location = location.replace(/^[^/]+\s\/\s/, '').replace(/\s*\/\s*/g, ' · ');
  const revision = unit.fileRevision === undefined ? '' : ` · 文件版本 ${unit.fileRevision}`;
  return `${file}${revision} · ${location}`;
}

export function featureTitle(project: PrdProject, feature: Feature) {
  if (feature.name?.trim()) return feature.name.trim();
  const refs = feature.sourceRefs?.length ? feature.sourceRefs : feature.sourceUnitIds.map(sourceUnitId => ({ sourceUnitId }));
  const first = refs[0], unit = first && project.sourceUnits.find(item => item.id === first.sourceUnitId);
  if (!unit) return feature.kind === 'constraint' ? '跨功能约束' : '业务功能';
  const heading = sourceHeading(unit), excerpt = sourceExcerpt(unit, first).replace(/\s+/g, ' ').trim();
  if (heading !== '原文内容' && heading !== excerpt) return heading;
  return excerpt.length > 64 ? `${excerpt.slice(0, 64)}…` : excerpt || heading;
}

export function affectedLabels(project: PrdProject, ids: string[]) {
  return ids.map(id => {
    const requirement = project.requirements.find(item => item.id === id);
    if (requirement) return requirementText(requirement);
    const feature = project.features.find(item => item.id === id);
    if (feature) return featureTitle(project, feature);
    const source = project.sourceUnits.find(item => item.id === id);
    if (source) return `${sourceHeading(source)}（${sourcePosition(source)}）`;
    return '尚未定位的内容';
  });
}

export function issueTitle(issue: AuditIssue) {
  if (issue.owner === 'runtime-output') return '分析结果未能通过校验';
  if (issue.category === 'feature-boundary') return '功能范围需要平台重新整理';
  if (issue.category === 'detail-mismatch') return '需求内容需要平台重新整理';
  return issue.type || '平台整理问题';
}
