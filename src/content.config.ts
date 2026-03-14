import { z, defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';

const blogCollection = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/blog' }),
  schema: z.object({
    title: z.string(),
    date: z.coerce.date(),
    description: z.string(),
    tags: z.array(z.string()).default([]),
    category: z.enum([
      'Adobe AEP',
      'RTDM',
      'Data Engineering',
      'Automation',
      'AI Experiments'
    ]),
    draft: z.boolean().default(false),
    cover: z.string().optional(),
  }),
});

export const collections = {
  blog: blogCollection,
};