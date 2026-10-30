import { avatarColour, initials, nameOr } from './format';

/**
 * Draw a seal from a baseline's content hash. The first twelve hex digits
 * set tick lengths, and the thirteenth sets the ring size. Matching seals help
 * reviewers compare records across views. The full hash is available on hover.
 */
export function Seal({ hash, size = 28, tone = 'brand', label }: { hash?: string | null; size?: number; tone?: 'brand' | 'success' | 'warning' | 'neutral'; label?: string }) {
  const digits = (hash ?? '').replace(/[^0-9a-f]/gi, '').toLowerCase();
  const seed = digits.length >= 13 ? digits : (digits + '7a3c91e05bd24f68').slice(0, 16);
  const nibble = (i: number) => parseInt(seed[i % seed.length], 16) || 0;
  const ticks = Array.from({ length: 12 }, (_, i) => {
    const angle = (i * Math.PI) / 6 - Math.PI / 2;
    const length = 1.5 + (nibble(i) / 15) * 4.5;
    const outer = 12.5;
    const inner = outer - length;
    const p = (r: number) => `${(14 + r * Math.cos(angle)).toFixed(2)} ${(14 + r * Math.sin(angle)).toFixed(2)}`;
    return `M${p(outer - 1)}L${p(inner - 1)}`;
  }).join('');
  const core = 3 + (nibble(12) % 3);
  const title = label ?? (hash ? `Seal drawn from ${hash.slice(0, 8)}…${hash.slice(-4)}` : 'Seal');
  return (
    <svg className={`va-seal va-seal--${tone}`} width={size} height={size} viewBox="0 0 28 28" fill="none" stroke="currentColor"
      strokeWidth={size > 40 ? 1.1 : 1.5} strokeLinecap="round" role="img" aria-label={title}>
      <title>{title}</title>
      <circle cx="14" cy="14" r="12.5" />
      <circle cx="14" cy="14" r={core} />
      <path d={ticks} />
    </svg>
  );
}

/** An initials avatar with a consistent colour for each person. */
export function Avatar({ name, size = 20, automation = false }: { name?: string | null; size?: number; automation?: boolean }) {
  const resolved = nameOr(name, 'user');
  if (automation) {
    return (
      <span className="va-avatar va-avatar--automation" style={{ width: size, height: size }} aria-hidden="true">
        <svg width={size * 0.6} height={size * 0.6} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinejoin="round"><path d="M13 2 4 14h7l-1 8 9-12h-7z" /></svg>
      </span>
    );
  }
  return (
    <span className="va-avatar" aria-hidden="true"
      style={{ width: size, height: size, fontSize: Math.max(8, Math.round(size * 0.42)), background: resolved.unknown ? 'var(--va-border-strong)' : avatarColour(resolved.text) }}>
      {resolved.unknown ? '?' : initials(resolved.text)}
    </span>
  );
}

/** The VAtlassian mark: a shield with a tick, in the product's blue. */
export function Mark({ size = 20 }: { size?: number }) {
  return (
    <span className="va-mark" style={{ width: size, height: size }} aria-hidden="true">
      <svg width={size * 0.66} height={size * 0.66} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 3 4 6v6c0 4.5 3.4 8 8 9 4.6-1 8-4.5 8-9V6l-8-3z" /><path d="m8.5 12 2.5 2.5 4.5-5" />
      </svg>
    </span>
  );
}

type IconName = 'warning' | 'lock' | 'check' | 'info' | 'sparkle' | 'compare' | 'close' | 'refresh' | 'record' | 'arrow';
const ICON_PATHS: Record<IconName, string> = {
  warning: 'M12 3 2 20h20L12 3zM12 10v4M12 17h.01',
  lock: 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4',
  check: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM8 12l3 3 5-6',
  info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v5M12 8h.01',
  sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z',
  compare: 'M3 4h8v16H3zM13 4h8v16h-8z',
  close: 'M6 6l12 12M18 6 6 18',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
  record: 'M6 3h9l4 4v14H6zM9 12h7M9 16h7',
  arrow: 'M5 12h14M13 6l6 6-6 6'
};

/** Stroke icons, sized to sit on a 20px line. Decorative unless labelled. */
export function Icon({ name, size = 16, label }: { name: IconName; size?: number; label?: string }) {
  return (
    <svg className={`va-icon va-icon--${name}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden={label ? undefined : true} role={label ? 'img' : undefined} aria-label={label}>
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}
