import { z } from 'zod';
export type JsonSchema = Record<string, unknown>;

const t=z.string().min(1).regex(/\S/u), ts=z.array(t), ids=ts.min(1), o=z.strictObject;
const state=z.enum(['draft','needs-clarification','reviewed']), kind=z.enum(['function','constraint']);
const ref=o({sourceUnitId:t,start:z.number().int().nonnegative().optional(),end:z.number().int().positive().optional()}), refs=z.array(ref).min(1);
const unit=z.object({id:t,label:t,kind:z.enum(['heading','paragraph','table','image','attachment']),location:t,excerpt:z.string().optional(),context:z.string().optional()}).passthrough();
const evidence=o({id:t,sourceUnitId:t,start:z.number().int().nonnegative(),end:z.number().int().positive(),text:t,candidateIds:ts.optional()});
const sources={sourceUnits:z.array(unit),evidenceCatalog:z.array(evidence).optional()};
const sourcedInput={sourceUnits:z.array(unit).min(1),evidenceCatalog:z.array(evidence).min(1)};
const featureHead=z.object({id:t,name:t,kind}).passthrough();
const resolutionFields={recommendation:t.min(12),rationale:t,impact:t,confirmation:t,alternatives:ts.max(2)};
const resolution=o({...resolutionFields,evidenceIds:ids});
const question={id:t,question:t,reason:t,knownFacts:t,unresolvedPoint:t,impact:t,levelReason:t,affectedIds:ids};
export const clarificationProposal=z.discriminatedUnion('level',[
 o({...question,evidenceIds:ids,level:z.literal('blocking'),resolutionProposal:resolution}),
 o({...question,evidenceIds:ids,level:z.literal('suggestion'),defaultResolution:t}),
 o({...question,evidenceIds:ids,level:z.literal('ignorable')}),
]);
export const clarificationResult=z.object({...question,level:z.enum(['blocking','suggestion','ignorable']),sourceRefs:refs,state:z.enum(['open','resolved','dismissed']),defaultResolution:t.optional(),resolutionProposal:o({...resolutionFields,sourceRefs:refs}).optional()}).passthrough().superRefine((q,c)=>{
 if(q.level==='blocking'&&!q.resolutionProposal)c.addIssue({code:'custom',path:['resolutionProposal'],message:'blocking 必须给出建议方案'});
 if(q.level==='suggestion'&&!q.defaultResolution)c.addIssue({code:'custom',path:['defaultResolution'],message:'suggestion 必须给出默认口径'});
});
const paired=o({text:t,evidenceIds:ids});
export const detailRequirementProposal=o({id:t,title:t,behavior:paired,conditions:z.array(paired),constraints:z.array(paired),explicitAcceptanceEvidenceIds:ts,featureId:t.optional()});
export const requirementResult=z.object({id:t,title:t,behavior:t,conditions:ts,constraints:ts,explicitAcceptanceConditions:ts,sourceUnitIds:ids,ruleIds:ts,state,featureId:t.optional(),evidenceBindings:o({behavior:refs,conditions:z.array(refs),constraints:z.array(refs),explicitAcceptanceConditions:z.array(refs)})}).passthrough();
const featureResult=z.object({id:t,name:t,kind,sourceUnitIds:ids,sourceRefs:refs,ruleIds:ts,requirementIds:ts,state,appliesToFeatureIds:ts.optional()}).passthrough();
const featureBase={id:t,name:t};
const unifiedFeature=z.discriminatedUnion('kind',[o({...featureBase,kind:z.literal('function'),appliesToFeatureIds:ts.max(0)}),o({...featureBase,kind:z.literal('constraint'),appliesToFeatureIds:ts})]);
const candidateFeature=z.discriminatedUnion('kind',[o({...featureBase,kind:z.literal('function'),appliesToFeatureIds:ts.max(0),evidenceIds:ids}),o({...featureBase,kind:z.literal('constraint'),appliesToFeatureIds:ts,evidenceIds:ids})]);
const role=z.enum(['requirement','clarification','context','example','summary','out-of-scope']);
const disposition=o({sourceUnitId:t,kind:role,reason:t,featureIds:ts});
const classificationIssue=o({candidateIds:ids,sourceUnitIds:ids,detail:t});
const issueFields={id:t,direction:z.enum(['forward','reverse','cross']),type:t,sourceUnitIds:ids,affectedIds:ids,detail:t,owner:z.enum(['feature-grouping','requirement-detail','requirement-relation','source-decision','runtime-output'])};
const category=z.enum(['source-ambiguity','rule-extraction','feature-boundary','detail-mismatch','unclassified']);
const issueProposal=z.union([o({...issueFields,category:z.literal('source-ambiguity'),clarification:clarificationProposal}),o({...issueFields,category:z.enum(['rule-extraction','feature-boundary','detail-mismatch','unclassified'])})]);
const issueResult=z.object({...issueFields,category,clarificationDraft:clarificationResult.optional()}).passthrough();
const relationFields={id:t,sourceRequirementId:t,targetRequirementId:t,kind:z.enum(['depends-on','affects','exception-to'])};
const relationProposal=o({...relationFields,evidenceIds:ids}), relationResult=o({...relationFields,sourceRefs:refs});
const detailProposal=o({requirements:z.array(detailRequirementProposal.omit({featureId:true})),clarifications:z.array(clarificationProposal)});
const detailResult=o({requirements:z.array(requirementResult),clarifications:z.array(clarificationResult)});
const reviewResults=z.array(o({issueId:t,status:z.enum(['resolved','unresolved']),reason:t}));
const entryBase={sourceUnitId:t,summary:t};
const entry=z.union([o({...entryBase,kind:z.literal('scope-decision'),deliveryScope:z.enum(['current','excluded'])}),o({...entryBase,kind:z.enum(['business-fact','organization','question','replacement'])})]);
const operation=o({id:t,quote:t,kind:z.enum(['organization','business-fact','replace-fact','defer','question']),instruction:t,featureIds:ts,clarificationIds:ts,atomicGroupId:t.optional()});
const adjustmentPlan=o({operations:z.array(operation),pending:z.array(o({id:t,quote:t,question:t,candidateFeatureIds:ts,candidateClarificationIds:ts}))});
const adjustmentReview=o({passed:z.boolean(),issues:ts,clarificationResolutions:z.array(o({clarificationId:t,status:z.enum(['supported','unsupported']),reason:t}))});
const requirementAction=z.discriminatedUnion('action',[o({action:z.literal('create'),requirement:detailRequirementProposal}),o({action:z.literal('update'),targetId:t,requirement:detailRequirementProposal}),o({action:z.literal('delete'),targetId:t})]);
const actionFields={satisfiedRequirementIds:ts,resolutionEvidenceIds:ts};
const clarificationAction=z.discriminatedUnion('action',[
 o({...actionFields,action:z.literal('create'),clarification:clarificationProposal}),o({...actionFields,action:z.literal('update'),targetId:t,clarification:clarificationProposal}),
 o({...actionFields,action:z.literal('keep'),targetId:t}),o({...actionFields,action:z.literal('resolve'),targetId:t}),o({...actionFields,action:z.literal('dismiss'),targetId:t}),
]);
const relationAction=z.discriminatedUnion('action',[o({action:z.literal('create'),relation:relationProposal}),o({action:z.literal('update'),targetId:t,relation:relationProposal}),o({action:z.literal('delete'),targetId:t})]);
const adjustmentActions=o({requirementActions:z.array(requirementAction),clarificationActions:z.array(clarificationAction),relationActions:z.array(relationAction)});
const snapshot=z.object({feature:featureResult,requirements:z.array(requirementResult),clarifications:z.array(clarificationResult),relations:z.array(relationResult)}).passthrough();
const userEvidence=z.object({id:t,author:z.literal('user'),kind:z.enum(['refinement-instruction','clarification-answer','supplement']),content:t,createdAt:t,version:z.number().int(),businessFact:z.boolean(),appliesTo:o({scope:z.enum(['feature','all']),featureIds:ts,clarificationIds:ts})}).passthrough();
const adjustmentInput=z.object({...sources,projectContextHash:t,feature:featureResult,currentRequirements:z.array(detailRequirementProposal),clarifications:z.array(clarificationResult),relations:z.array(relationResult),userOpinions:z.array(o({operation,evidence:userEvidence,notice:t}))}).passthrough();
export const projectResultSchema=z.object({id:t,name:t,sourceName:t,sourceHash:t,revision:z.number().int(),importedAt:t,rawText:z.string(),stage:z.enum(['imported','inventory','refining','review']),sourceUnits:z.array(unit),features:z.array(featureResult),requirements:z.array(requirementResult),clarifications:z.array(clarificationResult),relations:z.array(relationResult).optional()}).passthrough();
const readQuestion=z.object({id:t,question:t,knownFacts:t.optional(),unresolvedPoint:t.optional(),impact:t.optional(),affectedIds:ts.optional(),evidenceIds:ts.optional()}).passthrough();
function contract<I extends z.ZodType,P extends z.ZodType,R extends z.ZodType>(input:I,proposal:P,result:R){return {version:1,input,proposal,result};}
export const nodeContracts={
 image:contract(o({location:t}),o({readable:z.boolean(),text:t}),o({readable:z.boolean(),text:t})),
 inputInterpretation:contract(o({sourceUnits:z.array(o({id:t,excerpt:t})).min(1)}),o({entries:z.array(entry)}),z.array(z.object({...entryBase,kind:z.enum(['business-fact','scope-decision','organization','question','replacement']),deliveryScope:z.enum(['current','excluded']).optional(),status:z.enum(['applied','pending']),affectedFeatureIds:ts,affectedRequirementIds:ts}).passthrough())),
 candidates:contract(z.object({...sources,userInputApplications:z.array(z.object({sourceUnitId:t,kind:t,summary:t}).passthrough()).optional(),currentCandidates:z.array(featureResult).optional(),coverageIssues:z.array(z.object({sourceUnitIds:ids,detail:t,candidateIds:ids.optional()}).passthrough()).optional()}).passthrough(),o({features:z.array(candidateFeature),sourceDispositions:z.array(o({sourceUnitId:t,contentRole:role,reason:t,featureIds:ts}))}),o({features:z.array(featureResult),dispositions:z.array(disposition)})),
 unify:contract(z.object({candidates:z.array(featureHead.extend({sourceUnitIds:ids})),sourceDispositions:z.array(o({sourceUnitId:t,kind:role,featureIds:ts})),sourceUnits:z.array(unit).optional(),evidenceCatalog:z.array(evidence).optional(),issues:z.array(classificationIssue).optional()}).passthrough(),z.union([o({features:z.array(unifiedFeature),candidateMappings:z.array(o({candidateId:t,featureIds:ids,allocations:z.array(o({featureId:t,evidenceIds:ids})).min(1).optional()}))}),o({neededSourceUnitIds:ids}),o({classificationIssues:z.array(classificationIssue).min(1)})]),z.union([o({features:z.array(featureResult)}),o({needed:ids}),o({classificationIssues:z.array(classificationIssue).min(1)})])),
 details:contract(z.object({...sourcedInput,feature:featureHead,applicableConstraints:z.array(featureHead)}).passthrough(),detailProposal,detailResult),
 audit:contract(z.object({...sources,feature:featureHead,requirements:z.array(requirementResult),requirementCatalog:z.array(o({id:t,title:t})),clarifications:z.array(clarificationResult)}).passthrough(),o({issues:z.array(issueProposal),relations:z.array(relationProposal)}),o({issues:z.array(issueResult),relations:z.array(relationResult)})),
 repair:contract(z.object({...sourcedInput,features:z.array(featureResult),currentRequirements:z.array(detailRequirementProposal),currentClarifications:z.array(clarificationResult),issues:z.array(issueResult)}).passthrough(),o({requirements:z.array(detailRequirementProposal),clarifications:z.array(clarificationProposal),deleteRequirementIds:ts,deleteClarificationIds:ts}),o({...detailResult.shape,deleteRequirementIds:ts,deleteClarificationIds:ts})),
 repairReview:contract(z.object({...sources,beforeRequirements:z.array(requirementResult),requirements:z.array(requirementResult),beforeClarifications:z.array(clarificationResult),clarifications:z.array(clarificationResult),originalIssues:z.array(issueResult)}).passthrough(),o({originalIssueResults:reviewResults,introducedIssues:z.array(issueProposal),discoveredIssues:z.array(issueProposal)}),o({originalIssueResults:reviewResults,introducedIssues:z.array(issueResult),discoveredIssues:z.array(issueResult)})),
 resolutionProposals:contract(o({clarifications:z.array(readQuestion).min(1),evidence:z.array(o({id:t,text:t,context:z.string().optional()}))}),o({proposals:z.array(resolution.extend({clarificationId:t}))}),z.array(resolution.extend({clarificationId:t}))),
 adjustmentParse:contract(o({feedback:t,references:z.array(o({kind:z.enum(['feature','requirement','clarification']),id:t})),acceptedProposals:z.array(o({clarificationId:t,baseRecommendation:t,finalText:t})),features:z.array(o({id:t,name:t,requirements:z.array(o({id:t,title:t,behavior:t}))})),clarifications:z.array(readQuestion)}),adjustmentPlan,adjustmentPlan),
 adjustmentGenerate:contract(adjustmentInput,adjustmentActions,projectResultSchema),
 adjustmentRepair:contract(o({originalInput:adjustmentInput,candidate:snapshot,review:adjustmentReview}),adjustmentActions,projectResultSchema),
 adjustmentReview:contract(z.object({...sources,beforeClarifications:z.array(clarificationResult),operations:z.array(operation),userEvidence:z.array(userEvidence),candidate:snapshot}).passthrough(),adjustmentReview,adjustmentReview),
} as const;
export type NodeContractId=keyof typeof nodeContracts;
export type NodeInput<K extends NodeContractId>=z.infer<(typeof nodeContracts)[K]['input']>;
export type NodeProposal<K extends NodeContractId>=z.infer<(typeof nodeContracts)[K]['proposal']>;
export type NodeResult<K extends NodeContractId>=z.infer<(typeof nodeContracts)[K]['result']>;
export function schemaToJson(schema:z.ZodType):JsonSchema {
 const convert=(value:unknown):unknown=>{
  if(Array.isArray(value))return value.map(convert);
  if(!value||typeof value!=='object')return value;
  const item=Object.fromEntries(Object.entries(value).map(([key,child])=>[key,convert(child)])) as JsonSchema;
  if(Array.isArray(item.oneOf)){
   const branches=item.oneOf as JsonSchema[];
   // 只有所有分支都要求同一判别字段且 const 两两不同，oneOf 与 anyOf 才等价。
   const first=branches[0]?.properties as Record<string,JsonSchema>|undefined;
   const disjoint=first&&Object.keys(first).some(key=>{
    const tags:unknown[]=[];
    for(const branch of branches){
     const property=(branch.properties as Record<string,JsonSchema>|undefined)?.[key];
     if(!Array.isArray(branch.required)||!branch.required.includes(key)||!property||!Object.hasOwn(property,'const'))return false;
     tags.push(property.const);
    }
    return new Set(tags.map(tag=>JSON.stringify(tag))).size===branches.length;
   });
   if(disjoint){item.anyOf=item.oneOf;delete item.oneOf;}
  }
  if(item.type==='object'&&item.additionalProperties===false&&item.properties&&typeof item.properties==='object'){
   const properties=item.properties as Record<string,unknown>,required=Array.isArray(item.required)?item.required as string[]:[];
   const optional=Object.keys(properties).filter(key=>!required.includes(key));
   if(optional.length){
    const subsets=optional.reduce<string[][]>((all,key)=>[...all,...all.map(keys=>[...keys,key])],[[]]);
    const {$schema,...body}=item;
    return {...($schema?{$schema}:{}),anyOf:subsets.map(keys=>({...body,properties:Object.fromEntries([...required,...keys].map(key=>[key,properties[key]])),required:[...required,...keys]}))};
   }
  }
  return item;
 };
 return convert(z.toJSONSchema(schema,{target:'draft-7'})) as JsonSchema;
}
export const detailOutputSchema:JsonSchema=schemaToJson(nodeContracts.details.proposal);
