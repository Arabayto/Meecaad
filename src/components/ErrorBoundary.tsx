import { Component, type ReactNode } from 'react';

/** If a screen crashes, show a way out instead of a blank page. */
export class ErrorBoundary extends Component<{ children: ReactNode; resetKey?: string }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidUpdate(prev: { resetKey?: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="panel form-stack" style={{ maxWidth: 560 }}>
        <h2 style={{ margin: 0 }}>This screen had a problem</h2>
        <p className="muted">Nothing was lost — saved records are safe. Reload the page, or open another page from the menu.</p>
        <p className="small muted">Details: {this.state.error.message}</p>
        <div><button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>Reload</button></div>
      </div>
    );
  }
}
