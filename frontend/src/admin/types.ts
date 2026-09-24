export type Project={id:string;key:string;name:string};
export type JiraUser={accountId:string;displayName:string;emailAddress?:string};
export type ClassifiedField={fieldId:string;fieldName:string;fieldKind:string;schemaType?:string;rationale?:string;pinned?:boolean;decision:string;currentState?:string;storeValues?:boolean};
export type ControlledField={field_id:string;field_name:string;field_kind:string;schema_type?:string;materiality?:string;store_values:boolean};
export type AvailableField={fieldId:string;fieldName:string;suggestedKind:string;schemaType?:string};
