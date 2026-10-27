'use client';

import { Component, type ReactNode } from 'react';

import { QueryError } from './query-error';

interface Props {
  /** What the widget shows, lower case: "the workload chart" -> "Couldn't show the workload chart." */
  title: string;
  children: ReactNode;
}

interface State {
  failed: boolean;
}

/**
 * Contain a render crash to one widget, so a single broken dashboard card
 * shows a small "Couldn't show …" box with a retry instead of blanking the
 * whole page through the route's error boundary. Wrap each widget at its
 * call site. React itself logs the caught error in development.
 */
export class WidgetErrorBoundary extends Component<Props, State> {
  override state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  private reset = () => {
    this.setState({ failed: false });
  };

  override render() {
    if (this.state.failed) {
      return (
        <QueryError compact message={`Couldn't show ${this.props.title}.`} onRetry={this.reset} />
      );
    }
    return this.props.children;
  }
}
