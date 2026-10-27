import { redirect } from 'next/navigation';

/**
 * Bare `/settings` lands on the workspace pane. The sidebar in the layout
 * lets the user navigate to mail or users from there.
 */
export default function SettingsIndexPage() {
  redirect('/settings/workspace');
}
