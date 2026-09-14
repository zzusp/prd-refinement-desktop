import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronRight, Lightbulb, X } from "lucide-react";
import type { AuditIssue, Clarification, PrdProject, SourceRef } from "./types";
import {
  activeClarifications,
  activePlatformIssues,
  affectedLabels,
  clarificationCounts,
  clarificationLevel,
  clarificationLevelLabel,
  issueTitle,
  readableContext,
  requirementSourceRefs,
  sourceExcerpt,
  sourceHeading,
  sourcePosition,
} from "./result-presentation";

type Item =
  | { kind: "clarification"; value: Clarification }
  | { kind: "platform"; value: AuditIssue };
type Filter = "all" | "blocking" | "suggestion" | "ignorable" | "platform";
type IssueScopeFilter = "all" | "current" | "excluded";

function issueScope(project: PrdProject, item: Item) {
  const ids = item.value.affectedIds,
    requirements = ids.flatMap((id) => {
      const requirement = project.requirements.find((value) => value.id === id);
      if (requirement) return [requirement];
      const feature = project.features.find((value) => value.id === id);
      return feature
        ? feature.requirementIds
            .map((requirementId) =>
              project.requirements.find((value) => value.id === requirementId),
            )
            .filter(Boolean)
        : [];
    });
  return requirements.length > 0 &&
    requirements.every((value) => value?.deliveryScope === "excluded")
    ? "excluded"
    : "current";
}

function evidenceSources(project: PrdProject, item: Item) {
  const refs: SourceRef[] =
    item.kind === "platform"
      ? item.value.sourceUnitIds.map((sourceUnitId) => ({ sourceUnitId }))
      : [
          ...(item.value.sourceRefs ?? []),
          ...item.value.affectedIds.flatMap((id) => {
            const requirement = project.requirements.find(
              (value) => value.id === id,
            );
            return requirement
              ? requirementSourceRefs(requirement)
              : id.startsWith("S-")
                ? [{ sourceUnitId: id }]
                : [];
          }),
        ];
  return [...new Map(refs.map((ref) => [JSON.stringify(ref), ref])).values()]
    .map((ref) => ({
      ref,
      source: project.sourceUnits.find(
        (source) => source.id === ref.sourceUnitId,
      ),
    }))
    .filter((item) => !!item.source);
}

export function ResultIssues({ project, selectedProposalIds = [], onProposalSelection, proposalOverrides={}, onProposalOverride, onGenerateProposals, generating=false }: { project: PrdProject; selectedProposalIds?: string[]; onProposalSelection?: (ids:string[])=>void; proposalOverrides?:Record<string,string>; onProposalOverride?:(id:string,value:string|undefined)=>void; onGenerateProposals?:()=>void; generating?:boolean }) {
  const counts = clarificationCounts(project),
    [filter, setFilter] = useState<Filter>("all"),
    [scopeFilter, setScopeFilter] = useState<IssueScopeFilter>("all"),
    [selectedKey, setSelectedKey] = useState<string>(),
    [editingId,setEditingId]=useState<string>(),
    [editingText,setEditingText]=useState(''),
    [opener, setOpener] = useState<HTMLElement>();
  const items = useMemo<Item[]>(
    () =>
      [
        ...activeClarifications(project).map((value) => ({
          kind: "clarification" as const,
          value,
        })),
        ...activePlatformIssues(project).map((value) => ({
          kind: "platform" as const,
          value,
        })),
      ].sort((a, b) => {
        const rank = (item: Item) =>
          item.kind === "platform"
            ? 0
            : { blocking: 0, suggestion: 1, ignorable: 2 }[
                clarificationLevel(item.value)
              ];
        return rank(a) - rank(b);
      }),
    [project],
  );
  const visible = items.filter((item) => {
    const matchesLevel =
      filter === "all" ||
      (filter === "platform"
        ? item.kind === "platform"
        : item.kind === "clarification" &&
          clarificationLevel(item.value) === filter);
    return (
      matchesLevel &&
      (scopeFilter === "all" || issueScope(project, item) === scopeFilter)
    );
  });
  const selected = items.find(
    (item) => `${item.kind}-${item.value.id}` === selectedKey,
  );
  const selectable=visible.filter((item):item is Extract<Item,{kind:'clarification'}>=>item.kind==='clarification'&&clarificationLevel(item.value)==='blocking'&&!item.value.userDecision&&!!item.value.resolutionProposal).map(item=>item.value.id),selectedSet=new Set(selectedProposalIds);
  const missing=items.filter(item=>item.kind==='clarification'&&clarificationLevel(item.value)==='blocking'&&!item.value.userDecision&&!item.value.resolutionProposal).length;
  const filters: Array<[Filter, string, number]> = [
    ["all", "全部", items.length],
    ["blocking", "阻塞", counts.blocking],
    ["suggestion", "建议", counts.suggestion],
    ["ignorable", "可忽略", counts.ignorable],
    ["platform", "平台整理", counts.platform],
  ];
  return (
    <section className="issues-workspace">
      <header>
        <div>
          <h2>待处理事项</h2>
          <p>问题会随相关需求进入交付包；本期不做不会自动关闭问题。</p>
        </div>
        <div>
          <div className="issue-filters" aria-label="按级别筛选待处理事项">
            {filters.map(([id, label, count]) => (
              <button
                key={id}
                className={filter === id ? "active" : ""}
                aria-pressed={filter === id}
                onClick={() => setFilter(id)}
              >
                {label}
                <b>{count}</b>
              </button>
            ))}
          </div>
          <div className="issue-scope-filters" aria-label="按本期范围筛选">
            {(
              [
                ["all", "全部范围"],
                ["current", "影响本期"],
                ["excluded", "仅影响本期不做"],
              ] as Array<[IssueScopeFilter, string]>
            ).map(([id, label]) => (
              <button
                key={id}
                className={scopeFilter === id ? "active" : ""}
                aria-pressed={scopeFilter === id}
                onClick={() => setScopeFilter(id)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </header>
      {missing>0&&onGenerateProposals&&<div className="proposal-missing"><div><strong>{missing} 项阻塞事项还没有建议方案</strong><span>旧结果可只补充建议方案，无需重跑完整细化。</span></div><button className="secondary" disabled={generating} aria-busy={generating} onClick={onGenerateProposals}>{generating?'正在生成':'生成建议方案'}</button></div>}
      {visible.length === 0 ? (
        <div className="issue-empty">
          <CheckCircle2 />
          <strong>当前没有这类待处理事项</strong>
          <span>可以查看其他级别或返回概览。</span>
        </div>
      ) : (
        <>
        {selectable.length>0&&onProposalSelection&&<div className="proposal-toolbar">
          <label><input type="checkbox" checked={selectable.every(id=>selectedSet.has(id))} onChange={event=>onProposalSelection(event.target.checked?[...new Set([...selectedProposalIds,...selectable])]:selectedProposalIds.filter(id=>!selectable.includes(id)))} />选择当前列表的建议方案</label>
          <strong>已加入本次调整 {selectedProposalIds.length} 项</strong>
        </div>}
        <div className="issue-list">
          {visible.map((item) => {
            const clarification =
                item.kind === "clarification" ? item.value : undefined,
              legacy = clarification && !clarification.knownFacts;
            const level =
              item.kind === "platform"
                ? "blocking"
                : clarificationLevel(clarification!);
            const title =
              item.kind === "platform"
                ? issueTitle(item.value)
                : legacy
                  ? "旧任务中的待确认内容需要重新分析"
                  : clarification!.question;
            const facts =
              item.kind === "platform"
                ? item.value.detail
                : legacy
                  ? "当前记录缺少完整的已知事实，需要平台重新分析。"
                  : clarification!.knownFacts;
            const impact =
              item.kind === "platform"
                ? "修正并重新检查前不能生成正式 Agent 需求包。"
                : legacy
                  ? "重新分析后才能形成可回答的业务问题。"
                  : clarification!.impact;
            const scope = issueScope(project, item);
            return (
              <article
                className="issue-row"
                key={`${item.kind}-${item.value.id}`}
              >
                {clarification?.resolutionProposal&&!clarification.userDecision&&onProposalSelection?<label className="proposal-select" aria-label={`选择建议方案：${title}`}><input type="checkbox" checked={selectedSet.has(clarification.id)} onChange={event=>onProposalSelection(event.target.checked?[...selectedProposalIds,clarification.id]:selectedProposalIds.filter(id=>id!==clarification.id))}/></label>:<span className={`issue-level ${level}`}>
                  {item.kind === "platform"
                    ? "阻塞"
                    : clarificationLevelLabel[level]}
                </span>}
                <div>
                  {clarification?.resolutionProposal&&<span className={`issue-level ${level}`}>{clarificationLevelLabel[level]}</span>}
                  <strong>{title}</strong>
                  <p>
                    <b>已知：</b>
                    {facts}
                  </p>
                  {clarification?.userDecision&&<p className="issue-impact"><strong>已确认，待同步 PRD：</strong>{clarification.userDecision.text}<small>确认时间：{clarification.userDecision.confirmedAt}</small></p>}
                  {clarification?.resolutionProposal&&<section className="resolution-proposal"><header><b><Lightbulb/>建议方案{proposalOverrides[clarification.id]&&<em>已修改</em>}</b>{editingId!==clarification.id&&!clarification.userDecision&&onProposalOverride&&<button className="text-action" type="button" onClick={()=>{setEditingId(clarification.id);setEditingText(proposalOverrides[clarification.id]??clarification.resolutionProposal!.recommendation)}}>修改</button>}</header>{editingId===clarification.id?<div className="proposal-editor"><textarea className="resize-none" aria-label={`修改建议方案：${title}`} rows={3} value={editingText} onChange={event=>setEditingText(event.target.value)}/><footer><button type="button" className="text-action" onClick={()=>setEditingId(undefined)}>取消</button><button type="button" className="secondary" disabled={!editingText.trim()} onClick={()=>{const value=editingText.trim(),original=clarification.resolutionProposal!.recommendation;onProposalOverride?.(clarification.id,value===original?undefined:value);if(!selectedSet.has(clarification.id))onProposalSelection?.([...selectedProposalIds,clarification.id]);setEditingId(undefined)}}>保存并加入本次调整</button></footer></div>:<p>{proposalOverrides[clarification.id]??clarification.resolutionProposal.recommendation}</p>}<small>建议不是 PRD 事实。采纳后保留用户决定；新规则须先同步 PRD，再创建新版本。</small></section>}
                  <p>
                    <b>影响：</b>
                    {impact}
                  </p>
                  <small>
                    <em className={`scope-badge ${scope}`}>
                      {scope === "excluded" ? "仅影响本期不做" : "影响本期"}
                    </em>
                    {item.kind === "platform"
                      ? "平台处理"
                      : clarification?.userDecision ? "待同步 PRD" : level === "blocking"
                        ? "需要你澄清"
                        : level === "suggestion"
                          ? "建议确认"
                          : "无需决定"}{" "}
                    · 影响{" "}
                    {affectedLabels(project, item.value.affectedIds)
                      .slice(0, 2)
                      .join("、")}
                  </small>
                </div>
                <button
                  className="issue-open"
                  aria-label={`查看详情：${title}`}
                  onClick={(event) => {
                    setOpener(event.currentTarget);
                    setSelectedKey(`${item.kind}-${item.value.id}`);
                  }}
                >
                  查看依据
                  <ChevronRight />
                </button>
              </article>
            );
          })}
        </div>
        </>
      )}
      <details className="check-history">
        <summary>
          查看自动检查记录（{project.audit?.issues.length ?? 0}）
        </summary>
        <p>检查记录用于说明平台发现、修复或排除过什么，不要求用户逐条审批。</p>
        {(project.audit?.issues ?? []).map((issue) => (
          <div key={issue.id}>
            <strong>{issueTitle(issue)}</strong>
            <span>
              {issue.disposition === "repaired"
                ? "已修复"
                : issue.disposition === "dismissed"
                  ? "有证据排除"
                  : issue.disposition === "needs-confirmation"
                    ? "已转为业务澄清"
                    : "未解决"}
            </span>
          </div>
        ))}
      </details>
      {selected && (
        <IssueDrawer
          project={project}
          item={selected}
          opener={opener}
          onClose={() => setSelectedKey(undefined)}
        />
      )}
    </section>
  );
}

function IssueDrawer({
  project,
  item,
  opener,
  onClose,
}: {
  project: PrdProject;
  item: Item;
  opener?: HTMLElement;
  onClose: () => void;
}) {
  const clarification = item.kind === "clarification" ? item.value : undefined,
    legacy = clarification && !clarification.knownFacts;
  const level =
    item.kind === "platform" ? "blocking" : clarificationLevel(clarification!);
  function close() {
    onClose();
    requestAnimationFrame(() => opener?.focus());
  }
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [opener, onClose]);
  return (
    <aside className="drawer issue-drawer" aria-label="待处理事项详情">
      <header>
        <div>
          <span className={`issue-level ${level}`}>
            {item.kind === "platform" ? "阻塞" : clarificationLevelLabel[level]}
          </span>
          <h2>
            {item.kind === "platform"
              ? issueTitle(item.value)
              : legacy
                ? "旧任务中的待确认内容需要重新分析"
                : clarification!.question}
          </h2>
          <small>
            {item.kind === "platform" ? "处理方：平台" : "处理方：需求负责人"}
          </small>
        </div>
        <button onClick={close} aria-label="关闭">
          <X />
        </button>
      </header>
      <div>
        {item.kind === "platform" ? (
          <>
            <h3>平台需要处理什么</h3>
            <p>{item.value.detail}</p>
            <h3>为什么阻塞</h3>
            <p>
              当前整理结果存在已确认问题，修正并重新检查前不能作为正式 Agent
              需求包。
            </p>
          </>
        ) : legacy ? (
          <>
            <h3>为什么需要重新分析</h3>
            <p>
              这条记录来自旧版任务，缺少完整问题、影响和分级依据。重新分析后才能作为可回答的业务澄清。
            </p>
          </>
        ) : (
          <>
            <h3>已知事实</h3>
            <p>{clarification!.knownFacts}</p>
            <h3>唯一未决点</h3>
            <p>{clarification!.unresolvedPoint}</p>
            <h3>不处理的影响</h3>
            <p>{clarification!.impact}</p>
            <h3>分级依据</h3>
            <p>{clarification!.levelReason}</p>
            {clarification!.defaultResolution && (
              <>
                <h3>暂不处理时采用的口径</h3>
                <p>{clarification!.defaultResolution}</p>
              </>
            )}
            {clarification!.resolutionProposal&&<section className="drawer-proposal"><h3>建议方案</h3><p>{clarification!.resolutionProposal.recommendation}</p><h3>推荐依据</h3><p>{clarification!.resolutionProposal.rationale}</p><h3>采纳后的影响</h3><p>{clarification!.resolutionProposal.impact}</p><h3>需要确认</h3><p>{clarification!.resolutionProposal.confirmation}</p>{clarification!.resolutionProposal.alternatives.length>0&&<><h3>其他可选方案</h3>{clarification!.resolutionProposal.alternatives.map(value=><p className="rule" key={value}>{value}</p>)}</>}</section>}
          </>
        )}
        <h3>影响内容</h3>
        {affectedLabels(project, item.value.affectedIds).map((label, index) => (
          <p className="rule" key={`${label}-${index}`}>
            {label}
          </p>
        ))}
        <h3>原文依据</h3>
        {evidenceSources(project, item).map(({ source, ref }, index) => (
          <section
            className="source-card"
            key={`${ref.sourceUnitId}-${ref.start ?? "all"}-${index}`}
          >
            <strong>{sourceHeading(source!)}</strong>
            <small>{sourcePosition(source!)}</small>
            {readableContext(source!.context) && (
              <p>{readableContext(source!.context)}</p>
            )}
            <p className="source-excerpt">{sourceExcerpt(source!, ref)}</p>
          </section>
        ))}
        {item.kind === "clarification" && !legacy && (
          <p className="issue-next">
            可在页面上方的调整说明中一次回答这项或多项澄清，无需逐项填写。
          </p>
        )}
        {item.kind === "platform" && (
          <p className="issue-next">
            <AlertTriangle />
            请从任务页重新分析或等待平台修正，不能由业务人员代替平台裁决。
          </p>
        )}
      </div>
    </aside>
  );
}
