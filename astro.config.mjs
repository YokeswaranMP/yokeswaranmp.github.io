import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  site: 'https://yokeswaranmp.github.io',
  vite: {
    plugins: [tailwindcss()],
  },
  build: {
    assets: '_assets'
  }
});
