import { useEffect, useState } from "react";
import { ChevronRight, X } from "lucide-react";
import type { PrdProject } from "./types";
import { affectedLabels, issueTitle, sourceExcerpt, sourceHeading, sourcePosition } from "./result-presentation";

/** 平台执行记录，业务结果仅展示功能模块和需求清单。 */
export function ResultIssues({ project }: { project: PrdProject }) {
  const [selectedId, setSelectedId] = useState<string>();
  const [opener, setOpener] = useState<HTMLElement>();
  const issues = project.audit?.issues ?? [];
  const selected = issues.find((item) => item.id === selectedId);
  function close() {
    setSelectedId(undefined);
    requestAnimationFrame(() => opener?.focus());
  }
  useEffect(() => {
    if (!selectedId) return;
    const listener = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [selectedId, opener]);
  if (!issues.length) return null;
  return (
    <section className="issues-workspace" aria-label="平台检查记录">
      <header><div><h2>平台检查记录</h2><p>记录需求清单的原文核查和修正结果。</p></div></header>
      <div className="issue-list">
        {issues.map((issue) => (
          <article className="issue-row" key={issue.id}>
            <span className="issue-level">{issue.disposition === "repaired" ? "已修复" : issue.disposition === "dismissed" ? "已排除" : "未通过"}</span>
            <div><strong>{issueTitle(issue)}</strong><p>{issue.detail}</p></div>
            <button className="issue-open" aria-label={`查看依据：${issueTitle(issue)}`} onClick={(event) => { setOpener(event.currentTarget); setSelectedId(issue.id); }}>查看依据<ChevronRight /></button>
          </article>
        ))}
      </div>
      {selected && (
        <aside className="drawer issue-drawer" aria-label="平台检查详情">
          <header><h2>{issueTitle(selected)}</h2><button onClick={close} aria-label="关闭"><X /></button></header>
          <div>
            <p>{selected.detail}</p>
            <h3>涉及内容</h3>
            {affectedLabels(project, selected.affectedIds).map((label, index) => <p className="rule" key={`${label}-${index}`}>{label}</p>)}
            <h3>原文依据</h3>
            {selected.sourceUnitIds.map((id) => {
              const source = project.sourceUnits.find((unit) => unit.id === id);
              return source && <section className="source-card" key={id}><strong>{sourceHeading(source)}</strong><small>{sourcePosition(source)}</small><p className="source-excerpt">{sourceExcerpt(source)}</p></section>;
            })}
          </div>
        </aside>
      )}
    </section>
  );
}
