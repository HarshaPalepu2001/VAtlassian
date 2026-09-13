import React from 'react';
import ReactDOM from 'react-dom/client';

import '@atlaskit/css-reset';
import '../ui/tokens.css';
import '../ui/product.css';

import WebAuthnPopup from '../panel/WebAuthnPopup';

class PopupErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; error: Error | null }
> {
  state = { hasError: false, error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: 24, fontFamily: 'sans-serif' }}>
          <h2 style={{ color: '#ae2e24', margin: '0 0 12px 0', fontSize: 16 }}>Device check could not start</h2>
          <p style={{ color: '#44546f', fontSize: 14 }}>{this.state.error?.message || 'An error occurred.'}</p>
        </div>
      );
    }
    return this.props.children;
  }
}

function trackColorMode() {
  try {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      document.documentElement.setAttribute('data-color-mode', media.matches ? 'dark' : 'light');
    };
    apply();
    media.addEventListener('change', apply);
  } catch {
    // Ignore if matchMedia not supported
  }
}

trackColorMode();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <PopupErrorBoundary>
      <WebAuthnPopup />
    </PopupErrorBoundary>
  </React.StrictMode>
);
