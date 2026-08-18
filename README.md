# WebMCP Sports Demo

This repository now contains a single WebMCP demo: [**WebMCP Sports**](demos/sport-shop-angular/), an Angular storefront for sports equipment with in-browser WebMCP tools and an on-site AI assistant. The assistant can run on a fully local in-browser model (Qwen3 1.7B via WebLLM, no API key required) or on the Gemini API with your own key.

**Live demo:** [https://atinux.github.io/webmcp-tools-demo/](https://atinux.github.io/webmcp-tools-demo/)

## Repository Layout

- [**demos/sport-shop-angular**](demos/sport-shop-angular/) — the sports shop demo application
- [**demos/shared/webmcp-polyfill.js**](demos/shared/webmcp-polyfill.js) — shared WebMCP polyfill used by the demo
- [**build-demos.sh**](build-demos.sh) — helper script to build the demo locally
- [**.github/workflows/deploy.yml**](.github/workflows/deploy.yml) — GitHub Pages deployment workflow

## Local Development

```bash
cd demos/sport-shop-angular
npm ci
npm start
```

## Production Build

```bash
BASE_HREF=/webmcp-tools-demo/ ./build-demos.sh
```

The GitHub Pages workflow automatically builds the demo with the correct base path for the repository before publishing it.

## Disclaimer

This is not an officially supported Google product. This project is not
eligible for the [Google Open Source Software Vulnerability Rewards
Program](https://bughunters.google.com/open-source-security).
