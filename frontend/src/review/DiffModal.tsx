import { useEffect, useState } from 'react';
import { view } from '@forge/bridge';
import DiffView from './DiffView';
import type { DiffField } from './types';
import { Loading, Page } from '../ui/primitives';
import { Notice } from '../ui/feedback';
export default function DiffModal(){const [fields,setFields]=useState<DiffField[]|null>(null);const [error,setError]=useState(false);
 useEffect(()=>{view.getContext().then(ctx=>setFields((ctx.extension.modal?.fields as DiffField[]|undefined)??[])).catch(()=>setError(true));},[]);
 return <Page title="Changes since approval">{error?<Notice danger>Could not load the comparison.</Notice>:fields?<DiffView fields={fields}/>:<Loading/>}</Page>;
}
