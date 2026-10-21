import * as React from 'react';
import { MUTED, h } from '../primitives';

/**
 * Catch a render failure inside the sidebar panel.
 *
 * A thrown component currently takes the whole right pane down to a black
 * rectangle, which is indistinguishable from "the plugin did not load". This
 * boundary keeps the pane usable and puts the actual error on screen so the
 * failure can be reported instead of guessed at.
 */
export class PanelBoundary extends React.Component<
  { children?: React.ReactNode },
  { error: Error | null; componentStack: string }
> {
  override state: { error: Error | null; componentStack: string } = { error: null, componentStack: '' };

  static getDerivedStateFromError(error: Error): { error: Error; componentStack: string } {
    return { error, componentStack: '' };
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // Also leave a trail for a terminal/journal reader when the panel is embedded.
    // eslint-disable-next-line no-console
    console.error('gitnexus panel render failed', error, info.componentStack);
    this.setState({ componentStack: info.componentStack ?? '' });
  }

  override render(): React.ReactNode {
    const { error, componentStack } = this.state;
    if (error === null) return this.props.children;

    return h(
      'div',
      {
        style: {
          padding: '12px',
          color: 'var(--dsw-alias-state-error-primary, #f38ba8)',
          fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
          fontSize: '11px',
          lineHeight: 1.5,
          whiteSpace: 'pre-wrap',
          overflow: 'auto',
        },
      },
      h('div', { style: { fontWeight: 700, marginBottom: '6px' } }, 'GitNexus 面板渲染失败'),
      h('div', { style: MUTED }, error.message),
      componentStack === '' ? null : h('div', { style: { ...MUTED, marginTop: '8px' } }, componentStack),
      error.stack === undefined ? null : h('div', { style: { ...MUTED, marginTop: '8px' } }, error.stack),
    );
  }
}
