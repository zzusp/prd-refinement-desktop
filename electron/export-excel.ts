import ExcelJS from 'exceljs';
import type { PrdProject, SourceRef } from '../src/types.js';
import { featureTitle, sourcePosition } from '../src/result-presentation.js';

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
export async function writeResultWorkbook(project:PrdProject,filePath:string){
 const wb=new ExcelJS.Workbook();wb.creator='需求细化平台';
 const checklist=sheet(wb,'需求清单',checklistColumns,[16,36,18,65,75,18,55]);
 for(const item of checklistRows(project)){const row=checklist.addRow(checklistColumns.map(key=>item[key]));row.getCell(6).dataValidation={type:'list',allowBlank:false,formulae:['"unchecked,checked,pending"']};}
 const readme=sheet(wb,'阅读说明',['项目','内容'],[25,100]);readme.addRows([['阅读顺序','先完整阅读 sources/files/ 内冻结的原始 PRD 及补充资料，再用需求清单逐项查漏。短清单不能替代 PRD。'],['核对状态','unchecked 未核对；checked 已结合原文核对；pending 待处理。状态由使用清单的人或 Agent 填写，不代表平台已完成业务代码验收。'],['质量边界','清单仅包含原文支持的功能模块和需求，保留原文明示的条件、限制与例外语义。清单用于减少遗漏，不证明自然语言语义 100% 零遗漏。']]);
 for(const ws of wb.worksheets){ws.eachRow((row,index)=>{if(index>1){row.eachCell(cell=>{cell.font={name:'Microsoft YaHei',size:11}});if(index%2===0)row.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFF3F6F8'}}}});ws.pageSetup={orientation:'landscape',fitToPage:true,fitToWidth:1,fitToHeight:0};}
 await wb.xlsx.writeFile(filePath);return filePath;
}
