export type JsonSchema = Record<string, unknown>;

const text={type:'string',minLength:1} as const;
const texts={type:'array',items:text} as const;
const evidenceText={type:'object',properties:{text,evidenceIds:texts},required:['text','evidenceIds'],additionalProperties:false} as const;
const proposal={type:'object',properties:{recommendation:text,rationale:text,impact:text,confirmation:text,alternatives:texts,evidenceIds:texts},required:['recommendation','rationale','impact','confirmation','alternatives','evidenceIds'],additionalProperties:false} as const;
const clarificationBase={id:text,question:text,reason:text,knownFacts:text,unresolvedPoint:text,impact:text,levelReason:text,evidenceIds:texts,affectedIds:texts,state:{type:'string',enum:['open']}} as const;
const clarification={anyOf:[
  {type:'object',properties:{...clarificationBase,level:{type:'string',enum:['blocking']},resolutionProposal:proposal},required:[...Object.keys(clarificationBase),'level','resolutionProposal'],additionalProperties:false},
  {type:'object',properties:{...clarificationBase,level:{type:'string',enum:['suggestion']},defaultResolution:text},required:[...Object.keys(clarificationBase),'level','defaultResolution'],additionalProperties:false},
  {type:'object',properties:{...clarificationBase,level:{type:'string',enum:['ignorable']}},required:[...Object.keys(clarificationBase),'level'],additionalProperties:false},
]} as const;

export const detailOutputSchema:JsonSchema={type:'object',properties:{requirements:{type:'array',items:{type:'object',properties:{id:text,title:text,behavior:evidenceText,conditions:{type:'array',items:evidenceText},constraints:{type:'array',items:evidenceText},explicitAcceptanceEvidenceIds:texts},required:['id','title','behavior','conditions','constraints','explicitAcceptanceEvidenceIds'],additionalProperties:false}},clarifications:{type:'array',items:clarification}},required:['requirements','clarifications'],additionalProperties:false};
