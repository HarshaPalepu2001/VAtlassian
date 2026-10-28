/**
 * The `view` entry point of sig-signature-code. What is actually STORED in this
 * field is the signature id that the signing form (frontend/src/field/ApprovalField.tsx) obtained from
 * panel:preauthorize — a 32-character hex receipt, never the code itself
 * (see the panel:preauthorize header in src/resolvers/panel.js for why).
 *
 * A raw hex id is not a useful thing to show a human on the issue view, and
 * this field is deliberately NOT the record: va_signature and the audit
 * ledger are. So this renders only the fact that a signature was captured,
 * and leaves who/when/what-it-meant to the Electronic Signature panel and
 * the admin audit ledger, which can show it with its meaning attached.
 *
 * Rendering the id here would also quietly turn every issue view, CSV
 * export and email notification into a place the id shows up, which is more
 * surface area than a receipt for a consumed one-time signature needs.
 */
import React from 'react';
import ForgeReconciler, { Lozenge, Text, useProductContext } from '@forge/react';

const SIGNATURE_TOKEN = /^[0-9a-f]{32}$/;

const View = () => {
  const context = useProductContext();
  const fieldValue = context?.extensionContext?.fieldValue;

  if (typeof fieldValue === 'string' && SIGNATURE_TOKEN.test(fieldValue)) {
    return <Lozenge appearance="success">Signed</Lozenge>;
  }
  return <Text>Not signed</Text>;
};

ForgeReconciler.render(<View />);
