import type { PrdProject, SourceUnit } from './types.js';

export type MaterialRole = 'primary' | 'supplement' | 'historical';
export type BundleState = 'draft' | 'indexing' | 'needs-materials' | 'ready' | 'failed' | 'cancelled';
export interface MaterialFile {
  id: string; logicalPath: string; role: MaterialRole; revision: number;
  size: number; hash: string; status: 'registered'|'reading'|'read'|'blocked'|'excluded';
  reason?: string; exclusionReason?: string; sourceCount?: number;
}
export interface MaterialReference {
  id: string; fileId: string; location: string; reference: string;
  targetFileId?: string; state: 'resolved'|'missing'|'ambiguous'|'external'|'excluded';
  reason?: string;
}
export interface MaterialIssue { id: string; fileId?: string; referenceId?: string; message: string }
export interface MaterialBundle {
  id: string; name: string; revision: number; indexedRevision?: number; state: BundleState;
  files: MaterialFile[]; references: MaterialReference[]; issues: MaterialIssue[];
  progress: {completed: number; total: number; phase: string}; updatedAt: string;
  analysisDraft?: { text: string; revision: number; updatedAt: string };
  adjustmentBase?: { taskId: string; resultVersion: number };
  error?: string;
}
export interface MaterialBundleSnapshot {
  name: string;
  revision: number;
  state: BundleState;
  files: MaterialFile[];
  issues: MaterialIssue[];
  updatedAt: string;
}
export interface MaterialAddition {
  role: MaterialRole; kind: 'files'|'directory'; mount?: string;
}
export interface MaterialFilePatch { role?: MaterialRole; logicalPath?: string; exclusionReason?: string }
export interface MaterialQuery { query?: string; fileId?: string; offset?: number; limit?: number }
export interface MaterialSearchResult { items: SourceUnit[]; total: number; nextOffset?: number; revision: number }
export interface MaterialApi {
  create(): Promise<MaterialBundle>;
  list(): Promise<MaterialBundle[]>;
  get(id: string): Promise<MaterialBundle>;
  renameBundle(id: string, name: string): Promise<MaterialBundle>;
  deleteBundle(id: string): Promise<void>;
  add(id: string, options: MaterialAddition, files?: File[]): Promise<MaterialBundle>;
  updateFile(id: string, fileId: string, patch: MaterialFilePatch): Promise<MaterialBundle>;
  removeFile(id: string, fileId: string): Promise<MaterialBundle>;
  saveAnalysisDraft(id: string, text: string, expectedRevision?: number): Promise<MaterialBundle>;
  index(id: string): Promise<MaterialBundle>;
  cancel(id: string): Promise<MaterialBundle>;
  query(id: string, query: MaterialQuery): Promise<MaterialSearchResult>;
  read(id: string, unitIds: string[]): Promise<SourceUnit[]>;
  project(id: string): Promise<PrdProject>;
  prepareAdjustment(taskId: string, resultVersion: number): Promise<MaterialBundle>;
}
