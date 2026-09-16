import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { PrdProject } from '../src/types.js';

contextBridge.exposeInMainWorld('prdApp', {
  materials: {
    create:()=>ipcRenderer.invoke('materials:create'),
    list:()=>ipcRenderer.invoke('materials:list'),
    get:(id:string)=>ipcRenderer.invoke('materials:get',id),
    renameBundle:(id:string,name:string)=>ipcRenderer.invoke('materials:rename',id,name),
    deleteBundle:(id:string)=>ipcRenderer.invoke('materials:delete',id),
    add:(id:string,options:import('../src/material-types.js').MaterialAddition,files?:File[])=>{
      const paths=files?.map(file=>webUtils.getPathForFile(file));
      if(paths?.some(p=>!p))return Promise.reject(new Error('无法取得本地路径，请从资源管理器拖入文件或目录'));
      return ipcRenderer.invoke('materials:add',id,options,paths);
    },
    updateFile:(id:string,fileId:string,patch:import('../src/material-types.js').MaterialFilePatch)=>ipcRenderer.invoke('materials:update-file',id,fileId,patch),
    removeFile:(id:string,fileId:string)=>ipcRenderer.invoke('materials:remove-file',id,fileId),
    saveAnalysisDraft:(id:string,text:string,expectedRevision?:number)=>ipcRenderer.invoke('materials:save-analysis-draft',id,text,expectedRevision),
    index:(id:string)=>ipcRenderer.invoke('materials:index',id),
    cancel:(id:string)=>ipcRenderer.invoke('materials:cancel',id),
    query:(id:string,query:import('../src/material-types.js').MaterialQuery)=>ipcRenderer.invoke('materials:query',id,query),
    read:(id:string,ids:string[])=>ipcRenderer.invoke('materials:read',id,ids),
    project:(id:string)=>ipcRenderer.invoke('materials:project',id),
    prepareAdjustment:(taskId:string,resultVersion:number)=>ipcRenderer.invoke('materials:prepare-adjustment',taskId,resultVersion),
  },
  importPrd: (file?: File) => {
    const filePath = file ? webUtils.getPathForFile(file) : undefined;
    if (file && !filePath) return Promise.reject(new Error('无法取得本地文件，请从资源管理器拖入文件'));
    return ipcRenderer.invoke('projects:import', filePath);
  },
  loadProjects: () => ipcRenderer.invoke('projects:list'),
  saveProject: (project: PrdProject) => ipcRenderer.invoke('projects:save', project),
  getAppVersion: () => ipcRenderer.invoke('app:version'),
  checkAppUpdate: () => ipcRenderer.invoke('app:check-update'),
  openAppRelease: () => ipcRenderer.invoke('app:open-release'),
  inspectRuntime: (config?: import('../src/types.js').RuntimeConfig) => ipcRenderer.invoke('runtime:inspect', config),
  prepareResult: (project: PrdProject) => ipcRenderer.invoke('projects:prepare-result', project),
  openResultDirectory: (taskId: string) => ipcRenderer.invoke('analysis:open-result', taskId),
  exportAgentPackage: (taskId: string) => ipcRenderer.invoke('analysis:export-package', taskId),
  loadRuntimeConfig: () => ipcRenderer.invoke('runtime:config:get'),
  saveRuntimeConfig: (config: import('../src/types.js').RuntimeConfig) => ipcRenderer.invoke('runtime:config:save', config),
  testRuntime: (config: import('../src/types.js').RuntimeConfig) => ipcRenderer.invoke('runtime:test', config),
  loadAnalysisTasks: () => ipcRenderer.invoke('analysis:list'),
  loadArchivedAnalysisTasks: () => ipcRenderer.invoke('analysis:list-archived'),
  archiveAnalysisTask: (taskId: string) => ipcRenderer.invoke('analysis:archive', taskId),
  restoreAnalysisTask: (taskId: string) => ipcRenderer.invoke('analysis:restore', taskId),
  deleteAnalysisTask: (taskId: string) => ipcRenderer.invoke('analysis:delete', taskId),
  updateDeliveryScope: (request: import('../src/types.js').DeliveryScopeUpdateRequest) => ipcRenderer.invoke('analysis:update-delivery-scope', request),
  queryAnalysisArtifacts: (taskId: string) => ipcRenderer.invoke('analysis:artifacts', taskId),
  startAnalysis: (project: PrdProject) => ipcRenderer.invoke('analysis:start', project),
  startMaterialAnalysis: (bundleId:string,text:string,draftRevision:number,operationId:string) => ipcRenderer.invoke('analysis:start-material',bundleId,text,draftRevision,operationId),
  startMaterialAdjustment: (baseTaskId:string,baseVersion:number,bundleId:string,text:string,draftRevision:number,operationId:string) => ipcRenderer.invoke('analysis:start-material-adjustment',baseTaskId,baseVersion,bundleId,text,draftRevision,operationId),
  cancelAnalysis: (taskId: string) => ipcRenderer.invoke('analysis:cancel', taskId),
  retryAnalysis: (taskId: string) => ipcRenderer.invoke('analysis:retry', taskId),
  restartAnalysis: (taskId: string) => ipcRenderer.invoke('analysis:restart', taskId),
  adjustAnalysis: (request: import('../src/types.js').RefinementAdjustmentRequest) => ipcRenderer.invoke('analysis:adjust', request),
  onAnalysisTaskUpdate: (callback: (task: import('../src/types.js').AnalysisTask) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, task: import('../src/types.js').AnalysisTask) => callback(task);
    ipcRenderer.on('analysis:task-update', listener);
    return () => ipcRenderer.removeListener('analysis:task-update', listener);
  },
});
