import type { NodeValidationIssue } from '../src/types.js';

/** 仅由确定性领域校验显式抛出；普通 Error/TypeError 均不是可修正候选。 */
export class DomainValidationError extends Error {
  readonly issues:NodeValidationIssue[];
  constructor(message:string,issues?:NodeValidationIssue[]){
    super(message);this.name='DomainValidationError';
    this.issues=issues??[{code:'domain',path:'candidate',expected:message,actual:'领域校验失败'}];
  }
}
