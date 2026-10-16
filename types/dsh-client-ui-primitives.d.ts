/**
 * Ambient types for `@deepseek-ai/dsh-client-ui-primitives`.
 *
 * The package declares `"types": "lib/types/index.d.ts"` in its manifest and ships
 * no such file, and its JavaScript lives inside the DSH web app bundle rather than
 * in the published tarball. The official README states that plugins must share these
 * controls rather than bundle their own copies, so the import is correct and only
 * the types are missing.
 *
 * THE PROP TYPES ARE READ OFF REAL CALL SITES, NOT INVENTED
 * --------------------------------------------------------
 * Every prop below was taken from a shipped plugin that uses the control, so the
 * declarations describe the platform as it behaves rather than as it might be
 * documented. That matters more here than usual: a wrong prop name fails silently
 * at runtime — the control renders with a default and nothing reports an error.
 *
 * Widening these to `any` would be the single largest hole in this project's type
 * coverage, because the client half is almost entirely composed of these calls.
 * `FunctionComponent<any>` would type-check every one of them while checking
 * nothing.
 */
declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { FunctionComponent, ReactNode } from 'react';

  export type ButtonVariant = 'primary' | 'ghost' | 'outline' | 'toolbar';
  export type StateDotState = 'done' | 'warning' | 'error' | 'idle' | 'ongoing';
  export type TagTone = 'neutral' | 'solid' | 'outline' | 'info';

  export const Button: FunctionComponent<{
    variant?: ButtonVariant;
    onClick?: () => void;
    disabled?: boolean;
    className?: string;
    title?: string;
    children?: ReactNode;
    'aria-label'?: string;
  }>;

  export const StateDot: FunctionComponent<{ state?: StateDotState; className?: string }>;

  export const Tag: FunctionComponent<{ tone?: TagTone; className?: string; children?: ReactNode }>;

  /** Dims directories and keeps the filename at full strength, preserving the tail. */
  export const PathLabel: FunctionComponent<{ path: string; className?: string }>;

  export const FileTypeIcon: FunctionComponent<{
    path?: string;
    kind?: string;
    size?: number;
    className?: string;
  }>;

  /** Wraps exactly one child; `portal` escapes clipping ancestors. */
  export const Tooltip: FunctionComponent<{
    label: ReactNode;
    side?: 'top' | 'bottom' | 'left' | 'right';
    delayMs?: number;
    portal?: boolean;
    children?: ReactNode;
  }>;

  export const DisclosureRow: FunctionComponent<{
    icon?: ReactNode;
    title?: ReactNode;
    open?: boolean;
    expandable?: boolean;
    expandOnRowClick?: boolean;
    onToggle?: () => void;
    collapsedContent?: ReactNode;
    children?: ReactNode;
  }>;

  export const SegmentedControl: FunctionComponent<{
    id: string;
    label: string;
    value: string;
    onChange?: (value: string) => void;
    disabled?: boolean;
    options: ReadonlyArray<{ value: string; label: string; disabled?: boolean; title?: string }>;
  }>;

  export const SegmentedTabs: FunctionComponent<{
    className?: string;
    label: string;
    value: string;
    onChange?: (value: string) => void;
    items: ReadonlyArray<{ value: string; label: string; id: string; panelId: string; disabled?: boolean }>;
  }>;

  export const Pill: FunctionComponent<{
    active?: boolean;
    disabled?: boolean;
    className?: string;
    onClick?: () => void;
    children?: ReactNode;
    'aria-pressed'?: boolean;
    'aria-label'?: string;
  }>;

  export const Switch: FunctionComponent<{
    checked?: boolean;
    onChange?: (checked: boolean) => void;
    disabled?: boolean;
    className?: string;
    'aria-label'?: string;
  }>;

  export const ConnectionIndicator: FunctionComponent<{ state?: string; className?: string }>;

  export const Checkbox: FunctionComponent<{
    checked?: boolean;
    onChange?: (checked: boolean) => void;
    disabled?: boolean;
    className?: string;
    children?: ReactNode;
  }>;

  export const Input: FunctionComponent<{
    value?: string;
    onChange?: (value: string) => void;
    placeholder?: string;
    disabled?: boolean;
    className?: string;
    'aria-label'?: string;
  }>;

  export const TextShimmer: FunctionComponent<{ text?: string; className?: string; children?: ReactNode }>;

  export const Modal: FunctionComponent<{
    open?: boolean;
    onClose?: () => void;
    title?: ReactNode;
    children?: ReactNode;
  }>;

  /**
   * A modal that gates an action behind an acknowledgement.
   *
   * READ OFF REAL CALL SITES, NOT GUESSED
   * -------------------------------------
   * An earlier revision declared only `title`, `children`, `onConfirm` and `onCancel`,
   * inferred from a partial grep. It was wrong in every direction that shows:
   * `description` is a **string prop, not children**, so the modal opened with an empty
   * body; `acknowledgeLabel`, `cancelLabel` and `confirmLabel` were absent, so both
   * buttons rendered blank; and the checkbox is **controlled** by `acknowledged`, so it
   * rendered as an empty square. These packages ship no declarations, so a type written
   * here is a guess until it is read off something that works — and this one had not
   * been.
   *
   * Taken from `dsh-client-ui-commands` and `dsh-client-ui-permission-presets`, which
   * agree on every name; the second adds `disabled`.
   */
  export const RiskConfirmation: FunctionComponent<{
    open?: boolean;
    title?: ReactNode;
    /** The body. A string, not children — passing children renders nothing. */
    description?: ReactNode;
    /** Label for the checkbox that must be ticked before confirming. */
    acknowledgeLabel?: ReactNode;
    cancelLabel?: ReactNode;
    /** Label for the dismiss control. */
    closeLabel?: ReactNode;
    confirmLabel?: ReactNode;
    /** Controlled: the checkbox does not move unless this changes. */
    acknowledged?: boolean;
    /** Disables confirmation, e.g. while the gated action cannot proceed. */
    disabled?: boolean;
    onAcknowledgedChange?: (value: boolean) => void;
    onCancel?: () => void;
    onConfirm?: () => void;
    children?: ReactNode;
  }>;

  export const Toolbar: FunctionComponent<{ className?: string; children?: ReactNode }>;
  export const Menu: FunctionComponent<{ className?: string; children?: ReactNode }>;
  export const MenuGroup: FunctionComponent<{ label?: ReactNode; children?: ReactNode }>;
  export const MenuItemButton: FunctionComponent<{
    onClick?: () => void;
    disabled?: boolean;
    children?: ReactNode;
  }>;

  export const IconRefreshOutlineRegular: FunctionComponent<{ size?: number; className?: string }>;
  export const IconWarningOutlineRegular: FunctionComponent<{ size?: number; className?: string }>;

  /** Maps a path to the icon family the platform uses for it. */
  export function classifyFileType(path: string): string;
  /** Human-readable byte size, in the platform's own formatting. */
  export function fileSizeText(bytes: number): string;
  /** Writes to the clipboard; returns a promise where the platform supports it. */
  export function writeClipboard(text: string): void | Promise<void>;
}
