import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({plugins:[react()],base:'./',build:{rolldownOptions:{output:{codeSplitting:{groups:[{name:'ui',test:/node_modules/},{name:'review',test:/src\/review\//},{name:'admin',test:/src\/admin\//}]}}}}});
