/**
 * Shared presentation components.
 *
 * These carry no product logic — no invokes, no resolver types. Their job is
 * to be the single answer to "what does a person look like on screen", "what
 * does a table look like", so that the admin console and the signing panel
 * cannot drift into looking like two different apps.
 *
 * Styling lives in tokens.css, addressed by class name, rather than in inline
 * style objects. Inline styles were how the previous version of these screens
 * ended up with four slightly different greys and three border radii.
 */

import type { ReactNode } from 'react';
import { router } from '@forge/bridge';
import Spinner from '@atlaskit/spinner';
import { avatarColour, initials, nameOr } from './format';

/* ------------------------------------------------------------------ layout */

export function Page({
  eyebrow,
  title,
  lead,
  actions,
  variant = 'page',
  children
}: {
  eyebrow?: string;
  title?: ReactNode;
  lead?: ReactNode;
  actions?: ReactNode;
  variant?: 'page' | 'panel';
  children: ReactNode;
}) {
  return (
    <div className={variant === 'panel' ? 'va-page va-page--panel' : 'va-page'}>
      {(title || lead || eyebrow) && (
        <header className="va-page__header">
          <div className="va-row">
            <div style={{ minWidth: 0 }}>
              {eyebrow && <p className="va-page__eyebrow">{eyebrow}</p>}
              {title && <h1 className="va-page__title">{title}</h1>}
            </div>
            {actions && (
              <>
                <span className="va-spacer" />
                {actions}
              </>
            )}
          </div>
          {lead && <p className="va-page__lead">{lead}</p>}
        </header>
      )}
      {children}
    </div>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="va-section">
      <h2 className="va-section__title">{title}</h2>
      {children}
    </section>
  );
}

export function Card({
  title,
  subtitle,
  tone = 'default',
  flush = false,
  children
}: {
  title?: string;
  subtitle?: ReactNode;
  tone?: 'default' | 'sunken';
  flush?: boolean;
  children: ReactNode;
}) {
  const classes = ['va-card'];
  if (tone === 'sunken') classes.push('va-card--sunken');
  if (flush) classes.push('va-card--flush');
  return (
    <div className={classes.join(' ')}>
      {(title || subtitle) && (
        <div className="va-card__header">
          {title && <h3 className="va-card__title">{title}</h3>}
          {subtitle && <p className="va-card__subtitle">{subtitle}</p>}
        </div>
      )}
      {children}
    </div>
  );
}

export function Stack({ gap = 'normal', children }: { gap?: 'normal' | 'tight'; children: ReactNode }) {
  return <div className={gap === 'tight' ? 'va-stack va-stack--tight' : 'va-stack'}>{children}</div>;
}

/* ------------------------------------------------------------------ status */

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="va-loading">
      <Spinner size="medium" />
      <span>{label}</span>
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="va-empty">
      <p className="va-empty__title">{title}</p>
      {children && <p className="va-empty__body">{children}</p>}
    </div>
  );
}

export type Tone = 'neutral' | 'brand' | 'success' | 'warning' | 'danger';

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`va-badge va-badge--${tone}`}>{children}</span>;
}

/* ------------------------------------------------------------------- value */

/**
 * A name that may not have resolved, rendered so the two cases are visually
 * distinct. See format.ts for why the id is never the fallback.
 */
export function Name({ value, noun }: { value: string | null | undefined; noun: string }) {
  const resolved = nameOr(value, noun);
  return resolved.unknown ? (
    <span className="va-unknown">{resolved.text}</span>
  ) : (
    <>{resolved.text}</>
  );
}

/**
 * A click-through reference to a work item or a project, everywhere either is
 * named on screen. Both open the record in Jira itself rather than leave the
 * reader to go search for it — this app already knows exactly where it is.
 *
 * `router.open` rather than a plain anchor's default navigation: this runs
 * inside a Custom UI iframe, and a real page load would navigate the iframe
 * itself instead of the Jira tab around it. The `href` stays a real Jira URL
 * (so the browser's own "open in new tab", "copy link" etc. still work); only
 * the default left-click is intercepted.
 */
function ForgeLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      className="va-link"
      href={href}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        router.open(href);
      }}
    >
      {children}
    </a>
  );
}

export function IssueLink({ issueKey, summary }: { issueKey: string; summary?: string | null }) {
  return (
    <>
      <ForgeLink href={`/browse/${issueKey}`}>{issueKey}</ForgeLink>
      {summary && <div className="va-secondary">{summary}</div>}
    </>
  );
}

/** `projectKey` is optional because some rows resolve a project's name but
 *  never its key (see admin.js) — those render as plain text, not a dead link. */
export function ProjectLink({ projectKey, name }: { projectKey?: string | null; name: string | null | undefined }) {
  const resolved = nameOr(name, 'project');
  if (resolved.unknown) return <span className="va-unknown">{resolved.text}</span>;
  if (!projectKey) return <>{resolved.text}</>;
  return <ForgeLink href={`/browse/${projectKey}`}>{resolved.text}</ForgeLink>;
}

/** A person: avatar, name, and one line of context (their role, their email). */
export function Person({
  name,
  meta,
  noun = 'user'
}: {
  name: string | null | undefined;
  meta?: ReactNode;
  noun?: string;
}) {
  const resolved = nameOr(name, noun);
  return (
    <div className="va-person">
      <span
        className="va-person__avatar"
        style={{ background: resolved.unknown ? 'var(--va-border-strong)' : avatarColour(resolved.text) }}
        aria-hidden="true"
      >
        {resolved.unknown ? '?' : initials(resolved.text)}
      </span>
      <div className="va-person__body">
        <div className={resolved.unknown ? 'va-person__name va-unknown' : 'va-person__name'}>
          {resolved.text}
        </div>
        {meta && <div className="va-person__meta">{meta}</div>}
      </div>
    </div>
  );
}

/** Label/value pairs. Values are ReactNode so they can carry a <Name>. */
export function Facts({ items }: { items: Array<{ label: string; value: ReactNode }> }) {
  return (
    <dl className="va-facts">
      {items.map((item) => (
        <div key={item.label} style={{ display: 'contents' }}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** "Backlog → In Review", the shape a workflow edge should always take. */
export function StatusFlow({ from, to }: { from: ReactNode; to: ReactNode }) {
  return (
    <span className="va-row" style={{ gap: '6px' }}>
      {from}
      <span className="va-arrow" aria-label="changes to">
        →
      </span>
      {to}
    </span>
  );
}

/* ------------------------------------------------------------------- table */

export function Table({
  columns,
  children
}: {
  columns: Array<{ key: string; label: string; align?: 'left' | 'right' }>;
  children: ReactNode;
}) {
  return (
    <table className="va-table">
      <thead>
        <tr>
          {columns.map((column) => (
            <th key={column.key} className={column.align === 'right' ? 'va-table__actions' : undefined}>
              {/* A header whose only content is an actions column should not
                  announce a meaningless label to a screen reader. */}
              {column.label || <span className="va-visually-hidden" />}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}

/* -------------------------------------------------------------------- form */

export function Field({
  label,
  hint,
  children
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <label className="va-field">
      <span className="va-label">{label}</span>
      {children}
      {hint && <span className="va-hint">{hint}</span>}
    </label>
  );
}

export function Select({
  value,
  onChange,
  disabled,
  placeholder,
  options
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder: string;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <select
      className="va-select"
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    >
      <option value="">{placeholder}</option>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

/**
 * The 6-digit authenticator code box.
 *
 * Non-digits are stripped on the way in rather than rejected on submit: an
 * authenticator app displays "123 456" and people copy the space with it,
 * and a failed verification here is not free — it counts toward the lockout
 * in src/lib/totp.js.
 */
export function CodeInput({
  value,
  onChange,
  onSubmit,
  disabled,
  id
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit?: () => void;
  disabled?: boolean;
  id?: string;
}) {
  return (
    <input
      id={id}
      className="va-code"
      value={value}
      disabled={disabled}
      inputMode="numeric"
      autoComplete="one-time-code"
      placeholder="000000"
      aria-label="Six-digit authenticator code"
      maxLength={6}
      onChange={(event) => onChange(event.target.value.replace(/\D/g, '').slice(0, 6))}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && onSubmit) {
          event.preventDefault();
          onSubmit();
        }
      }}
    />
  );
}

/**
 * The affirmation the signer must make before the code box does anything.
 *
 * The checkbox is the intent. Typing six digits proves who you are; ticking
 * this says what you mean by it, which is the half 21 CFR 11.50(a)(4) is
 * about and the half a bare code box leaves out.
 */
export function Affirmation({
  checked,
  onChange,
  disabled,
  children
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <label className={checked ? 'va-affirm va-affirm--checked' : 'va-affirm'}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="va-affirm__text">{children}</span>
    </label>
  );
}
