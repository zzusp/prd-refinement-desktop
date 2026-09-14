import { describe, expect, it } from 'vitest';
import { buildEvidenceCatalog, DetailEvidenceValidationError, evidencePromptInput, materializeDetailEvidenceSelections, materializeEvidenceSelections, resolveEvidenceIds } from '../electron/source-evidence';
import type { SourceUnit } from '../src/types';

const units:SourceUnit[]=[{id:'S1',label:'规则',kind:'paragraph',excerpt:'允许撤回。允许导出。',location:'第 1 行',status:'processed'}];

describe('确定性原文证据目录',()=>{
  it('同段多句生成稳定且可区分的程序选区',()=>{
    const first=buildEvidenceCatalog(units),second=buildEvidenceCatalog(units);
    expect(second).toEqual(first);expect(first.map(item=>item.text)).toEqual(['允许撤回。','允许导出。']);
    expect(first.map(item=>item.text).join('')).toBe(units[0].excerpt);
    expect(resolveEvidenceIds([first[0].id],first,'feature.evidenceIds')).toEqual([{sourceUnitId:'S1',start:0,end:5}]);
  });
  it('未知、空和过期证据编号确定性拒绝',()=>{
    const catalog=buildEvidenceCatalog(units);
    expect(()=>resolveEvidenceIds(['E-unknown'],catalog,'feature.evidenceIds')).toThrow('未提供或过期');
    expect(()=>resolveEvidenceIds([],catalog,'feature.evidenceIds')).toThrow('非空证据编号数组');
  });
  it('功能、澄清、关系和逐字段绑定统一转换为 SourceRef',()=>{
    const {catalog}=evidencePromptInput({sourceUnits:units}),id=catalog[0].id;
    const value=materializeEvidenceSelections({features:[{evidenceIds:[id]}],clarification:{evidenceIds:[id]},relation:{evidenceIds:[id]},requirement:{evidenceBindings:{behavior:[id],conditions:[[id]],constraints:[],explicitAcceptanceConditions:[]}}},catalog);
    const ref={sourceUnitId:'S1',start:0,end:5};
    expect(value).toMatchObject({features:[{sourceRefs:[ref]}],clarification:{sourceRefs:[ref]},relation:{sourceRefs:[ref]},requirement:{evidenceBindings:{behavior:[ref],conditions:[[ref]]}}});
    expect((value.requirement as {sourceUnitIds:string[]}).sourceUnitIds).toEqual(['S1']);
  });
  it('拒绝模型重新抄写 quote，并由验收证据反向取得原句',()=>{
    const catalog=buildEvidenceCatalog(units),id=catalog[0].id;
    expect(()=>materializeEvidenceSelections({features:[{sourceRefs:[{sourceUnitId:'S1',quote:'允许撤回。'}]}]},catalog)).toThrow('不得包含模型抄写的 quote');
    const value=materializeEvidenceSelections({requirements:[{explicitAcceptanceEvidenceIds:[id],evidenceBindings:{behavior:[id],conditions:[],constraints:[]}}]},catalog) as {requirements:Array<{explicitAcceptanceConditions:string[];evidenceBindings:{explicitAcceptanceConditions:unknown[]}}>};
    expect(value.requirements[0].explicitAcceptanceConditions).toEqual(['允许撤回。']);
    expect(value.requirements[0].evidenceBindings.explicitAcceptanceConditions).toEqual([[{sourceUnitId:'S1',start:0,end:5}]]);
  });
  it('允许明确表示没有原文明示验收条件',()=>{
    const value=materializeEvidenceSelections({requirements:[{explicitAcceptanceEvidenceIds:[]}]},buildEvidenceCatalog(units)) as {requirements:Array<{explicitAcceptanceConditions:string[];evidenceBindings:{explicitAcceptanceConditions:unknown[]}}>};
    expect(value.requirements[0].explicitAcceptanceConditions).toEqual([]);
    expect(value.requirements[0].evidenceBindings.explicitAcceptanceConditions).toEqual([]);
  });
  it('细化输出把文本与证据成对提交并由程序生成内部字段',()=>{
    const catalog=buildEvidenceCatalog(units),value=materializeDetailEvidenceSelections({requirements:[{id:'LOCAL-R1',title:'撤回',behavior:{text:'允许撤回',evidenceIds:[catalog[0].id]},conditions:[{text:'允许导出',evidenceIds:[catalog[1].id]}],constraints:[],explicitAcceptanceEvidenceIds:[catalog[0].id]}],clarifications:[]},catalog) as {requirements:Array<Record<string,unknown>>};
    expect(value.requirements[0]).toMatchObject({behavior:'允许撤回',conditions:['允许导出'],sourceUnitIds:['S1'],state:'draft',explicitAcceptanceConditions:['允许撤回。'],evidenceBindings:{behavior:[{sourceUnitId:'S1',start:0,end:5}],conditions:[[{sourceUnitId:'S1',start:5,end:10}]]}});
    expect(value.requirements[0]).not.toHaveProperty('explicitAcceptanceEvidenceIds');
  });
  it('细化输出一次报告全部结构和证据问题，不泄漏内部 sourceUnitIds 契约',()=>{
    const catalog=buildEvidenceCatalog(units);let caught:unknown;
    try{materializeDetailEvidenceSelections({requirements:[{id:'LOCAL-R1',title:'撤回',behavior:'允许撤回',conditions:['E1'],constraints:[{text:'限制',evidenceIds:['E99']}],explicitAcceptanceEvidenceIds:[],sourceUnitIds:['S1'],evidenceBindings:{},state:'draft'}],clarifications:[]},catalog)}catch(error){caught=error}
    expect(caught).toBeInstanceOf(DetailEvidenceValidationError);
    const error=caught as DetailEvidenceValidationError,paths=error.issues.map(issue=>issue.path);
    expect(paths).toEqual(expect.arrayContaining(['requirements[0].behavior','requirements[0].conditions[0]','requirements[0].constraints[0].evidenceIds[0]','requirements[0].sourceUnitIds','requirements[0].evidenceBindings','requirements[0].state']));
    expect(error.message).not.toContain('sourceUnitIds 必须是非空文本数组');
  });
  it('非重叠证据拼接后保留段间与尾部空白',()=>{const excerpt='第一句。\n\n第二句。\n  ',catalog=buildEvidenceCatalog([{...units[0],excerpt}]);expect(catalog.map(item=>item.text).join('')).toBe(excerpt);expect(catalog.map(item=>[item.start,item.end])).toEqual([[0,4],[4,13]])});
  it('请求内证据使用短编号并移除调度与文件元数据',()=>{const {input,catalog}=evidencePromptInput({sourceUnits:[{...units[0],fileId:'very-long-file-id',fileRevision:9,status:'processed',synthetic:true,asset:{path:'secret-path',mimeType:'text/plain',sha256:'hash',readStatus:'read'}}]}) as {input:{sourceUnits:Array<Record<string,unknown>>;evidenceCatalog:Array<{id:string}>};catalog:Array<{id:string}>};expect(catalog.map(item=>item.id)).toEqual(['E1','E2']);expect(input.evidenceCatalog.map(item=>item.id)).toEqual(['E1','E2']);expect(input.sourceUnits[0]).not.toHaveProperty('fileId');expect(input.sourceUnits[0]).not.toHaveProperty('fileRevision');expect(JSON.stringify(input)).not.toContain('secret-path')});
  it('按已有选区限制请求证据且不发送限制参数',()=>{const {input,catalog}=evidencePromptInput({sourceUnits:units,evidenceSourceRefs:[{sourceUnitId:'S1',start:0,end:5}]}) as {input:Record<string,unknown>;catalog:Array<{text:string}>};expect(catalog).toHaveLength(1);expect(catalog[0].text).toBe('允许撤回。');expect(input).not.toHaveProperty('evidenceSourceRefs')});
});
