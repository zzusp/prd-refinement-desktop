import {describe,expect,it,vi} from 'vitest';
import path from 'node:path';
const mock=vi.hoisted(()=>({write:vi.fn(),quality:vi.fn()}));
vi.mock('electron',()=>({app:{commandLine:{getSwitchValue:()=>''},requestSingleInstanceLock:()=>false,quit:()=>{},on:()=>{},getPath:()=>path.resolve('docs/tmp/test-run/main-export')},BrowserWindow:{getAllWindows:()=>[]},dialog:{},ipcMain:{},safeStorage:{},shell:{}}));
vi.mock('../electron/export-agent-package',()=>({packageQuality:mock.quality,writeAgentPackage:mock.write}));
import {exportAnalysisPackage} from '../electron/main';
describe('导出IPC正式与草稿分流',()=>{
 for(const [status,quality,bucket,kind] of [['completed','ready','deliveries','agent-package'],['needs-attention','blocked','drafts','draft'],['failed','blocked','drafts','draft']] as const)it(`${status}/${quality} 在写包前选择 ${bucket}`,async()=>{
  const task={id:'T-TEST',status,resultVersion:2,project:{features:[{id:'F1',requirementIds:['R1']}],requirements:[{id:'R1'}]}},recordArtifact=vi.fn().mockResolvedValue({});
  mock.quality.mockReturnValue({state:quality});mock.write.mockImplementation(async(_p,_t,root)=>({directory:path.join(root,'PACK'),manifest:{qualityState:quality}}));
  await exportAnalysisPackage({get:()=>task,recordArtifact} as any,task.id);
  expect(mock.write.mock.lastCall?.[2]).toBe(path.join(path.resolve('docs/tmp/test-run/main-export'),'analysis-tasks','T-TEST','result',bucket));expect(recordArtifact).toHaveBeenCalledWith(task.id,expect.objectContaining({kind}));
 });
 it('生成结果状态与预检不一致时不登记正式产物',async()=>{const recordArtifact=vi.fn();mock.quality.mockReturnValue({state:'ready'});mock.write.mockResolvedValue({directory:'PACK',manifest:{qualityState:'blocked'}});await expect(exportAnalysisPackage({get:()=>({id:'T',status:'completed',resultVersion:1,project:{features:[{id:'F',requirementIds:['R']}],requirements:[{id:'R'}]}}),recordArtifact} as any,'T')).rejects.toThrow('导出状态');expect(recordArtifact).not.toHaveBeenCalled()});
});
