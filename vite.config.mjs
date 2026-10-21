import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({base:'./',plugins:[react()],build:{outDir:'dist',sourcemap:true},server:{host:'127.0.0.1',port:5178,strictPort:true}});
