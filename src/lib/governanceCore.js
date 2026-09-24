export class GovernedObjectRef {
  constructor(product, tenantId, containerId, contentType, contentId, version) {
    this.product = product;
    this.tenantId = tenantId;
    this.containerId = containerId;
    this.contentType = contentType;
    this.contentId = contentId;
    this.version = version;
  }
}

export class ContentSnapshot {
  constructor(body, title, metadata, restrictions, attachments, digests) {
    this.body = body;
    this.title = title;
    this.metadata = metadata;
    this.restrictions = restrictions;
    this.attachments = attachments;
    this.digests = digests;
  }
}

export class GovernancePolicy {
  constructor(policyType, approvalRole, assuranceLevel, retentionMode, vaultMode) {
    this.policyType = policyType;
    this.approvalRole = approvalRole;
    this.assuranceLevel = assuranceLevel;
    this.retentionMode = retentionMode;
    this.vaultMode = vaultMode;
  }
}

export class JiraAdapter {
  constructor() {
    this.product = 'jira';
  }
  async read(ref) { return null; }
  async stableCapture(ref) { return null; }
  async diff(ref, currentSnapshot) { return null; }
  async lock(ref) { return null; }
  async createWorkingCopy(ref) { return null; }
  async promote(workingCopyRef) { return null; }
  async restore(ref, snapshot) { return null; }
  async verify(ref, snapshot) { return null; }
  async reconcile(ref) { return null; }
}

export class FakeConfluenceAdapter {
  constructor() {
    this.product = 'confluence';
    this.pages = new Map();
    this.workingCopies = new Map();
  }
  async read(ref) { 
    return this.pages.get(ref.contentId) || null;
  }
  async stableCapture(ref) { 
    const page = await this.read(ref);
    if (!page) throw new Error("Not found");
    return new ContentSnapshot(page.body, page.title, {}, [], [], []);
  }
  async diff(ref, currentSnapshot) { 
    return []; 
  }
  async lock(ref) { 
    return true; 
  }
  async createWorkingCopy(ref) { 
    const copyRef = new GovernedObjectRef(ref.product, ref.tenantId, ref.containerId, ref.contentType, ref.contentId + '_wc', ref.version);
    this.workingCopies.set(copyRef.contentId, { parent: ref.contentId });
    return copyRef;
  }
  async promote(workingCopyRef) { 
    const wc = this.workingCopies.get(workingCopyRef.contentId);
    if (!wc) throw new Error("No working copy");
    this.pages.set(wc.parent, { body: 'promoted', title: 'promoted title' });
    this.workingCopies.delete(workingCopyRef.contentId);
    return true; 
  }
  async restore(ref, snapshot) { 
    this.pages.set(ref.contentId, { body: snapshot.body, title: snapshot.title });
    return true; 
  }
  async verify(ref, snapshot) { 
    const p = this.pages.get(ref.contentId);
    return p && p.body === snapshot.body; 
  }
  async reconcile(ref) { 
    return true; 
  }
}
