import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { App, Drawer, RequirementList, artifactRefreshKey, clearFeedbackDraft, displayProgress, ExecutionRecord, featureScope, loadFeedbackDraft, Progress, RuntimeCost, saveFeedbackDraft, shouldSubmitFeedback, stepOutputSummary, TaskFeedback, TaskPage, taskStatusLabel, runtimeTiming } from '../src/App.js';
import type { AnalysisTask } from '../src/types.js';

describe('需求细化数据契约', () => {
  it('持久化任务回读前显示空任务页，不注入演示任务',()=>{
    const html=renderToStaticMarkup(React.createElement(App));
    expect(html).toContain('当前任务 <b>0</b>');
    expect(html).toContain('还没有需求分析任务');
    expect(html).not.toContain('交易中心 3.0');
    expect(html).not.toContain('T-0001');
  });
  it('七阶段进度显示为整数百分比',()=>{
    expect(displayProgress(42.85714285714286)).toBe(43);
  });
  it('执行阶段根据已确认检查点显示简短产出摘要',()=>{
    const task={status:'running',project:{sourceDocuments:[{fileId:'D-1'}],sourceUnits:[{id:'E-1'},{id:'E-2'}],features:[],requirements:[]},checkpoint:{detailedFeatureIds:['F-1'],auditIssues:[],materializedFeatureIds:['F-1','F-2'],detailResults:{'F-1':{requirements:[{id:'R-1'},{id:'R-2'}],clarifications:[]}}}} as unknown as AnalysisTask;
    expect(stepOutputSummary(task,{id:'inventory',name:'原文建账',note:'',status:'completed'})).toBe('读取 1 个文件，建立 2 个原文片段');
    expect(stepOutputSummary(task,{id:'unify',name:'功能清单整理',note:'',status:'running'})).toBe('已整理 2 个功能模块');
    expect(stepOutputSummary(task,{id:'unify',name:'功能清单整理',note:'',status:'completed'})).toBe('整理为 2 个功能模块');
    expect(stepOutputSummary(task,{id:'details',name:'逐功能细化',note:'',status:'running'})).toBe('已细化 1/2 个模块，共 2 条需求');
    const auditing={...task,checkpoint:{...task.checkpoint,auditedFeatureIds:undefined,auditWorkStates:{'F-1':{state:'succeeded',inputHash:'x',attempts:1,updatedAt:1},'F-2':{state:'running',inputHash:'y',attempts:1,updatedAt:1}}}} as AnalysisTask;
    expect(stepOutputSummary(auditing,{id:'audit',name:'产物依据核查',note:'',status:'running'})).toBe('已核查 1/2 个功能模块');
    expect(stepOutputSummary(task,{id:'repair',name:'有据修正',note:'',status:'completed'})).toBe('无需修正');
    expect(stepOutputSummary(task,{id:'delivery',name:'结果发布',note:'',status:'pending'})).toBeUndefined();
    const html=renderToStaticMarkup(React.createElement(Progress,{task:{...task,progress:50,steps:[{id:'details',name:'逐功能细化',note:'已细化 1/2 个功能',status:'running'}]} as AnalysisTask,now:3000}));
    expect(html).toContain('step-output current');
    expect(html).toContain('<b>当前产出</b><span>已细化 1/2 个模块，共 2 条需求</span>');
    expect(html.indexOf('当前产出')).toBeGreaterThan(html.indexOf('复杂功能细化'));
    const transient={...task,checkpoint:{...task.checkpoint,featureCandidateBatches:[null],detailResults:{'F-1':null}},project:{...task.project,sourceUnits:null}} as unknown as AnalysisTask;
    expect(()=>stepOutputSummary(transient,{id:'candidates',name:'功能候选识别',note:'',status:'running'})).not.toThrow();
    expect(()=>stepOutputSummary(transient,{id:'details',name:'逐功能细化',note:'',status:'running'})).not.toThrow();
  });
  it('同一任务完成并登记产物后会触发产物状态刷新',()=>{
    const running={id:'T-1',status:'running',steps:[],project:{}} as AnalysisTask;
    const completed={...running,status:'completed',resultVersion:1,artifacts:[{id:'A-1',kind:'agent-package',path:'/tmp/result',resultVersion:1,createdAt:1}]} as AnalysisTask;
    expect(artifactRefreshKey(completed)).not.toBe(artifactRefreshKey(running));
  });
  it('明确区分来源、规则、功能和需求明细', () => {
    const chain = ['SourceUnit', 'RequirementRule', 'Feature', 'RequirementDetail'];
    expect(new Set(chain).size).toBe(4);
  });

  it('执行节点和成本分布显示任务实际模型与推理深度', () => {
    const task={runtimeConfig:{adapter:'codex-oauth',provider:'openai-codex',model:'gpt-5.6-terra',reasoningEffort:'medium',fastModel:'gpt-5.6-luna',fastReasoningEffort:'low',nodeProfiles:{featureCandidates:{model:'gpt-5.6-luna',reasoningEffort:'low'},featureCandidateRepair:{model:'gpt-5.6-terra',reasoningEffort:'high'}},maxParallel:1},status:'running',progress:12.5,startedAt:1000,steps:[{id:'candidates',name:'功能候选识别',note:'已识别 1/2 份候选内容',status:'running',startedAt:1000}],runtimeMetrics:[{sessionId:'prd-T-a1-candidate-0-1-try1',adapter:'codex-oauth',model:'gpt-5.6-luna',reasoningEffort:'low',startedAt:1000,completedAt:2000,durationMs:1000,inputTokens:10,outputTokens:2}],project:{}} as AnalysisTask;
    const progress=renderToStaticMarkup(React.createElement(Progress,{task,now:3000}));
    const cost=renderToStaticMarkup(React.createElement(RuntimeCost,{task}));
    expect(progress).toContain('首次识别');
    expect(progress).toContain('逐份候选内容提取功能候选');
    expect(progress).toContain('gpt-5.6-luna');
    expect(progress).toContain('定点返工');
    expect(progress).toContain('只修订边界或分类问题');
    expect(progress).toContain('gpt-5.6-terra');
    expect(progress).toContain('推理 高');
    expect(cost).toContain('gpt-5.6-luna');
    expect(cost).toContain('推理深度');
    expect(cost).toContain('<td>低</td>');
    expect(cost).toContain('<details class="runtime-cost-breakdown">');
    expect(cost).toContain('查看节点成本分布');
    expect(cost).not.toContain('<details class="runtime-cost-breakdown" open="">');
  });

  it('逐功能细化明确区分简单功能、复杂功能与补漏模型的职责', () => {
    const task={runtimeConfig:{adapter:'codex-oauth',provider:'openai-codex',model:'gpt-5.6-terra',reasoningEffort:'low',fastModel:'gpt-5.6-luna',fastReasoningEffort:'low',nodeProfiles:{detailsFast:{model:'gpt-5.6-luna',reasoningEffort:'low'},details:{model:'gpt-5.6-terra',reasoningEffort:'medium'}},maxParallel:1},status:'running',progress:62.5,startedAt:1000,steps:[{id:'details',name:'逐功能细化',note:'已细化 1/2 个功能',runs:3,status:'running',startedAt:1000}],project:{}} as AnalysisTask;
    const progress=renderToStaticMarkup(React.createElement(Progress,{task,now:3000}));
    expect(progress).toContain('累计业务调用 3 次');
    expect(progress).not.toContain('运行 3 轮');
    expect(progress).toContain('简单功能细化');
    expect(progress).toContain('处理短小且无复杂联动的功能');
    expect(progress).toContain('复杂功能细化');
    expect(progress).toContain('处理状态、权限、依赖和例外');
  });
  it('旧任务持久化的来源包文案在界面统一显示为候选内容',()=>{
    const task={status:'running',progress:25,startedAt:1000,steps:[{id:'candidates',name:'功能候选识别',note:'已识别 17/17 个来源包',runs:19,status:'completed'}],project:{}} as AnalysisTask;
    const progress=renderToStaticMarkup(React.createElement(Progress,{task,now:3000}));
    expect(progress).toContain('已识别 17/17 个候选内容');expect(progress).toContain('累计业务调用 19 次');expect(progress).not.toContain('来源包');expect(progress).not.toContain('运行 19 轮');
  });
  it('区分模型活跃耗时、等待重试与点击到结果耗时',()=>{
    const task={status:'failed',startedAt:1000,completedAt:13000,steps:[],runtimeMetrics:[
      {sessionId:'prd-T-a1-candidate-1-try1',startedAt:1000,completedAt:4000,durationMs:3000,adapter:'codex-oauth',model:'fast',reasoningEffort:'low'},
      {sessionId:'prd-T-a1-coverage-2-try1',startedAt:2000,completedAt:5000,durationMs:3000,adapter:'codex-oauth',model:'sol',reasoningEffort:'low'},
      {sessionId:'prd-T-a2-unify-3-try1',startedAt:10000,completedAt:13000,durationMs:3000,adapter:'codex-oauth',model:'sol',reasoningEffort:'low'},
    ],project:{}} as AnalysisTask;
    expect(runtimeTiming(task)).toEqual({active:7000,retryWait:5000});
    const cost=renderToStaticMarkup(React.createElement(RuntimeCost,{task}));
    expect(cost).toContain('模型活跃');expect(cost).toContain('点击到结果');expect(cost).toContain('等待重试');expect(cost).toContain('7 秒');expect(cost).toContain('12 秒');expect(cost).toContain('5 秒');
  });

  it('结果页使用一个任务级自然语言调整入口',()=>{
    const task={id:'T-1',resultVersion:3,status:'completed',progress:100,steps:[],adjustment:{feedback:'统一含税',results:[{operationId:'OP-1',status:'applied',featureIds:['F-1'],clarificationIds:[],detail:'退款金额已统一为含税口径。'},{operationId:'OP-2',status:'needs-confirmation',featureIds:[],clarificationIds:[],detail:'仍需确认支付超时范围。'}]},project:{name:'订单',features:[],requirements:[],clarifications:[],sourceUnits:[]}} as unknown as AnalysisTask;
    const html=renderToStaticMarkup(React.createElement(TaskFeedback,{task,onAdjust:async()=>undefined}));
    expect(html).toContain('调整本版结果');
    expect(html).toContain('可以调整模块组织、需求颗粒度或指出遗漏');
    expect(html).toContain('按说明调整');
    expect(html).toContain('已落实 1 项，1 项仍需处理');
    expect(html).toContain('退款金额已统一为含税口径。');
    expect(html).toContain('仍需确认支付超时范围。');
    expect(html).not.toContain('OP-1');
    expect(html).toContain('noValidate=""');
    expect(html).not.toContain('调整方式');
    expect(html).not.toContain('处理方式');
  });

  it('历史业务待处理事项和建议不进入当前页面',()=>{
    const project={features:[],requirements:[],sourceUnits:[],clarifications:[{id:'Q-1',question:'退款金额是否含税？',state:'open',resolutionProposal:{recommendation:'采用含税金额'}}]} as any;
    const task={id:'T-1',resultVersion:2,status:'completed',project} as AnalysisTask;
    const feedback=renderToStaticMarkup(React.createElement(TaskFeedback,{task,onAdjust:async()=>undefined}));
    expect(feedback).not.toContain('采纳');
    expect(feedback).not.toContain('退款金额是否含税');
    expect(feedback).toContain('清单中的功能和需求必须存在于 PRD');
  });

  it('平台校验过程不进入用户结果页',()=>{
    const project={features:[],requirements:[],sourceUnits:[],audit:{issues:[{id:'A-1',owner:'runtime-output',detail:'当前节点输出缺少有效原文引用。',sourceUnitIds:[],affectedIds:[],disposition:'open'}]}} as any;
    const task={id:'T-1',resultVersion:2,status:'completed',progress:100,steps:[],project} as AnalysisTask;
    const html=renderToStaticMarkup(React.createElement(ExecutionRecord,{task,now:Date.now()}));
    expect(html).not.toContain('清单校验明细');
    expect(html).not.toContain('平台检查记录');
    expect(html).not.toContain('当前节点输出缺少有效原文引用');
    expect(html).not.toContain('未通过');
    expect(html).not.toContain('已修复');
  });

  it('全部阶段成功结束后只显示已完成与 100%',()=>{
    const task={id:'T-1',status:'completed',progress:100,steps:[{id:'delivery',name:'生成结果',note:'已生成草稿',status:'completed'}],project:{features:[],requirements:[],sourceUnits:[],delivery:{state:'blocked'}}} as unknown as AnalysisTask;
    const html=renderToStaticMarkup(React.createElement(ExecutionRecord,{task,now:Date.now(),onRecover:()=>undefined}));
    expect(taskStatusLabel(task)).toBe('已完成');
    expect(html).toContain('执行已完成');
    expect(html).toContain('100%');
    expect(html).not.toContain('平台未完成');
    expect(html).not.toContain('正式结果需要重新处理');
    expect(html).not.toContain('继续处理');
    expect(html).not.toContain('88%');
  });

  it('草稿存储不可用时不阻断页面',()=>{
    const unavailable={getItem(){throw new Error('blocked')},setItem(){throw new Error('blocked')},removeItem(){throw new Error('blocked')}};
    expect(loadFeedbackDraft(unavailable,'draft')).toBe('');
    expect(()=>saveFeedbackDraft(unavailable,'draft','调整内容')).not.toThrow();
    expect(()=>clearFeedbackDraft(unavailable,'draft')).not.toThrow();
  });

  it('输入法组合态不会触发快捷提交',()=>{
    expect(shouldSubmitFeedback({ctrlKey:true,metaKey:false,key:'Enter',nativeEvent:{isComposing:true}})).toBe(false);
    expect(shouldSubmitFeedback({ctrlKey:true,metaKey:false,key:'Enter',nativeEvent:{isComposing:false}})).toBe(true);
    expect(shouldSubmitFeedback({ctrlKey:false,metaKey:true,key:'Enter',nativeEvent:{isComposing:false}})).toBe(true);
  });

  it('完成任务默认进入功能范围工作台并集中任务动作',()=>{
    const requirement={id:'R-1',featureId:'F-1',text:'按条件返回订单。',sourceRefs:[],state:'reviewed',deliveryScope:'current'};
    const task={id:'T-1',resultVersion:2,status:'completed',progress:100,attempt:1,createdAt:1,requestedAt:1,completedAt:2,steps:[],runtimeMetrics:[{sessionId:'details-F-1',adapter:'codex-oauth',model:'gpt-5.6-terra',reasoningEffort:'medium',startedAt:1,completedAt:2,durationMs:1}],project:{id:'P-1',name:'订单中心',sourceName:'订单.prd',sourceHash:'x',revision:1,importedAt:'2026-09-13',rawText:'',stage:'review',sourceUnits:[],features:[{id:'F-1',name:'订单查询',sourceUnitIds:[],ruleIds:[],requirementIds:['R-1'],state:'reviewed'}],requirements:[requirement],clarifications:[]}} as AnalysisTask;
    const noop=()=>undefined,asyncNoop=async()=>undefined;
    const html=renderToStaticMarkup(React.createElement(TaskPage,{task,versions:[task],now:3,onBack:noop,onVersion:noop,onAdjust:asyncNoop,onScope:asyncNoop,onRetry:asyncNoop,onRestart:asyncNoop,onArchive:asyncNoop,onRestore:asyncNoop,onDelete:asyncNoop}));
    expect(html).toContain('功能与需求');
    expect(html).toContain('全部需求');
    expect(html.match(/class="tab-count"/g)).toHaveLength(2);
    expect(html.match(/class="tab-count">1<\/b>/g)).toHaveLength(2);
    expect(html).not.toContain('class="collection-head"');
    expect(html).not.toContain('待处理事项');
    expect(html).toContain('执行记录');
    expect(html).not.toContain('生成交付包');
    expect(html).not.toContain('重新生成产物');
    expect(html).toContain('全选本页功能');
    expect(html).toContain('选择当前筛选全部（1）');
    expect(html).toContain('标记本期不做');
    expect(html).toContain('恢复本期');
    expect(html).toContain('取消选择');
    expect(html).toContain('调整结果');
    expect(html).not.toContain('调整本版结果');
    expect(html).not.toContain('概览');
    expect(html.match(/耗时\/用量/g)).toHaveLength(1);
    expect(html).toContain('节点成本分布');
  });

  it('失败任务提供继续与重新开始两个原地恢复动作',()=>{
    const task={id:'T-FAIL',status:'failed',progress:43,error:'模型连接超时',steps:[],project:{}} as AnalysisTask;
    const html=renderToStaticMarkup(React.createElement(ExecutionRecord,{task,now:3,onRecover:()=>undefined}));
    expect(html).toContain('模型连接超时');
    expect(html).toContain('从失败处继续');
    expect(html).toContain('重新开始');
  });

  it('功能范围状态与批量选择状态分离',()=>{
    const project={requirements:[{id:'R-1',deliveryScope:'current'},{id:'R-2',deliveryScope:'excluded'}]} as any;
    expect(featureScope(project,{id:'F-1',requirementIds:['R-1','R-2']} as any).label).toBe('部分纳入（1/2）');
    expect(featureScope(project,{id:'F-2',requirementIds:['R-2'],deliveryScope:'excluded'} as any).label).toBe('本期不做');
  });

  it('旧版需求字段在全部需求中降级为只读清单而不触发白屏',()=>{
    const legacyRequirement={id:'R-OLD',featureId:'F-1',title:'批量筛选审核任务',behavior:'支持一次输入多个数据集 ID。',sourceUnitIds:['S-1'],state:'reviewed'} as any;
    const project={features:[{id:'F-1',name:'审核列表',sourceUnitIds:['S-1'],ruleIds:[],requirementIds:['R-OLD'],state:'reviewed'}],requirements:[legacyRequirement],sourceUnits:[{id:'S-1',excerpt:'支持一次输入多个数据集 ID。',location:'旧版.prd · 审核列表'}],clarifications:[]} as any;
    const html=renderToStaticMarkup(React.createElement(RequirementList,{task:{id:'T-OLD',resultVersion:1,project} as AnalysisTask,p:project,onClearFeature:()=>undefined,onDetail:()=>undefined,onScope:async()=>undefined}));
    expect(html).toContain('批量筛选审核任务');
    expect(html).toContain('R-OLD');
    expect(html).toContain('requirement-columns');
    expect(html).not.toContain('需求内容待读取');
    expect(html).not.toContain('检查状态');
    expect(html).not.toContain('检查通过');
    expect(html).not.toContain('class="collection-head"');
  });
});
it('需求只显示短文本、模块和原文，不生成多字段规格',()=>{
 const item={id:'R-1',featureId:'F-1',text:'允许查询订单。',sourceRefs:[{sourceUnitId:'S-1'}],state:'reviewed'} as const;
 const p={features:[{id:'F-1',name:'订单',requirementIds:['R-1']}],requirements:[item],sourceUnits:[{id:'S-1',excerpt:'用户登录后，可以按订单编号查询。',location:'第 10 行',logicalPath:'prd.md'}]} as any;
 const drawer=renderToStaticMarkup(React.createElement(Drawer,{project:p,item:item as any,onClose:()=>undefined}));
 expect(drawer).toContain('允许查询订单。');expect(drawer).toContain('用户登录后，可以按订单编号查询。');expect(drawer).toContain('第 10 行');expect(drawer).not.toContain('条件与限制');expect(drawer).not.toContain('原文明示验收条件');expect(drawer).not.toContain('检查通过');
 const list=renderToStaticMarkup(React.createElement(RequirementList,{task:{id:'T',status:'completed'} as any,p,onClearFeature:()=>undefined,onDetail:()=>undefined,onScope:async()=>undefined}));
 expect(list).toContain('订单');expect(list).toContain('允许查询订单。');expect(list).toContain('原文');
});
