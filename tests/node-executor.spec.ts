import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { CandidateValidationError, defineNode, executeNode, type NodeRunOptions } from '../electron/node-executor';
import { RuntimeOperationError, type AnalysisRuntime, type ModelOperationRequest } from '../electron/runtime';

const shape = z.object({ text: z.string().min(1) });
const node = (accept = (value: Record<string, unknown>) => ({ text: value.text as string })) => defineNode({
  id: 'test-node', version: 1, input: shape, proposal: shape, result: shape,
  parameters: z.toJSONSchema(shape), instructions: '提交文本', accept,
});
function harness(handler: (request: ModelOperationRequest) => Promise<Record<string, unknown>> = async () => ({ text: 'accepted' })) {
  const executeOperation = vi.fn(async (request: ModelOperationRequest) => ({ value: await handler(request), completion: 'completed' as const }));
  const runtime = vi.fn(async () => ({ executeOperation }) as unknown as AnalysisRuntime);
  const save = vi.fn(async () => {});
  const options: NodeRunOptions = { workItemId: 'batch-1', executionId: 'execution-1', input: { text: 'source' }, configuration: { model: 'fixture' }, receipts: {}, runtime, save, assert() {} };
  return { options, runtime, executeOperation, save, receipt: () => Object.values(options.receipts)[0] };
}

describe('类型化节点执行器', () => {
  it('重复原文、重复证据、悬空证据及倒置位置在调用前一起拒绝', async () => {
    const h = harness();
    const inputSchema = z.object({ sourceUnits: z.array(z.object({ id: z.string() })), evidenceCatalog: z.array(z.object({ id: z.string(), sourceUnitId: z.string(), start: z.number(), end: z.number() })) });
    h.options.input = { sourceUnits: [{ id: 'S1' }, { id: 'S1' }], evidenceCatalog: [{ id: 'E1', sourceUnitId: 'S1', start: 0, end: 3 }, { id: 'E1', sourceUnitId: 'missing', start: 3, end: 2 }] };
    await expect(executeNode({ ...node(), input: inputSchema }, h.options)).rejects.toMatchObject({ category: 'input', issues: [expect.objectContaining({ code: 'duplicate-source' }), expect.objectContaining({ code: 'duplicate-evidence' }), expect.objectContaining({ code: 'unknown-source' }), expect.objectContaining({ code: 'invalid-span' })] });
    expect(h.runtime).not.toHaveBeenCalled(); expect(h.executeOperation).not.toHaveBeenCalled(); expect(h.options.receipts).toEqual({});
  });
  it('入参不合格时零 Runtime 初始化、零模型调用', async () => {
    const h = harness(); h.options.input = { text: '' };
    await expect(executeNode(node(), h.options)).rejects.toMatchObject({ category: 'input' });
    expect(h.runtime).not.toHaveBeenCalled(); expect(h.executeOperation).not.toHaveBeenCalled();
  });

  it('Schema 错误最多修正两轮且每轮携带原始输入、上一候选和完整错误', async () => {
    const h = harness(async () => ({ text: '' }));
    await expect(executeNode(node(), h.options)).rejects.toMatchObject({ category: 'validation' });
    expect(h.executeOperation).toHaveBeenCalledTimes(3);
    const second = h.executeOperation.mock.calls[1][0].input as any;
    expect(second.input).toEqual({ text: 'source' });
    expect(second.previousCandidate).toEqual({ text: '' });
    expect(second.issues).toEqual([expect.objectContaining({ code: 'too_small', path: 'text' })]);
    expect(h.receipt().status).toBe('failed'); expect(h.receipt().result).toBeUndefined();
    expect(h.receipt().attempts[0].repairs).toBe(2);
  });

  it('领域问题交给修正，程序 TypeError 不会被当作候选错误重试', async () => {
    const h = harness(); let checks = 0;
    const domainNode = node(value => {
      if (++checks === 1) throw new CandidateValidationError([{ code: 'unknown-evidence', path: 'text', expected: '当前证据', actual: '旧证据', relatedIds: ['E1'] }]);
      return { text: value.text as string };
    });
    await expect(executeNode(domainNode, h.options)).resolves.toEqual({ text: 'accepted' });
    expect(h.executeOperation).toHaveBeenCalledTimes(2);
    expect((h.executeOperation.mock.calls[1][0].input as any).issues[0].relatedIds).toEqual(['E1']);
    const broken = harness();
    await expect(executeNode(node(() => { throw new TypeError('代码缺陷'); }), broken.options)).rejects.toThrow('代码缺陷');
    expect(broken.executeOperation).toHaveBeenCalledTimes(1);
    expect(broken.receipt().attempts[0].repairs).toBe(0);
    const ordinary = harness();
    await expect(executeNode(node(() => { throw new Error('普通程序异常'); }), ordinary.options)).rejects.toThrow('普通程序异常');
    expect(ordinary.executeOperation).toHaveBeenCalledTimes(1);
    expect(ordinary.receipt().attempts[0].repairs).toBe(0);
  });

  it('传输与协议额度跨业务修正累计，不形成乘法重试', async () => {
    let count = 0;
    const h = harness(async () => {
      count++;
      if (count === 1 || count === 4 || count === 5) throw new RuntimeOperationError('transient', '暂时故障');
      if (count === 2) throw new RuntimeOperationError('protocol', '损坏提交');
      return { text: '' };
    });
    await expect(executeNode(node(), h.options)).rejects.toMatchObject({ code: 'transient' });
    expect(h.executeOperation).toHaveBeenCalledTimes(5);
    expect(h.receipt().attempts[0]).toMatchObject({ transientRetries: 2, protocolRetries: 1, repairs: 1 });
  });

  it('成功回执恢复不调用模型，输入或配置变化建立新回执', async () => {
    const h = harness();
    const first = await executeNode(node(), h.options); first.text = '客户端修改';
    await expect(executeNode(node(), { ...h.options, executionId: 'execution-2' })).resolves.toEqual({ text: 'accepted' });
    expect(h.executeOperation).toHaveBeenCalledTimes(1);
    await executeNode(node(), { ...h.options, input: { text: 'new-source' } });
    await executeNode(node(), { ...h.options, configuration: { model: 'new-model' } });
    await executeNode({ ...node(), version: 2 }, h.options);
    expect(h.executeOperation).toHaveBeenCalledTimes(4);
    expect(Object.keys(h.options.receipts)).toHaveLength(4);
  });

  it('失败尝试不能原地重放，显式新 executionId 可建立新尝试', async () => {
    let fail = true;
    const h = harness(async () => { if (fail) throw new RuntimeOperationError('authentication', '认证失败'); return { text: 'ok' }; });
    await expect(executeNode(node(), h.options)).rejects.toMatchObject({ code: 'authentication' });
    fail = false;
    await expect(executeNode(node(), h.options)).rejects.toMatchObject({ category: 'interrupted' });
    expect(h.executeOperation).toHaveBeenCalledTimes(1);
    await expect(executeNode(node(), { ...h.options, executionId: 'explicit-retry' })).resolves.toEqual({ text: 'ok' });
    expect(h.receipt().attempts).toHaveLength(2);
  });

  it('正式结果持久化失败时不得留下成功回执', async () => {
    const h = harness();
    h.options.save = async () => { if (h.receipt()?.status === 'succeeded') throw new Error('写盘失败'); };
    await expect(executeNode(node(), h.options)).rejects.toThrow('写盘失败');
    expect(h.receipt().status).toBe('failed'); expect(h.receipt().result).toBeUndefined();
  });

  it('取消后的迟到响应不能提交正式结果', async () => {
    const controller = new AbortController();
    const h = harness(async () => { controller.abort(new Error('取消任务')); return { text: '迟到结果' }; });
    h.options.signal = controller.signal;
    await expect(executeNode(node(), h.options)).rejects.toThrow('取消任务');
    expect(h.receipt().result).toBeUndefined(); expect(h.receipt().status).not.toBe('succeeded');
    expect(h.receipt().attempts[0].candidates).toEqual([]);
  });
});
