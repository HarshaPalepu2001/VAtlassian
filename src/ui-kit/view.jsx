/**
 * Render the issue-view receipt for sig-signature-code.
 *
 * The stored value is the 32-character signature ID returned by panel:preauthorize,
 * not an authenticator code. See frontend/src/field/ApprovalField.tsx and the
 * resolver's preauthorization comment.
 *
 * Show that a signature was captured. The authoritative record is va_signature
 * and the audit ledger; the Electronic Signature panel and admin ledger show
 * the signer, timestamp and meaning. Avoid displaying the receipt ID here or
 * spreading it into issue views, CSV exports and email notifications.
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
