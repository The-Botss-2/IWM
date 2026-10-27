import { mergeAttributes, Node } from '@tiptap/core';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    callout: {
      setCallout: (variant?: CalloutVariant) => ReturnType;
      toggleCallout: (variant?: CalloutVariant) => ReturnType;
      unsetCallout: () => ReturnType;
    };
  }
}

export type CalloutVariant = 'info' | 'warning' | 'danger' | 'success';
const VARIANTS: readonly CalloutVariant[] = ['info', 'warning', 'danger', 'success'];

/**
 * Callout block - wraps inline content with a colored aside. Variant is stored
 * as a data-attribute so the public reader's `generateHTML` output renders the
 * same colors purely from CSS (see globals.css `.botss-callout[data-variant]`).
 */
export const Callout = Node.create({
  name: 'callout',
  group: 'block',
  content: 'block+',
  defining: true,

  addAttributes() {
    return {
      variant: {
        default: 'info' as CalloutVariant,
        parseHTML: (el): CalloutVariant => {
          const raw = el.getAttribute('data-variant');
          return (VARIANTS as readonly string[]).includes(raw ?? '')
            ? (raw as CalloutVariant)
            : 'info';
        },
        renderHTML: (attrs) => ({ 'data-variant': attrs.variant ?? 'info' }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-callout]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        'data-callout': 'true',
        class: 'botss-callout',
      }),
      0,
    ];
  },

  addCommands() {
    return {
      setCallout:
        (variant) =>
        ({ commands }) =>
          commands.wrapIn(this.name, { variant: variant ?? 'info' }),
      toggleCallout:
        (variant) =>
        ({ commands }) =>
          commands.toggleWrap(this.name, { variant: variant ?? 'info' }),
      unsetCallout:
        () =>
        ({ commands }) =>
          commands.lift(this.name),
    };
  },
});
