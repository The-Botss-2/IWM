/**
 * Which money rows belong to a client. Pure where-fragments, shared by the
 * Financials lists (`?clientId=`) and the client billing summary so the
 * Billing tab and its summary can never disagree.
 */

/**
 * The client's contracts: the contract names the client, or names no client
 * and sits on one of the client's live projects (the project decides).
 */
export function clientContractWhere(clientId: string): Record<string, unknown> {
  return {
    OR: [{ clientId }, { clientId: null, project: { clientId, deletedAt: null } }],
  };
}

/**
 * The client's payments: against one of its invoices (invoice-only payments
 * carry no contract) or against one of its contracts as defined above. A
 * payment against an invoice that is itself raised on a contract matches
 * both branches but is still one row, so it is never counted twice.
 */
export function clientPaymentWhere(clientId: string): Record<string, unknown> {
  return {
    OR: [{ invoice: { clientId } }, { contract: clientContractWhere(clientId) }],
  };
}
