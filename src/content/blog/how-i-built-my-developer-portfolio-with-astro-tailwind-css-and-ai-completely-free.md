---
title: "How I Built My Developer Portfolio with Astro, Tailwind CSS, and AI — Completely Free"
date: 2026-03-22
description: "A complete walkthrough of building a modern portfolio with Astro v6, Tailwind CSS v4, Pagefind, Make.com automation, and a Groq AI agent — all for $0"
tags: ["astro", "tailwind", "portfolio", "automation", "ai", "github-pages"]
category: "Automation"
draft: false
---

## Introduction

Every developer needs a portfolio. But most portfolios are either too simple, too template-like, or too expensive to maintain. I wanted something different — a platform that is fast, modern, fully automated, and costs absolutely nothing to run.

In this post I'll walk you through how I built my complete developer portfolio and blog platform from scratch using Astro v6, Tailwind CSS v4, Pagefind search, Make.com automation, and a Groq-powered AI chat agent. The entire stack is free and open source.

Here is what the final product includes:

- A modern dark-themed portfolio with 8 fully built pages
- A Markdown-based blog system with category filters
- A fully static search powered by Pagefind
- An automated blog publishing pipeline using Make.com
- An AI chat agent powered by Groq and Llama 3.3 70B
- Auto-deployment to GitHub Pages on every push

Let's dive in.

---

## Why Astro?

When I started this project I evaluated several frameworks — Next.js, Gatsby, Hugo, and Astro. I chose Astro for one core reason: **it is built for content-heavy static sites**.

Astro ships zero JavaScript by default. Every page is pre-rendered to pure HTML at build time. This means blazing fast load times, excellent SEO out of the box, and zero server costs since everything deploys as static files.

Astro v6 also introduced a redesigned Content Collections API which makes managing blog posts with typed schemas incredibly clean. More on that later.

---

## Project Setup

I started by creating a new Astro project:

```bash
npm create astro@latest yokeswaranmp.github.io
cd yokeswaranmp.github.io
```

I chose the **Empty** template to avoid any bloat and built everything from scratch. The folder structure I established upfront was:

```
src/
├── components/
├── content/
│   └── blog/
├── layouts/
├── pages/
└── styles/
```

---

## Tailwind CSS v4 — The New Way

Installing Tailwind for Astro has changed significantly in v4. The old `@astrojs/tailwind` integration is gone. Tailwind v4 now integrates directly as a Vite plugin:

```bash
npm install tailwindcss @tailwindcss/vite
```

```javascript
// astro.config.mjs
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  site: 'https://yokeswaranmp.github.io',
  vite: {
    plugins: [tailwindcss()],
  },
});
```

The biggest change in v4 is the configuration system. There is no more `tailwind.config.js` file. Everything is done inside your CSS using `@theme`:

```css
@import "tailwindcss";

@theme {
  --color-background: #0f172a;
  --color-primary: #6366f1;
  --color-accent: #22c55e;
  --color-foreground: #e2e8f0;
}
```

This automatically generates utility classes like `bg-primary`, `text-accent`, and `text-foreground` that you can use anywhere in your components. It is a much cleaner approach than the old config file.

---

## The Color Palette

The design is built around a dark developer aesthetic with four core colors:

| Role | Color | Hex |
|------|-------|-----|
| Background | Deep navy | `#0f172a` |
| Primary | Indigo | `#6366f1` |
| Accent | Green | `#22c55e` |
| Text | Soft white | `#e2e8f0` |

This palette gives the site a modern, professional feel that is easy on the eyes during long reading sessions — which matters for a blog.

---

## Building the Blog System with Content Collections

The blog system is powered by Astro's Content Collections API. In Astro v6 the configuration file moved to `src/content.config.ts` and requires a `loader` to be defined:

```typescript
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
  }),
});

export const collections = { blog: blogCollection };
```

A few things worth noting here:

**`z.coerce.date()`** automatically converts date strings from frontmatter like `2026-01-15` into proper JavaScript Date objects. Without `coerce` you would get type errors.

**`.default([])`** on tags means if a blog post is missing the tags field the build won't fail — it defaults to an empty array. This is critical for automation where you might occasionally forget a field.

Each blog post is a Markdown file with frontmatter:

```markdown
---
title: "Getting Started with Data Pipelines"
date: 2026-01-15
description: "A practical guide to building scalable data pipelines."
tags: ["data engineering", "pipelines", "ETL"]
category: "Data Engineering"
draft: false
---

## Introduction

Your content here...
```

---

## Dynamic Blog Routes

In Astro v6 rendering blog posts requires two important changes from previous versions.

First, the dynamic route file uses `post.id` instead of `post.slug`:

```astro
export async function getStaticPaths() {
  const posts = await getCollection('blog', ({ data }) => !data.draft);
  return posts.map(post => ({
    params: { slug: post.id },
    props: { post },
  }));
}
```

Second, rendering the content uses the new `render()` function imported from `astro:content` instead of calling `post.render()`:

```astro
---
import { getCollection, render } from 'astro:content';

const { post } = Astro.props;
const { Content } = await render(post);
---

<Content />
```

These two changes trip up almost everyone upgrading from Astro v4 to v5/v6. Worth bookmarking.

---

## Static Search with Pagefind

One of my favourite features is the search functionality. Pagefind indexes your entire built site and enables instant full-text search with zero server needed.

The setup is a single line added to the build script in `package.json`:

```json
"build": "astro build && npx pagefind --site dist"
```

After every build Pagefind crawls the `dist` folder, indexes all content, and generates a search index that gets deployed alongside your site. The search works entirely in the browser via WebAssembly.

To control what gets indexed I added `data-pagefind-body` to blog post content and `data-pagefind-ignore` to the navbar. This keeps search results focused on actual content rather than navigation elements.

---

## The 8 Pages

The portfolio includes these pages:

**Home** — Full-screen hero with name, title, description, CTA buttons, and social links.

**About** — Bio, quick info cards, and a grid of what I do covering Data Engineering, Adobe AEP, Automation, and AI Experiments.

**Skills** — Four skill categories with animated progress bars: Data Engineering, Adobe AEP, Cloud Infrastructure, and Automation & AI.

**Projects** — Featured and other projects with technology tags, descriptions, and links to GitHub and live sites.

**Blog** — Post listing with category filter buttons. Clicking a category filters the posts client-side with no page reload.

**Achievements** — A timeline layout showing certifications, milestones, and notable achievements.

**Contact** — Contact information cards plus a simple message form that opens the user's mail client.

**Search** — Pagefind-powered full-text search across all blog content.

---

## Automating Blog Publishing with Make.com

This is where things get interesting. I wanted to publish blog posts without manually creating files, committing, and pushing to GitHub. The automation pipeline works like this:

```
PowerShell script
      ↓
Make.com webhook receives data
      ↓
GitHub API creates markdown file
      ↓
GitHub Actions triggers rebuild
      ↓
Post is live in ~2 minutes
```

The PowerShell script handles all the heavy lifting locally — collecting blog metadata, opening VS Code for writing, building the frontmatter, base64 encoding the content, and sending everything to Make.com:

```powershell
# Build markdown
$markdown = "---`ntitle: `"$title`"`ndate: $date`n..."

# Base64 encode for GitHub API
$bytes   = [System.Text.Encoding]::UTF8.GetBytes($markdown)
$encoded = [Convert]::ToBase64String($bytes)

# Send to Make.com webhook
Invoke-RestMethod -Uri $WEBHOOK_URL -Method POST -Body $body
```

Make.com receives the webhook and uses its HTTP module to call the GitHub Contents API:

```
PUT https://api.github.com/repos/username/repo/contents/src/content/blog/filename.md
```

The GitHub API creates the file, which triggers GitHub Actions, which rebuilds the site. The post goes live in about 2 minutes from running the script.

One important lesson learned: the GitHub Contents API requires a `sha` field when updating an existing file. For new files no `sha` is needed. Always use unique slugs to avoid this issue.

---

## AI Chat Agent with Groq

The floating AI chat agent is powered by Groq's free API using the `llama-3.3-70b-versatile` model. It knows everything about me — skills, projects, achievements, contact information — and answers visitor questions in real time.

The key to making it work well is the system prompt. Instead of a generic assistant I gave it a detailed brief about me:

```javascript
const SYSTEM_PROMPT = "You are an AI assistant for Yokeswaran MP's 
portfolio. Answer questions about Yokeswaran in a friendly, professional 
and concise way. Keep answers to 2-3 sentences. Here is what you know: 
NAME: Yokeswaran MP. ROLE: Data Engineer and Adobe AEP Architect...";
```

The API call is a standard fetch to Groq's OpenAI-compatible endpoint:

```javascript
const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
  method: "POST",
  headers: {
    "Authorization": "Bearer " + GROQ_API_KEY,
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    model: "llama-3.3-70b-versatile",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userMessage }
    ],
    max_tokens: 200
  })
});
```

One critical security point: never hardcode API keys in source files. Use Astro's environment variables with the `PUBLIC_` prefix for browser-accessible values:

```javascript
const GROQ_API_KEY = import.meta.env.PUBLIC_GROQ_API_KEY;
```

And store the key in GitHub Secrets for the CI/CD pipeline to use during builds.

---

## SEO Optimization

Every page uses Open Graph meta tags, Twitter Card tags, canonical URLs, and a sitemap. The BaseLayout component handles all of this automatically:

```astro
<meta property="og:title" content={fullTitle} />
<meta property="og:description" content={description} />
<meta property="og:image" content={image} />
<link rel="sitemap" href="/sitemap-index.xml" />
```

The sitemap is generated automatically by `@astrojs/sitemap` integration:

```bash
npm install @astrojs/sitemap
```

```javascript
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://yokeswaranmp.github.io',
  integrations: [sitemap()],
});
```

---

## Deployment with GitHub Actions

The deployment pipeline is fully automated. Every push to the `main` branch triggers a GitHub Actions workflow that builds the site, runs Pagefind indexing, and deploys to GitHub Pages:

```yaml
- name: Build site + index
  run: npm run build
  env:
    PUBLIC_GROQ_API_KEY: ${{ secrets.PUBLIC_GROQ_API_KEY }}

- name: Upload artifact
  uses: actions/upload-pages-artifact@v3
  with:
    path: dist
```

The entire deploy takes about 2-3 minutes from push to live site.

---

## Lessons Learned

Building this project taught me several things worth sharing:

**Astro v6 breaking changes are real.** The content collections API, render function, and Tailwind integration all changed significantly. Always check the migration guide when upgrading major versions.

**Never commit secrets.** GitHub's push protection will block your push if it detects API keys in your code. Always use `.env` files and GitHub Secrets from day one.

**Make.com beats n8n for beginners.** n8n is powerful but the local setup, webhook registration, and authentication flows caused constant headaches. Make.com's visual interface and built-in OAuth handling solved the same problems in minutes.

**Pagefind is underrated.** Most developers reach for Algolia or Elasticsearch for search. Pagefind gives you 90% of the functionality with zero cost and zero server. For a static blog it is the perfect choice.

**Base64 matters for GitHub API.** The GitHub Contents API requires file content to be base64 encoded. Forgetting this causes silent failures that are hard to debug.

---

## The Complete Tech Stack

| Category | Technology |
|----------|-----------|
| Framework | Astro v6 |
| Styling | Tailwind CSS v4 |
| Content | Markdown + Zod schemas |
| Search | Pagefind |
| AI Agent | Groq + Llama 3.3 70B |
| Automation | Make.com + GitHub API |
| Deployment | GitHub Pages + GitHub Actions |
| Cost | $0 / month |

---

## What's Next

The portfolio is live and working but there is always room to improve. My next planned additions are:

**Azure OpenAI upgrade** — Replacing Groq with Azure OpenAI GPT-4o mini for smarter, more professional AI responses.

**Blog comments** — Adding Giscus which uses GitHub Discussions as a comment backend. Free and no database needed.

**Analytics** — Integrating Umami or Plausible for privacy-friendly visitor analytics.

**AI blog drafts** — Building an automation where I provide a topic and outline and an AI agent generates a first draft that I review before publishing.

---

## Conclusion

Building this portfolio from scratch was one of the most satisfying projects I have worked on recently. The combination of Astro's performance, Tailwind's flexibility, and the automation pipeline means I can focus entirely on writing and creating — not on deployment or infrastructure.

The best part? It costs absolutely nothing to run. Every tool in the stack has a generous free tier or is fully open source.

If you are a developer looking to build your own portfolio I hope this walkthrough gives you a solid foundation to start from. The entire source code is available on my GitHub.

---

*Have questions about any part of this build? Ask my AI assistant using the chat bubble in the bottom right corner — it knows everything about this project!*
