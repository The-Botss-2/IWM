import { redirect } from 'next/navigation';

export default function RootRedirect() {
  // Brand mark and all "home" links point here. Signed-in users land on the
  // app launcher; unauthenticated users are bounced to /sign-in by
  // SessionGate inside the (app) layout.
  redirect('/home');
}
