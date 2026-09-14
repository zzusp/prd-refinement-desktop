import ExcelJS from 'exceljs';
import type { AnalysisTask, PrdProject, SourceRef } from '../src/types.js';
import { activePlatformIssues, affectedLabels, clarificationLevel, clarificationLevelLabel, featureTitle, sourcePosition } from '../src/result-presentation.js';

export const checklistColumns=['feature_id','feature_source','requirement_id','requirement','source_location','check_status','notes'] as const;
export type ChecklistRow=Record<typeof checklistColumns[number],string>;
export function sourceLocation(project:PrdProject,refs:SourceRef[]):string {
 return refs.map(ref=>{const unit=project.sourceUnits.find(item=>item.id===ref.sourceUnitId);if(!unit)throw new Error(`来源不存在：${ref.sourceUnitId}`);
 const logical=unit.logicalPath??project.sourceName;
 if(!logical||logical.startsWith('/')||logical.includes('\\')||logical.split('/').some(part=>!part||part==='.'||part==='..')||logical.includes(':'))throw new Error('来源文件路径不安全');
 return `sources/files/${logical} · ${sourcePosition(unit)}${ref.start===undefined?'':` · 字符 ${ref.start}–${ref.end}`}`;
 }).join('\n');
}
export function checklistRows(project:PrdProject):ChecklistRow[] {
 const ids=new Set<string>();
 return project.requirements.map(requirement=>{
 if(ids.has(requirement.id))throw new Error(`重复需求编号：${requirement.id}`);ids.add(requirement.id);
 const owner=project.features.find(feature=>feature.id===requirement.featureId&&feature.requirementIds.includes(requirement.id));
 if(!owner)throw new Error(`需求缺少功能归属：${requirement.id}`);
 if(!requirement.sourceRefs.length)throw new Error(`需求缺少原文：${requirement.id}`);
 return {feature_id:owner.id,feature_source:featureTitle(project,owner),requirement_id:requirement.id,requirement:requirement.text,source_location:sourceLocation(project,requirement.sourceRefs),check_status:'unchecked',notes:''};
 });
}
function sheet(wb:ExcelJS.Workbook,name:string,headers:readonly string[],widths:number[]){
 const ws=wb.addWorksheet(name,{views:[{state:'frozen',ySplit:1}]});ws.addRow([...headers]);
 ws.columns.forEach((column,index)=>{column.width=widths[index]??32;column.alignment={vertical:'top',wrapText:true}});
 ws.getRow(1).font={bold:true,color:{argb:'FFFFFFFF'}};ws.getRow(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF17324A'}};ws.getRow(1).height=28;
 ws.autoFilter={from:{row:1,column:1},to:{row:1,column:headers.length}};return ws;
}
export interface WorkbookDeliveryScope { resultVersion?:number; selectedFeatureIds:string[]; executableFeatureIds:string[]; blockedFeatureIds:string[] }
export async function writeResultWorkbook(project:PrdProject,filePath:string,_checkpoint?:AnalysisTask['checkpoint'],_deliveryScope?:WorkbookDeliveryScope){
 const wb=new ExcelJS.Workbook();wb.creator='需求细化平台';
 const checklist=sheet(wb,'需求清单',checklistColumns,[16,36,18,65,75,18,55]);
 for(const item of checklistRows(project)){const row=checklist.addRow(checklistColumns.map(key=>item[key]));row.getCell(6).dataValidation={type:'list',allowBlank:false,formulae:['"unchecked,checked,pending"']};}
 const pending=sheet(wb,'待处理事项',['事项编号','级别','问题','已知事实','未决点','影响','分级理由','暂不处理口径','建议方案（非 PRD 事实）','建议依据','采纳影响','需要确认','备选','关联内容','原文位置','处理状态','用户决定'],[16,14,55,50,50,50,40,40,60,50,50,45,45,45,75,24,60]);
 for(const item of project.clarifications){const proposal=item.resolutionProposal;pending.addRow([item.id,clarificationLevelLabel[clarificationLevel(item)],item.question,item.knownFacts??'',item.unresolvedPoint??item.reason,item.impact??item.reason,item.levelReason??'',item.defaultResolution??'',proposal?.recommendation??'',proposal?.rationale??'',proposal?.impact??'',proposal?.confirmation??'',proposal?.alternatives.join('\n')??'',affectedLabels(project,item.affectedIds).join('\n'),sourceLocation(project,item.sourceRefs??[]),item.userDecision?'已确认，待同步 PRD':item.state,item.userDecision?.text??''])}
 for(const issue of activePlatformIssues(project))pending.addRow([issue.id,'平台处理',issue.detail,'','','平台仍需处理该问题','','','','','','','',affectedLabels(project,issue.affectedIds).join('\n'),sourceLocation(project,issue.sourceUnitIds.map(sourceUnitId=>({sourceUnitId}))),issue.disposition??'open','']);
 const readme=sheet(wb,'阅读说明',['项目','内容'],[25,100]);readme.addRows([['阅读顺序','先完整阅读 sources/files/ 内冻结的原始 PRD 及补充资料，再用需求清单逐项查漏。短清单不能替代 PRD。'],['核对状态','unchecked 未核对；checked 已结合原文核对；pending 待处理。状态不代表平台已完成业务代码验收。'],['待处理事项','建议、用户决定与 PRD 事实分开保存。新业务规则应先同步 PRD，再创建新版本分析。'],['质量边界','清单用于减少遗漏，不证明自然语言语义 100% 零遗漏。']]);
 for(const ws of wb.worksheets){ws.eachRow((row,index)=>{if(index>1){row.eachCell(cell=>{cell.font={name:'Microsoft YaHei',size:11}});if(index%2===0)row.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFF3F6F8'}}}});ws.pageSetup={orientation:'landscape',fitToPage:true,fitToWidth:1,fitToHeight:0};}
 await wb.xlsx.writeFile(filePath);return filePath;
}
