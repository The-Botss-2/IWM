import { redirect } from 'next/navigation';

/**
 * Invoicing moved into Financials. Kept so old links and bookmarks still land.
 * A server redirect, so no client JS or loader flash is needed for the hop.
 */
export default function InvoicesRedirectPage(): never {
  redirect('/financials?tab=invoices');
}
