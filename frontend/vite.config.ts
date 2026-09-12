import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({plugins:[react()],base:'./',build:{rolldownOptions:{input:{main:'index.html',webauthn:'webauthn.html'},output:{codeSplitting:{groups:[{name:'ui',test:/node_modules/},{name:'review',test:/src\/review\//},{name:'admin',test:/src\/admin\//},{name:'webauthn',test:/@simplewebauthn/}]}}}}});
