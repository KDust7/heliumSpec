// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// https://astro.build/config
export default defineConfig({
  site: 'https://example.github.io',
  base: '/helium',
  integrations: [
    starlight({
      title: 'Helium',
      description: 'A Chrome Extension API emulation layer for proxy-based browsers.',
      logo: {
        dark: './src/assets/helium-logo-dark.svg',
        light: './src/assets/helium-logo-light.svg',
        replacesTitle: false,
      },
      customCss: ['./src/styles/custom.css'],
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/example/helium',
        },
      ],
      head: [
        {
          tag: 'meta',
          attrs: {
            name: 'theme-color',
            content: '#7c3aed',
          },
        },
      ],
      sidebar: [
        {
          label: 'Getting Started',
          items: [
            { label: 'Introduction', slug: 'introduction' },
          ],
        },
        {
          label: 'Architecture',
          items: [
            { label: 'System Overview', slug: 'spec/architecture' },
            { label: 'Execution Contexts', slug: 'spec/execution-contexts' },
            { label: 'Message Passing', slug: 'spec/message-passing' },
          ],
        },
        {
          label: 'API Layer',
          items: [
            { label: 'Binding System', slug: 'spec/api-binding' },
            { label: 'Implementation Guide', slug: 'spec/api-implementation' },
          ],
        },
        {
          label: 'Integration',
          items: [
            { label: 'Proxy Integration', slug: 'spec/proxy-integration' },
            { label: 'Manifest & CRX Loader', slug: 'spec/manifest-parser' },
          ],
        },
      ],
    }),
  ],
});
