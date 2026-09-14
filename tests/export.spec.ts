import ExcelJS from 'exceljs';
import { afterAll, expect, it } from 'vitest';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { checklistColumns, writeResultWorkbook } from '../electron/export-excel';
import type { PrdProject } from '../src/types';
const root=path.resolve('docs/tmp/test-run/vitest/export');afterAll(()=>rm(root,{recursive:true,force:true}));
it('Excel 保留七列需求清单与完整待处理事项、建议和已确认待同步状态',async()=>{
 await mkdir(root,{recursive:true});
 const sourceUnits=['primary','supplement'].map((role,i)=>({id:`S-${i}`,fileId:`FILE-${i}`,fileRevision:i+2,logicalPath:`${i===0?'主需求':'补充'}/需求.md`,sourceRole:role as 'primary'|'supplement',label:'同名标题',kind:'paragraph' as const,excerpt:`原文${i}`,location:'第 10 行',status:'processed' as const}));
 const project:PrdProject={id:'P',name:'资料包',sourceName:'需求.md',sourceHash:'x',revision:1,importedAt:'',rawText:'',stage:'review',sourceUnits,features:[{id:'F-1',name:'查询',sourceUnitIds:['S-0'],ruleIds:[],requirementIds:['R-1'],state:'reviewed'}],requirements:[{id:'R-1',featureId:'F-1',text:'允许查询记录',sourceRefs:[{sourceUnitId:'S-0'},{sourceUnitId:'S-1'}],state:'reviewed'}],clarifications:[{id:'Q-1',question:'是否含税？',reason:'未明确',knownFacts:'原文有金额',unresolvedPoint:'税额口径',impact:'影响计算',level:'blocking',affectedIds:['R-1'],sourceRefs:[{sourceUnitId:'S-0'}],state:'open',resolutionProposal:{recommendation:'按含税金额',rationale:'便于对账',impact:'包含税额',confirmation:'确认含税',alternatives:['不含税'],sourceRefs:[{sourceUnitId:'S-0'}]},userDecision:{text:'使用不含税金额',status:'pending-prd-sync',confirmedAt:'2026-09-14',operationId:'OP-1'}}]};
 const file=path.join(root,'checklist.xlsx');await writeResultWorkbook(project,file);
 const wb=new ExcelJS.Workbook();await wb.xlsx.readFile(file);const main=wb.getWorksheet('需求清单')!,pending=wb.getWorksheet('待处理事项')!;
 expect(main.getRow(1).values.slice(1)).toEqual(checklistColumns);expect(main.getCell('D2').value).toBe('允许查询记录');expect(main.getCell('F2').value).toBe('unchecked');expect(main.getCell('G2').value).toBe('');
 expect(main.getCell('E2').value).toContain('sources/files/主需求/需求.md');expect(main.getCell('E2').value).toContain('sources/files/补充/需求.md');expect(main.getCell('E2').value).toContain('文件版本 3');
 expect(pending.getCell('I2').value).toBe('按含税金额');expect(pending.getCell('M2').value).toBe('不含税');expect(pending.getCell('P2').value).toBe('已确认，待同步 PRD');expect(pending.getCell('Q2').value).toBe('使用不含税金额');
 expect(JSON.stringify(wb.getWorksheet('阅读说明')?.getSheetValues())).toContain('先完整阅读');
});
