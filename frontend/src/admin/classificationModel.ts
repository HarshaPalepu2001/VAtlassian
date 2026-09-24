import type { ClassifiedField } from './types';
export function moveField(fields:ClassifiedField[],id:string,decision:string):ClassifiedField[]{return fields.map(f=>f.fieldId===id&&!f.pinned?{...f,decision}:f);}
export function classificationPayload(fields:ClassifiedField[]){
 const serialize=({fieldId,fieldName,fieldKind,schemaType,rationale,storeValues}:ClassifiedField)=>({fieldId,fieldName,fieldKind,schemaType,rationale,...(storeValues===undefined?{}:{storeValues})});
 return {trackedFields:fields.filter(f=>f.decision==='GXP_CANDIDATE'||f.pinned).map(serialize),excludedFields:fields.filter(f=>f.decision!=='GXP_CANDIDATE'&&!f.pinned).map(serialize)};
}
