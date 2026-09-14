import { describe, expect, it } from 'vitest';
import { buildEvidenceCatalog, DetailEvidenceValidationError, evidencePromptInput, materializeDetailEvidenceSelections, materializeEvidenceSelections, resolveEvidenceIds } from '../electron/source-evidence';
import type { SourceUnit } from '../src/types';

const units:SourceUnit[]=[{id:'S1',label:'规则',kind:'paragraph',excerpt:'允许撤回。允许导出。',location:'第 1 行',status:'processed'}];

describe('确定性原文证据目录',()=>{
  it('已有需求的句内引用切分目录后精确回收，不扩大到整句',()=>{
    const {input,catalog}=evidencePromptInput({sourceUnits:units,currentRequirements:[{id:'R1',featureId:'F1',text:'允许撤回',sourceRefs:[{sourceUnitId:'S1',start:1,end:4}],state:'draft'}]});
    const current=(input as {currentRequirements:Array<{evidenceIds:string[]}>}).currentRequirements[0];
    expect(resolveEvidenceIds(current.evidenceIds,catalog,'current')).toEqual([{sourceUnitId:'S1',start:1,end:4}]);
    expect(catalog.map(item=>item.text).join('')).toBe(units[0].excerpt);
  });
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
  it('功能和关系由证据编号物化来源',()=>{
    const catalog=buildEvidenceCatalog(units),id=catalog[0].id;
    expect(materializeEvidenceSelections({features:[{evidenceIds:[id]}],relation:{evidenceIds:[id]}},catalog)).toMatchObject({features:[{sourceRefs:[{sourceUnitId:'S1',start:0,end:5}]}],relation:{sourceRefs:[{sourceUnitId:'S1',start:0,end:5}]}});
  });
  it('简短需求通过固定目录物化归属和状态',()=>{
    const catalog=buildEvidenceCatalog(units),raw={requirements:[{id:'LOCAL-R1',text:'允许撤回',evidenceIds:[catalog[0].id]}]};
    expect(materializeDetailEvidenceSelections(raw,catalog,'F1').clarifications).toEqual([]);
    expect(()=>materializeDetailEvidenceSelections({...raw,clarifications:[]},catalog,'F1')).toThrow('不允许');
    expect(materializeDetailEvidenceSelections(raw,catalog,'F1').requirements).toEqual([{id:'LOCAL-R1',featureId:'F1',text:'允许撤回',sourceRefs:[{sourceUnitId:'S1',start:0,end:5}],state:'draft'}]);
    for(const field of ['state','sourceUnitIds','behavior','evidenceBindings'])expect(()=>materializeDetailEvidenceSelections({...raw,requirements:[{...raw.requirements[0],[field]:[]}]},catalog,'F1')).toThrow();
    expect(()=>materializeDetailEvidenceSelections(raw,catalog)).toThrow();
    expect(()=>materializeDetailEvidenceSelections({...raw,requirements:[{...raw.requirements[0],featureId:'F2'}]},catalog,'F1')).toThrow();
  });
  it('非重叠证据拼接后保留段间与尾部空白',()=>{const excerpt='第一句。\n\n第二句。\n  ',catalog=buildEvidenceCatalog([{...units[0],excerpt}]);expect(catalog.map(item=>item.text).join('')).toBe(excerpt);expect(catalog.map(item=>[item.start,item.end])).toEqual([[0,4],[4,13]])});
  it('请求内证据使用短编号并移除调度与文件元数据',()=>{const {input,catalog}=evidencePromptInput({sourceUnits:[{...units[0],fileId:'very-long-file-id',fileRevision:9,status:'processed',synthetic:true,asset:{path:'secret-path',mimeType:'text/plain',sha256:'hash',readStatus:'read'}}]}) as {input:{sourceUnits:Array<Record<string,unknown>>;evidenceCatalog:Array<{id:string}>};catalog:Array<{id:string}>};expect(catalog.map(item=>item.id)).toEqual(['E1','E2']);expect(input.evidenceCatalog.map(item=>item.id)).toEqual(['E1','E2']);expect(input.sourceUnits[0]).not.toHaveProperty('fileId');expect(input.sourceUnits[0]).not.toHaveProperty('fileRevision');expect(JSON.stringify(input)).not.toContain('secret-path')});
  it('按已有选区限制请求证据且不发送限制参数',()=>{const {input,catalog}=evidencePromptInput({sourceUnits:units,evidenceSourceRefs:[{sourceUnitId:'S1',start:0,end:5}]}) as {input:Record<string,unknown>;catalog:Array<{text:string}>};expect(catalog).toHaveLength(1);expect(catalog[0].text).toBe('允许撤回。');expect(input).not.toHaveProperty('evidenceSourceRefs')});
});
