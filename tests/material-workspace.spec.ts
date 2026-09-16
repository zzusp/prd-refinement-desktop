import { describe,expect,it } from 'vitest';
import { summarizeMaterialInputs } from '../src/MaterialWorkspace.js';

describe('更新资料页当前输入摘要',()=>{
  it('区分独立补充文件和资料目录且不重复展示目录内文件',()=>{
    const summary=summarizeMaterialInputs([
      {logicalPath:'需求.md',role:'primary',status:'read'},
      {logicalPath:'接口说明.txt',role:'supplement',status:'read'},
      {logicalPath:'原型/首页.png',role:'supplement',status:'read'},
      {logicalPath:'原型/历史/旧版.png',role:'historical',status:'read'},
      {logicalPath:'废弃.txt',role:'supplement',status:'excluded'}
    ]);
    expect(summary.standalone.map(file=>file.logicalPath)).toEqual(['接口说明.txt']);
    expect(summary.directories.map(directory=>[directory.name,directory.items.length])).toEqual([['原型',2]]);
  });

  it('兼容冻结快照中的反斜杠逻辑路径',()=>{
    const summary=summarizeMaterialInputs([{logicalPath:'设计稿\\移动端.png',role:'supplement',status:'read'}]);
    expect(summary.directories[0]?.name).toBe('设计稿');
  });
});
