# ReneSkukies.github.io

Personal website, built with [Quarto](https://quarto.org).

- `quarto preview` – develop locally with live reload
- `quarto render` – build into `_site/`
- Deployment runs on push to `main` (GitHub Actions publishes to `gh-pages`).

## Adding a blog post

Create `blog/posts/<slug>/index.qmd` with front matter:

```yaml
---
title: "Post title"
date: 2026-01-01
categories: [Science]   # or [Meta-Science]
---
```
