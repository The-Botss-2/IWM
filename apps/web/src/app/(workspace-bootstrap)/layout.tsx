import type { ReactNode } from 'react';

/**
 * Sidebar-less shell for the workspace-bootstrap routes. The app sidebar is
 * intentionally NOT mounted here - these pages run *before* the user has
 * picked a workspace, so the sidebar's workspace switcher and project links
 * have nothing meaningful to point at.
 */
export default function WorkspaceBootstrapLayout({ children }: { children: ReactNode }) {
  return <div className="bg-bg-subtle min-h-screen">{children}</div>;
}
