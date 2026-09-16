import { useEffect, useRef, useState } from 'react';
import { FileText, FolderOpen, Plus, RotateCw, Search, Upload, X } from 'lucide-react';
import type { MaterialBundle, MaterialFile, MaterialRole, MaterialSearchResult } from './material-types';
import type { AnalysisTask, SourceUnit } from './types';
import { readableContext, sourceHeading, sourcePosition } from './result-presentation';
import { materialFileStateLabels as fileStates, materialRoleLabels as roles, materialStateLabels as states } from './material-presentation';

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export type MaterialWorkspaceMode = {kind:'new'}|{kind:'adjustment';baseTaskId:string;baseVersion:number;projectName:string};
export function MaterialWorkspace({ onStarted, onBack, mode={kind:'new'} }: { onStarted: (task:AnalysisTask) => void; onBack: () => void; mode?:MaterialWorkspaceMode }) {
  const api = window.prdApp?.materials;
  const [bundles, setBundles] = useState<MaterialBundle[]>([]), [bundle, setBundle] = useState<MaterialBundle>();
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [saved, setSaved] = useState('');
  const [role, setRole] = useState<MaterialRole>('supplement'), [mount, setMount] = useState('');
  const [dragging, setDragging] = useState(false), [fileFilter, setFileFilter] = useState(''), [filePage, setFilePage] = useState(0);
  const [editing, setEditing] = useState<string>(), [tab, setTab] = useState<'files' | 'sources'>('files');
  const [query, setQuery] = useState(''), [queryFile, setQueryFile] = useState(''), [offset, setOffset] = useState(0);
  const [result, setResult] = useState<MaterialSearchResult>(), [searching, setSearching] = useState(false), [source, setSource] = useState<SourceUnit>();
  const [issuesExpanded, setIssuesExpanded] = useState(false);
  const [renamingBundle, setRenamingBundle] = useState(false), [bundleName, setBundleName] = useState(''), [confirmDelete, setConfirmDelete] = useState(false);
  const [analysisText,setAnalysisText]=useState(''),[draftState,setDraftState]=useState<'idle'|'saving'|'saved'|'error'>('idle'),[detailsOpen,setDetailsOpen]=useState(false);
  useEffect(() => setIssuesExpanded(false), [bundle?.id, bundle?.revision]);
  const generation = useRef(0), lock = useRef(false), currentId = useRef(''), mounted = useRef(true), depth = useRef(0), searchGeneration = useRef(0), startOperation=useRef('');
  const locked = !!busy || bundle?.state === 'indexing';
  function accept(next: MaterialBundle) { setBundle(next); setBundles(all => [next, ...all.filter(item => item.id !== next.id)]); }
  useEffect(()=>{if(!bundle)return;setAnalysisText(bundle.analysisDraft?.text??'');setDraftState(bundle.analysisDraft?'saved':'idle')},[bundle?.id]);
  useEffect(()=>{
    if(!api||!bundle||analysisText===(bundle.analysisDraft?.text??''))return;
    setDraftState('saving');const id=bundle.id,revision=bundle.analysisDraft?.revision??0;
    const timer=setTimeout(()=>{void api.saveAnalysisDraft(id,analysisText,revision).then(next=>{if(mounted.current&&currentId.current===id){accept(next);setDraftState('saved')}}).catch(value=>{if(mounted.current&&currentId.current===id){setDraftState('error');setError(`说明保存失败：${message(value)}。输入已保留，可重试。`)}})},600);
    return()=>clearTimeout(timer);
  },[api,bundle?.id,bundle?.analysisDraft?.text,bundle?.analysisDraft?.revision,analysisText]);
  useEffect(() => { mounted.current = true; if (!api) return;
    if(mode.kind==='adjustment')void api.prepareAdjustment(mode.baseTaskId,mode.baseVersion).then(next=>{if(mounted.current){currentId.current=next.id;setBundles([next]);accept(next)}}).catch(e=>{if(mounted.current)setError(message(e))});
    else void api.list().then(items => { if (mounted.current) setBundles(items); }).catch(e => setError(message(e)));
    return () => { mounted.current = false; generation.current++; };
  }, [api,mode.kind,mode.kind==='adjustment'?mode.baseTaskId:'',mode.kind==='adjustment'?mode.baseVersion:0]);
  async function run(label: string, operation: () => Promise<MaterialBundle>) {
    if (lock.current) return; lock.current = true; const token = ++generation.current; setBusy(label); setError(''); setSaved('');
    try { const next = await operation(); if (mounted.current && token === generation.current) { currentId.current = next.id; accept(next); setSaved(`已保存到本机 · ${new Date(next.updatedAt).toLocaleTimeString('zh-CN')}`); } }
    catch (e) { if (mounted.current && token === generation.current) setError(message(e)); }
    finally { if (token === generation.current) { lock.current = false; if (mounted.current) setBusy(''); } }
  }
  async function cancelAddition() {
    if (!api || !bundle || busy !== '添加并保存资料') return; const token = ++generation.current; setBusy('正在取消添加');
    try { const next = await api.cancel(bundle.id); if (mounted.current && token === generation.current) { accept(next); setSaved('已取消添加，保留已保存资料'); } } catch(e) { if (mounted.current) setError(message(e)); } finally { if (token === generation.current) { lock.current = false; if (mounted.current) setBusy(''); } }
  }
  async function select(id: string) { if (!api || lock.current) return; setSource(undefined); setEditing(undefined); setResult(undefined); setOffset(0); setQueryFile(''); setFilePage(0); setRenamingBundle(false); setConfirmDelete(false); await run('读取资料包', () => api.get(id)); }
  useEffect(() => {
    if (!api || bundle?.state !== 'indexing') return;
    let alive = true, pending = false; const id = bundle.id;
    const timer = setInterval(async () => { if (pending || lock.current) return; pending = true; const token = generation.current; try { const next = await api.get(id); if (alive && currentId.current === id && token === generation.current) accept(next); } catch (e) { if (alive) setError(`进度读取失败：${message(e)}。可刷新资料包重试。`); } finally { pending = false; } }, 1000);
    return () => { alive = false; clearInterval(timer); };
  }, [api, bundle?.id, bundle?.state]);
  useEffect(() => { const prevent = (event: DragEvent) => event.preventDefault(); window.addEventListener('dragover', prevent); window.addEventListener('drop', prevent); return () => { window.removeEventListener('dragover', prevent); window.removeEventListener('drop', prevent); }; }, []);
  useEffect(() => {
    if (!api || !bundle || tab !== 'sources' || bundle.indexedRevision !== bundle.revision) return;
    let alive = true; const token = ++searchGeneration.current; setSearching(true); setSource(undefined);
    const timer = setTimeout(() => { void api.query(bundle.id, { query, fileId: queryFile || undefined, offset, limit: 25 }).then(value => { if (alive && token === searchGeneration.current) setResult(value); }).catch(e => { if (alive) setError(message(e)); }).finally(() => { if (alive) setSearching(false); }); }, 200);
    return () => { alive = false; clearTimeout(timer); };
  }, [api, bundle?.id, bundle?.revision, bundle?.indexedRevision, tab, query, queryFile, offset]);
  async function add(kind: 'files' | 'directory', files?: File[], primary = false) {
    if (!api || locked) return;
    await run('添加并保存资料', async () => {
      const target = bundle ?? await api.create();
      const hasPrimary = target.files.some(file => file.role === 'primary' && file.status !== 'excluded');
      return api.add(target.id, { kind, role: primary || !hasPrimary ? 'primary' : role, mount: mount.trim() || undefined }, files);
    });
  }
  async function preview(unit: SourceUnit) {
    if (!api || !bundle) return; const id = bundle.id, token = ++searchGeneration.current;
    try { const units = await api.read(id, [unit.id]); if (mounted.current && currentId.current === id && token === searchGeneration.current) setSource(units[0]); } catch(e) { setError(message(e)); }
  }
  useEffect(() => { const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setSource(undefined); }; window.addEventListener('keydown', close); return () => window.removeEventListener('keydown', close); }, []);
  async function start() {
    if (!api || !bundle || lock.current) return; lock.current = true; setBusy('正在准备并开始分析'); setError('');setDraftState('saving');
    if(!startOperation.current)startOperation.current=crypto.randomUUID();
    const id=bundle.id,poll=setInterval(()=>{void api.get(id).then(next=>{if(mounted.current&&currentId.current===id)accept(next)}).catch(()=>undefined)},700);
    try { const task=mode.kind==='adjustment'
      ?await window.prdApp.startMaterialAdjustment(mode.baseTaskId,mode.baseVersion,id,analysisText,bundle.analysisDraft?.revision??0,startOperation.current)
      :await window.prdApp.startMaterialAnalysis(id,analysisText,bundle.analysisDraft?.revision??0,startOperation.current);setDraftState('saved');onStarted(task); }
    catch(e) { setError(message(e));startOperation.current=''; }
    finally { clearInterval(poll);lock.current = false; if (mounted.current) setBusy(''); }
  }
  async function deleteBundle() {
    if (!api || !bundle || lock.current) return; const id=bundle.id,token=++generation.current;lock.current=true;setBusy('删除资料包');setError('');setSaved('');
    try { await api.deleteBundle(id); if(mounted.current&&token===generation.current){setBundles(all=>all.filter(item=>item.id!==id));setBundle(undefined);currentId.current='';setRenamingBundle(false);setConfirmDelete(false);setSaved('资料包已删除');} }
    catch(e){if(mounted.current&&token===generation.current)setError(message(e));}
    finally{if(token===generation.current){lock.current=false;if(mounted.current)setBusy('');}}
  }
  const files = (bundle?.files ?? []).filter(file => file.logicalPath.toLocaleLowerCase().includes(fileFilter.toLocaleLowerCase()));
  const primary = bundle?.files.filter(file => file.role === 'primary' && file.status !== 'excluded') ?? [];
  const issues = bundle?.issues ?? [];
  return <div className={`page material-page ${dragging ? 'material-dragging' : ''}`}
    onDragEnter={event => { event.preventDefault(); if (api && !locked && event.dataTransfer.types.includes('Files')) { depth.current++; setDragging(true); } }}
    onDragLeave={() => { depth.current = Math.max(0, depth.current - 1); if (!depth.current) setDragging(false); }}
    onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = locked ? 'none' : 'copy'; }}
    onDrop={event => { event.preventDefault(); depth.current = 0; setDragging(false); const items = Array.from(event.dataTransfer.files); if (items.length) void add('files', items); }}>
    <button className="back" disabled={!!busy} onClick={onBack}>{mode.kind==='adjustment'?'返回任务详情':'返回任务中心'}</button>
    <div className={`material-page-heading ${bundle ? 'is-compact' : ''}`}><span>{mode.kind==='adjustment'?`第 ${mode.baseVersion} 版结果`:'新建任务'}</span><h1>{mode.kind==='adjustment'?`更新“${mode.projectName}”的分析资料`:'准备本次分析'}</h1><p>{mode.kind==='adjustment'?'更换主 PRD 或补充资料后，将完整重新分析并保留旧版本。':'选择定版 PRD，可补充资料和说明，平台会结合处理。'}</p>{!bundle&&mode.kind==='new'&&<ol className="material-steps"><li className="active"><b>1</b>选择主 PRD</li><li><b>2</b>补充资料与说明 <small>可选</small></li><li><b>3</b>开始分析</li></ol>}</div>
    {(busy || dragging || bundle || saved) && <div className="material-feedback" role="status" aria-live="polite"><span>{busy&&<RotateCw className="runtime-spinner"/>}{busy || (dragging ? `松开添加为${bundle ? roles[role] : '主 PRD'}` : saved || '文件与修改保存在本机，可离开后继续准备。')}</span>{busy==='添加并保存资料'&&bundle&&<button className="secondary" onClick={()=>void cancelAddition()}>取消添加</button>}</div>}
    {error && <div className="material-error" role="alert">{error}<button className="secondary" disabled={!!busy} onClick={() => bundle ? void select(bundle.id) : api && void api.list().then(setBundles).catch(e=>setError(message(e)))}>刷新资料</button></div>}
    {!api ? <div className="panel">资料导入需要在桌面应用中使用。</div> : <>
      {bundle&&bundles.length > 0&&mode.kind==='new' && <><div className="bundle-select-row"><label className="bundle-select">当前资料<select aria-label="已有资料包" disabled={!!busy} value={bundle.id} onChange={e => void select(e.target.value)}>{bundles.map(item => <option key={item.id} value={item.id}>{item.name || item.id} · {states[item.state]} · v{item.revision}</option>)}</select></label><div className="bundle-quick-actions"><button className="secondary" disabled={locked} aria-expanded={renamingBundle} onClick={()=>{setBundleName(bundle.name);setRenamingBundle(value=>!value);setConfirmDelete(false)}}>重命名</button><button className="secondary danger-text" disabled={locked} aria-expanded={confirmDelete} onClick={()=>{setConfirmDelete(value=>!value);setRenamingBundle(false)}}>删除资料包</button></div></div>{(renamingBundle||confirmDelete)&&<section className="bundle-manager" aria-label="资料包管理">{renamingBundle&&<><label>资料包名称<input aria-label="资料包名称" maxLength={100} disabled={locked} value={bundleName} onChange={e=>setBundleName(e.target.value)}/></label><button className="secondary" disabled={locked||!bundleName.trim()||bundleName.trim()===bundle.name} onClick={()=>void run('重命名资料包',()=>api.renameBundle(bundle.id,bundleName.trim()))}>保存名称</button><button className="text-action" disabled={locked} onClick={()=>setRenamingBundle(false)}>取消</button></>}{confirmDelete&&<div className="bundle-delete-confirm" role="alert"><span>将永久删除“{bundle.name}”及其中 {bundle.files.length} 个文件和索引；原始磁盘文件不受影响。</span><button className="secondary" disabled={locked} onClick={()=>setConfirmDelete(false)}>取消</button><button className="danger" disabled={locked} onClick={()=>void deleteBundle()}>确认删除资料包</button></div>}</section>}</>}
      {!bundle ? <div className="material-start-shell"><section className="material-intake-card"><div className="upload-mark"><FileText/></div><h2>选择定版 PRD</h2><p>支持 HTML、DOC、DOCX、PDF、Markdown 和 TXT</p><button className="primary" disabled={!!busy} onClick={() => void add('files', undefined, true)}><Upload/>选择文件</button><small>也可以将文件拖到此区域</small></section>{bundles.length>0&&<section className="material-resume"><div><strong>继续准备已有资料</strong><span>打开上次尚未开始分析的资料包。</span></div><select aria-label="已有资料包" disabled={!!busy} value="" onChange={e => void select(e.target.value)}><option value="">选择已有资料</option>{bundles.map(item => <option key={item.id} value={item.id}>{item.name || item.id} · {states[item.state]} · v{item.revision}</option>)}</select></section>}</div> : <>
        <section className="material-intake-card material-intake-selected"><div className="upload-mark"><FileText/></div><div className="material-primary-copy"><span>主 PRD</span><h2>{primary[0]?.logicalPath ?? '尚未选择主 PRD'}</h2><p>{primary.length ? `${(primary[0].size / 1024).toFixed(1)} KB · 已保存到本机` : '主 PRD 用于确定本次需求分析范围'}</p></div><div className="material-primary-actions"><span className={`material-state ${bundle.state}`}>{states[bundle.state]}</span><button className="secondary" disabled={locked} onClick={() => void add('files', undefined, true)}>{primary.length ? '更换' : '选择 PRD 文件'}</button></div></section>
        <section className="material-supplements"><header><div><h2>补充资料 <small>可选</small></h2><p>{bundle.files.filter(file=>file.role!=='primary').length?`已添加 ${bundle.files.filter(file=>file.role!=='primary').length} 项，可在资料明细中调整用途。`:'可以添加说明文档、原型、图片或整个资料目录。'}</p></div><div className="material-actions"><label>资料用途<select disabled={locked} value={role} onChange={e => setRole(e.target.value as MaterialRole)}><option value="supplement">补充资料</option><option value="historical">历史参考</option></select></label><button className="secondary" disabled={locked} onClick={() => void add('files')}><Plus/>添加文件</button><button className="secondary" disabled={locked} onClick={() => void add('directory')}><FolderOpen/>添加目录</button></div></header><details className="material-directory-options"><summary>目录选项</summary><label className="mount-label">资料包内目录名称<input disabled={locked} value={mount} onChange={e => setMount(e.target.value)} placeholder="留空时使用所选目录名"/></label><p>最多 1000 个文件，单文件 100 MiB，总计 500 MiB。</p></details></section>
        <section className="material-analysis-note" aria-labelledby="material-note-title"><header><div><h2 id="material-note-title">补充说明与调整 <small>选填</small></h2><p>可以一次描述多个功能的背景、补充、范围调整、细化要求或澄清结论。</p></div><span className={`draft-state ${draftState}`} role="status">{draftState==='saving'?'正在保存':draftState==='saved'?`已保存到本机${bundle.analysisDraft?.updatedAt?` · ${new Date(bundle.analysisDraft.updatedAt).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}`:''}`:draftState==='error'?'保存失败':'尚未填写'}</span></header><label htmlFor="material-analysis-text" className="sr-only">本次分析的补充说明与调整</label><textarea id="material-analysis-text" className="resize-none" rows={6} maxLength={20000} disabled={locked} value={analysisText} onChange={event=>{setAnalysisText(event.target.value);setDraftState('saving');if(error.startsWith('说明保存失败'))setError('')}} placeholder={'例如：\n本期只做查询和合并提醒，自动合并暂不做。\n同名判断以活动名称去除首尾空格后完全一致为准。\n查询部分细化到字段和交互，历史原型只参考布局。'}/><footer><small>{analysisText.length.toLocaleString('zh-CN')} / 20,000 字 · 选择或更换文件不会清空说明</small></footer></section>
        <section className="material-start-action"><div><strong>{bundle.state==='indexing'?bundle.progress.phase||'正在读取资料':issues.length?`${issues.length} 项资料问题需要处理`:mode.kind==='adjustment'?`将生成第 ${mode.baseVersion+1} 版结果，旧版本保持不变`:'文件和说明会在本次任务中一起处理'}</strong><p>{bundle.state==='indexing'?`已处理 ${bundle.progress.completed} / ${bundle.progress.total} 个文件。`:mode.kind==='adjustment'?'新资料会从原文建账开始完整重新分析，不复用旧检查点。':'开始后平台会自动读取资料、建立索引并分析需求。'}</p>{bundle.state==='indexing'&&<progress aria-label="资料读取进度" value={bundle.progress.completed} max={Math.max(1,bundle.progress.total)}/>}</div><button className="primary" disabled={locked||primary.length!==1||draftState==='error'} aria-busy={busy==='正在准备并开始分析'} onClick={()=>void start()}>{busy==='正在准备并开始分析'?'正在开始':mode.kind==='adjustment'?`开始第 ${mode.baseVersion+1} 版分析`:'开始分析'}</button></section>
        {bundle.error && <p className="material-error" role="alert">{bundle.error}</p>}
        <button type="button" className="material-details-toggle" aria-expanded={detailsOpen} onClick={()=>setDetailsOpen(value=>!value)}>资料明细与读取记录 <span>{bundle.files.length} 个文件</span></button>
        {detailsOpen&&<div className="material-details-body">{issues.length > 0 && <section className="material-issues" aria-label="资料问题摘要"><strong>有 {issues.length} 个已上传文件需要处理</strong>{(issuesExpanded ? issues : issues.slice(0, 2)).map(issue => <p key={issue.id}>{issue.fileId && <strong>{bundle.files.find(file=>file.id===issue.fileId)?.logicalPath} · </strong>}{issue.message}</p>)}{issues.length > 2 && <button className="secondary" aria-expanded={issuesExpanded} onClick={() => setIssuesExpanded(value => !value)}>{issuesExpanded ? '收起问题' : `查看其余 ${issues.length - 2} 项`}</button>}</section>}
        <nav className="result-tabs" aria-label="资料视图">{([['files','文件清单'],['sources','内容索引']] as const).map(([value,label])=><button key={value} className={tab===value?'active':''} onClick={()=>{setTab(value);setSource(undefined)}}>{label}</button>)}</nav>
        {tab==='files'&&<section className="collection"><label className="search"><Search/><input aria-label="搜索文件路径" value={fileFilter} onChange={e=>{setFileFilter(e.target.value);setFilePage(0)}} placeholder="搜索文件路径"/></label>{!files.length&&<p className="material-hint">{bundle.files.length?'没有匹配文件，请调整搜索词。':'尚未添加资料。先选择主 PRD，再添加补充文件或目录。'}</p>}{files.slice(filePage*20,(filePage+1)*20).map(file=><div className="material-file" key={file.id}><div className="material-file-line"><div><strong>{file.logicalPath}</strong><small>{roles[file.role]} · {fileStates[file.status]} · {(file.size/1024).toFixed(1)} KB{file.sourceCount!==undefined&&` · ${file.sourceCount} 个内容单元`}</small>{(file.reason||file.exclusionReason)&&<p>{file.exclusionReason||file.reason}</p>}</div><button className="secondary" disabled={locked} onClick={()=>setEditing(editing===file.id?undefined:file.id)}>{editing===file.id?'收起':'调整资料'}</button></div>{editing===file.id&&<FileEditor key={`${file.id}-${file.revision}-${file.status}`} file={file} disabled={locked} save={patch=>run('保存资料设置',()=>api.updateFile(bundle.id,file.id,patch))} remove={()=>run('移除资料',()=>api.removeFile(bundle.id,file.id))}/>}</div>)}<Pager offset={filePage*20} limit={20} total={files.length} onChange={value=>setFilePage(value/20)}/></section>}
      {tab==='sources'&&<section className="collection"><div className="material-search"><label className="search"><Search/><input aria-label="搜索原文内容" value={query} onChange={e=>{setQuery(e.target.value);setOffset(0)}} placeholder="搜索原文内容"/></label><select aria-label="来源文件" value={queryFile} onChange={e=>{setQueryFile(e.target.value);setOffset(0)}}><option value="">全部文件</option>{bundle.files.map(file=><option key={file.id} value={file.id}>{file.logicalPath}</option>)}</select></div>{bundle.indexedRevision!==bundle.revision?<p className="material-hint">资料会在开始分析时自动读取。</p>:<><p className="material-hint" role="status">{searching?'正在查阅索引':`共 ${result?.total??0} 条，每页最多 25 条；关键词检索不能替代来源完整性检查。`}</p>{!searching&&result?.total===0&&<p className="material-hint">没有匹配内容，可清空搜索词或切换文件。</p>}{result?.items.map(unit=><button disabled={searching} className="material-source" key={unit.id} onClick={()=>void preview(unit)}><strong>{sourceHeading(unit)}</strong><small>{sourcePosition(unit)}</small><p>{unit.excerpt.slice(0,240)}</p></button>)}<Pager offset={offset} limit={25} total={result?.total??0} disabled={searching} onChange={setOffset}/></>}</section>}</div>}
      </>}
    </>}
    {source&&<aside className="drawer material-preview" aria-label="来源原文"><header><div><h2>{sourceHeading(source)}</h2><small>{sourcePosition(source)}</small></div><button aria-label="关闭来源预览" onClick={()=>setSource(undefined)}><X/></button></header><div>{readableContext(source.context)&&<p>{readableContext(source.context)}</p>}<pre>{source.asset?.extractedText??source.excerpt}</pre></div></aside>}
  </div>;
}
function Pager({offset,limit,total,disabled,onChange}:{offset:number;limit:number;total:number;disabled?:boolean;onChange:(offset:number)=>void}) { return <footer className="pagination"><button disabled={disabled||offset===0} onClick={()=>onChange(Math.max(0,offset-limit))}>上一页</button><span>{total?offset+1:0}–{Math.min(offset+limit,total)} / {total}</span><button disabled={disabled||offset+limit>=total} onClick={()=>onChange(offset+limit)}>下一页</button></footer>; }
function FileEditor({file,disabled,save,remove}:{file:MaterialFile;disabled:boolean;save:(patch:{role?:MaterialRole;logicalPath?:string;exclusionReason?:string})=>Promise<void>;remove:()=>Promise<void>}) {
  const [role,setRole]=useState(file.role),[path,setPath]=useState(file.logicalPath),[reason,setReason]=useState(file.exclusionReason??''),[removing,setRemoving]=useState(false);
  return <div className="material-editor"><label>资料角色<select disabled={disabled} value={role} onChange={e=>setRole(e.target.value as MaterialRole)}>{Object.entries(roles).map(([value,label])=><option value={value} key={value}>{label}</option>)}</select></label><label>资料包内路径<input disabled={disabled} value={path} onChange={e=>setPath(e.target.value)}/></label><button className="secondary" disabled={disabled||!path.trim()} onClick={()=>void save({role,logicalPath:path.trim()})}>保存设置</button><label className="material-reason">排除理由<input disabled={disabled} value={reason} onChange={e=>setReason(e.target.value)} placeholder="说明为何无需用于需求分析"/></label><button className="secondary" disabled={disabled||!reason.trim()} onClick={()=>void save({exclusionReason:reason.trim()})}>排除资料</button>{file.status==='excluded'&&<button className="secondary" disabled={disabled} onClick={()=>void save({exclusionReason:''})}>恢复资料</button>}<button className="text-action" disabled={disabled} onClick={()=>setRemoving(!removing)}>移除资料</button>{removing&&<div className="material-remove"><span>将从资料包移除 {file.logicalPath}，原始文件不变；需要时可重新添加。</span><button className="secondary" disabled={disabled} onClick={()=>void remove()}>确认移除</button></div>}</div>;
}
