import { lazy, Suspense, useState } from 'react';
import Button from '@atlaskit/button';
import { Loading } from '../../ui/primitives';
import type { PanelState } from '../types';
const ReviewWorkspace=lazy(()=>import('../../review/ReviewWorkspace'));
export default function DriftSection({drift,issueKey}:{drift:PanelState['drift'];issueKey?:string}){
 const [open,setOpen]=useState(false);
 if(!drift.count)return <div className="va-banner va-banner-success">No pending changes recorded.</div>;
 return <section className="va-stack"><div className="va-banner va-banner-warning"><strong>{drift.count} changes since approval</strong><p>{drift.materialCount} material changes need review.</p><Button onClick={()=>setOpen(!open)}>{open?'Hide comparison':'Review changes'}</Button></div>{open&&<Suspense fallback={<Loading label="Opening review…"/>}><ReviewWorkspace issueKey={issueKey} evidenceHash={drift.evidenceHash}/></Suspense>}</section>;
}
