import {describe,expect,it} from 'vitest';
import {attemptTimeoutMs,budgetClassFor,estimateTokens,measurePrompt} from '../electron/prompt-budget';

describe('提示词预算',()=>{
  it('分别统计字符、字节、估算 token 和分区长度且不产生限制字段',()=>{const value=measurePrompt('中文 abc','candidate',{instruction:'中文',input:'abc'});expect(value).toMatchObject({characters:6,bytes:10,estimateMethod:'cjk-and-ascii-v1',sections:{instruction:2,input:3}});expect(value.estimatedTokens).toBe(3);expect(value).not.toHaveProperty('targetTokens');expect(value).not.toHaveProperty('hardTokens')});
  it('超长提示仍只生成计量结果',()=>{expect(measurePrompt('中'.repeat(25000),'audit',{input:'中'.repeat(25000)}).estimatedTokens).toBe(25000)});
  it('按节点用途选择预算级别',()=>{expect(budgetClassFor('featureCandidates','candidate')).toBe('candidate');expect(budgetClassFor('audit','audit-1')).toBe('audit');expect(budgetClassFor('repair','repair-1')).toBe('repair');expect(estimateTokens('abcd')).toBe(1)});
  it('每次实际尝试最多等待两分钟',()=>{expect(attemptTimeoutMs()).toBe(120_000)});
});
