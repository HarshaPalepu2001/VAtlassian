import api, { route, routeFromAbsolute } from '@forge/api';
import { GovernedObjectRef, ContentSnapshot } from './governanceCore.js';

export class ConfluenceAdapter {
  /**
   * `asApp` for a trigger or queue consumer, which has no user to act as:
   * Forge's asUser() throws there. Screens keep acting as the viewer, so a
   * page they cannot see or restrict stays out of their reach.
   */
  constructor({ asApp = false } = {}) {
    this.product = 'confluence';
    this.client = () => asApp ? api.asApp() : api.asUser();
  }

  getContentRoute(ref) {
    if (ref.contentType === 'blogpost') return route`/wiki/api/v2/blogposts/${ref.contentId}`;
    if (ref.contentType === 'attachment') return route`/wiki/api/v2/attachments/${ref.contentId}`;
    if (ref.contentType === 'whiteboard') return route`/wiki/api/v2/whiteboards/${ref.contentId}`;
    if (ref.contentType === 'database') return route`/wiki/api/v2/databases/${ref.contentId}`;
    if (ref.contentType === 'folder') return route`/wiki/api/v2/folders/${ref.contentId}`;
    if (ref.contentType === 'live-doc') return route`/wiki/api/v2/pages/${ref.contentId}`;
    return route`/wiki/api/v2/pages/${ref.contentId}`;
  }

  getCreateRoute(ref) {
    if (ref.contentType === 'blogpost') return route`/wiki/api/v2/blogposts`;
    if (ref.contentType === 'whiteboard') return route`/wiki/api/v2/whiteboards`;
    if (ref.contentType === 'database') return route`/wiki/api/v2/databases`;
    if (ref.contentType === 'folder') return route`/wiki/api/v2/folders`;
    return route`/wiki/api/v2/pages`;
  }

  async read(ref) {
    const contentRoute = this.getContentRoute(ref);
    const response = await this.client().requestConfluence(
      route`${contentRoute}?body-format=storage`
    );
    if (!response.ok) return null;
    const item = await response.json();
    
    // Attempt to get restrictions if supported
    let restrictions = [];
    if (['page', 'blogpost', 'live-doc'].includes(ref.contentType)) {
      try {
        const restRes = await this.client().requestConfluence(route`/wiki/rest/api/content/${ref.contentId}/restriction/byOperation`);
        if (restRes.ok) {
          restrictions = (await restRes.json()).results || [];
        }
      } catch(e) {}
    }
    item._restrictions = restrictions;
    return item;
  }

  async stableCapture(ref) {
    const item1 = await this.read(ref);
    if (!item1) throw new Error("Not found");
    
    await new Promise(r => setTimeout(r, 100));
    const item2 = await this.read(ref);
    
    if (item1.version?.number !== item2.version?.number) {
      throw new Error("Content changed during capture");
    }

    const title = item1.title || '';
    const restrictions = item1._restrictions || [];
    
    if (ref.contentType === 'attachment') {
      const downloadRes = await this.client().requestConfluence(item1.downloadLink || item1._links?.download || route`/wiki${item1._links?.download}`);
      if (!downloadRes.ok) throw new Error("Failed to fetch attachment blob");
      const buffer = await downloadRes.arrayBuffer();
      
      const { createHash } = await import('crypto');
      const hash = createHash('sha256').update(new Uint8Array(buffer)).digest('hex');
      
      const { objectStore } = await import('../db/objectStore.js');
      await objectStore.set(hash, Buffer.from(buffer));
      
      return new ContentSnapshot(hash, title, { stored: true }, restrictions, [], []);
    }

    if (['whiteboard', 'database', 'folder'].includes(ref.contentType)) {
       const meta = {
         id: item1.id,
         parentId: item1.parentId || item1.spaceId,
         position: item1.position,
         lifecycle: item1.status
       };
       return new ContentSnapshot(item1.version?.number?.toString() || '1', title, meta, restrictions, [], []);
    }

    return new ContentSnapshot(item1.body?.storage?.value || '', title, {}, restrictions, [], []);
  }

  async diff(ref, currentSnapshot) {
    const item = await this.read(ref);
    if (!item) return [{ field: 'exists', from: 'yes', to: 'no' }];
    
    const diffs = [];
    if (item.title !== currentSnapshot.title) {
       diffs.push({ field: 'title', from: currentSnapshot.title, to: item.title });
    }
    
    if (['whiteboard', 'database', 'folder'].includes(ref.contentType)) {
       if (item.version?.number?.toString() !== currentSnapshot.body) {
         diffs.push({ field: 'version', from: currentSnapshot.body, to: item.version?.number?.toString() });
       }
       return diffs;
    }

    if (ref.contentType === 'attachment') {
      const downloadRes = await this.client().requestConfluence(item.downloadLink || item._links?.download || route`/wiki${item._links?.download}`);
      if (downloadRes.ok) {
        const buffer = await downloadRes.arrayBuffer();
        const { createHash } = await import('crypto');
        const hash = createHash('sha256').update(new Uint8Array(buffer)).digest('hex');
        if (hash !== currentSnapshot.body) {
           diffs.push({ field: 'body', from: currentSnapshot.body, to: hash });
        }
      }
    } else {
      if ((item.body?.storage?.value || '') !== currentSnapshot.body) {
         diffs.push({ field: 'body', from: currentSnapshot.body, to: (item.body?.storage?.value || '') });
      }
    }
    
    if (JSON.stringify(item._restrictions || []) !== JSON.stringify(currentSnapshot.restrictions || [])) {
       diffs.push({ field: 'restrictions', from: '...', to: '...' });
    }
    
    return diffs;
  }

  async lock(ref) {
    if (['attachment', 'whiteboard', 'database', 'folder'].includes(ref.contentType)) return true;
    const res = await this.client().requestConfluence(route`/wiki/rest/api/content/${ref.contentId}/restriction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([
        { operation: 'update', restrictions: { user: [], group: [] } }
      ])
    });
    return res.ok;
  }

  async createWorkingCopy(ref) {
    if (ref.contentType === 'attachment') throw new Error('Working copies not supported for attachments');
    if (['whiteboard', 'database', 'folder'].includes(ref.contentType)) throw new Error('Working copies not supported for this type');
    
    const item = await this.read(ref);
    const body = {
      spaceId: item.spaceId,
      status: 'draft',
      title: item.title,
      parentId: item.parentId,
      body: {
        representation: 'storage',
        value: item.body?.storage?.value || ''
      }
    };
    
    const res = await this.client().requestConfluence(this.getCreateRoute(ref), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error('Failed to create working copy');
    const data = await res.json();
    return new GovernedObjectRef(ref.product, ref.tenantId, ref.containerId, ref.contentType, data.id, ref.version);
  }

  async promote(workingCopyRef, canonicalRef) {
    if (workingCopyRef.contentType === 'attachment') return false;
    const wc = await this.read(workingCopyRef);
    const canonical = await this.read(canonicalRef);
    if (!wc || !canonical) throw new Error('Missing content');
    
    const updateRes = await this.client().requestConfluence(this.getContentRoute(canonicalRef), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: canonical.id,
        status: 'current',
        title: canonical.title,
        spaceId: canonical.spaceId,
        body: {
          representation: 'storage',
          value: wc.body?.storage?.value || ''
        },
        version: {
          number: canonical.version.number + 1
        }
      })
    });
    
    if (updateRes.ok) {
      await this.client().requestConfluence(this.getContentRoute(workingCopyRef), { method: 'DELETE' });
      return true;
    }
    return false;
  }

  async restore(ref, snapshot) {
    const item = await this.read(ref);
    if (!item) return false;
    if (['whiteboard', 'database', 'folder'].includes(ref.contentType)) {
      throw new Error("Detection only, restoration not supported");
    }
    
    if (ref.contentType === 'attachment') {
       const { objectStore } = await import('../db/objectStore.js');
       const buffer = await objectStore.get(snapshot.body);
       if (!buffer) return false;
       
       const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);
       const header = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${item.title}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
       const footer = `\r\n--${boundary}--\r\n`;
       
       const headerBuf = Buffer.from(header, 'utf8');
       const footerBuf = Buffer.from(footer, 'utf8');
       const bodyBuffer = Buffer.concat([headerBuf, Buffer.from(buffer), footerBuf]);

       const updateRes = await this.client().requestConfluence(route`/wiki/api/v2/attachments/${item.id}/data`, {
         method: 'POST',
         headers: {
           'Content-Type': `multipart/form-data; boundary=${boundary}`,
           'Accept': 'application/json',
           'X-Atlassian-Token': 'nocheck'
         },
         body: bodyBuffer
       });
       return updateRes.ok;
    }

    const updateRes = await this.client().requestConfluence(this.getContentRoute(ref), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: item.id,
        status: 'current',
        title: snapshot.title,
        spaceId: item.spaceId,
        body: {
          representation: 'storage',
          value: snapshot.body
        },
        version: {
          number: item.version.number + 1
        }
      })
    });
    return updateRes.ok;
  }

  async verify(ref, snapshot) {
    const item = await this.read(ref);
    if (!item) return false;
    
    if (['whiteboard', 'database', 'folder'].includes(ref.contentType)) {
       return item.version?.number?.toString() === snapshot.body && item.title === snapshot.title;
    }

    if (ref.contentType === 'attachment') {
      const downloadRes = await this.client().requestConfluence(item.downloadLink || item._links?.download || route`/wiki${item._links?.download}`);
      if (!downloadRes.ok) return false;
      const buffer = await downloadRes.arrayBuffer();
      const { createHash } = await import('crypto');
      const hash = createHash('sha256').update(new Uint8Array(buffer)).digest('hex');
      return hash === snapshot.body && item.title === snapshot.title;
    }

    return (item.body?.storage?.value || '') === snapshot.body && item.title === snapshot.title;
  }

  async reconcile(ref) {
    const { getSubjectState, setSubjectState } = await import('../db/confluenceStore.js');
    const state = await getSubjectState(ref.contentId);
    if (!state || state.state !== 'PROTECTED') return true;

    const { throwing } = await import('../db/store.js');
    const baselines = await throwing('SELECT * FROM va_governance_baseline WHERE subject_id = ?', [ref.contentId]);
    if (baselines.length === 0) return true;

    const currentSnapshotHash = baselines[0].content_hash;
    const { objectStore } = await import('../db/objectStore.js');
    const snapshotBuffer = await objectStore.get(currentSnapshotHash);
    if (!snapshotBuffer) return true;

    let snapshot;
    try {
      snapshot = JSON.parse(snapshotBuffer.toString('utf8'));
    } catch(e) {
      snapshot = { body: snapshotBuffer.toString('utf8'), title: '', restrictions: [] };
    }

    const diffs = await this.diff(ref, snapshot);
    if (diffs.length > 0) {
      await setSubjectState(ref.contentId, ref.product, ref.contentType, 'DRIFTED');
      
      const { auditStore } = await import('../db/store.js');
      const { append, EVENT } = await import('./ledger.js');
      try {
         const { randomBytes } = await import('crypto');
         await append(auditStore, { eventId: randomBytes(16), actorAccountId: 'system', eventType: EVENT.DRIFT_DETECTED, payload: { pageId: ref.contentId, diffs }});
      } catch(e) {
         console.error('audit failed', e);
      }
    } else {
      await setSubjectState(ref.contentId, ref.product, ref.contentType, 'PROTECTED');
    }
    return true;
  }

  async getChildren(ref) {
    if (ref.contentType !== 'page' && ref.contentType !== 'folder') return [];
    
    const results = [];
    const queue = [ref];
    let count = 1; // root counts as 1

    while (queue.length > 0) {
      const current = queue.shift();
      
      // Fetch pages/folders
      let nextCursor = '';
      do {
        const url = current.contentType === 'folder' 
          ? `/wiki/api/v2/folders/${current.contentId}/children${nextCursor ? `?cursor=${nextCursor}` : ''}`
          : `/wiki/api/v2/pages/${current.contentId}/children${nextCursor ? `?cursor=${nextCursor}` : ''}`;
        
        const res = await this.client().requestConfluence(routeFromAbsolute(url));
        if (!res.ok) throw new Error('Unreadable descendants fail capture');
        const data = await res.json();
        
        for (const c of (data.results || [])) {
          const childRef = new GovernedObjectRef(ref.product, ref.tenantId, ref.containerId, 'page', c.id, c.version?.number);
          results.push(childRef);
          queue.push(childRef);
          count++;
          if (count > 500) throw new Error('TREE_LIMIT_EXCEEDED');
        }
        nextCursor = data._links?.next ? new URLSearchParams(data._links.next.split('?')[1]).get('cursor') : null;
      } while (nextCursor);

      // Fetch attachments
      nextCursor = '';
      do {
        const url = current.contentType === 'folder'
          ? `/wiki/api/v2/folders/${current.contentId}/attachments${nextCursor ? `?cursor=${nextCursor}` : ''}`
          : `/wiki/api/v2/pages/${current.contentId}/attachments${nextCursor ? `?cursor=${nextCursor}` : ''}`;

        const res = await this.client().requestConfluence(routeFromAbsolute(url));
        if (!res.ok) {
           if (res.status === 404) break;
           throw new Error('Unreadable descendants fail capture');
        }
        const data = await res.json();
        
        for (const a of (data.results || [])) {
          results.push(new GovernedObjectRef(ref.product, ref.tenantId, ref.containerId, 'attachment', a.id, a.version?.number));
          count++;
          if (count > 500) throw new Error('TREE_LIMIT_EXCEEDED');
        }
        nextCursor = data._links?.next ? new URLSearchParams(data._links.next.split('?')[1]).get('cursor') : null;
      } while (nextCursor);
    }
    return results;
  }
}
