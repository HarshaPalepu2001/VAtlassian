import { useId, useRef, type ReactNode } from 'react';

type Tab = { id: string; label: string; count?: number; content: ReactNode };

/** Keep inactive panels mounted: navigation must never discard an unsaved draft. */
export function Tabs({ label, tabs, value, onChange }: {
  label: string; tabs: Tab[]; value: string; onChange: (value: string) => void;
}) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  return <>
    <div className="tm-tabs" role="tablist" aria-label={label}>
      {tabs.map((tab, index) => <button key={tab.id} type="button" role="tab"
        id={`${id}-tab-${tab.id}`} aria-controls={`${id}-panel-${tab.id}`}
        aria-selected={value === tab.id} tabIndex={value === tab.id ? 0 : -1}
        ref={node => { buttons.current[index] = node; }}
        onClick={() => onChange(tab.id)} onKeyDown={event => {
          let next: number;
          if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
          else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
          else if (event.key === 'Home') next = 0;
          else if (event.key === 'End') next = tabs.length - 1;
          else return;
          event.preventDefault(); onChange(tabs[next].id); buttons.current[next]?.focus();
        }}>
        {tab.label}{tab.count != null && <span className="tm-tab-count">{tab.count}</span>}
      </button>)}
    </div>
    {tabs.map(tab => <div className="tm-tab-panel" key={tab.id} role="tabpanel"
      id={`${id}-panel-${tab.id}`} aria-labelledby={`${id}-tab-${tab.id}`}
      hidden={value !== tab.id} tabIndex={0}>{tab.content}</div>)}
  </>;
}

export function Disclosure({ title, children, open = false }: {
  title: string; children: ReactNode; open?: boolean;
}) {
  return <details className="tm-disclosure" open={open}>
    <summary>{title}</summary><div className="tm-disclosure__body">{children}</div>
  </details>;
}
