---
title: Introduction
description: What Helium is, who it's for, and how the specification is organized.
sidebar:
  order: 0
---

Helium is a **Chrome Extension API emulation layer** designed for proxy-based browsers. It enables real Chrome extensions to run entirely within a web environment — no native browser integration required.

## Who is this for?

- **Proxy browser developers** (e.g., DaydreamX) who want to add Chrome extension support
- **Extension authors** who want to understand how their extensions behave in a proxy environment
- **Contributors** working on Helium itself

## How it works

Helium sits between Chrome extensions and the proxy browser, translating `chrome.*` API calls into web-native operations:

| Chrome API | Helium Strategy |
|------------|----------------|
| `chrome.storage` | IndexedDB with WAL + snapshots |
| `chrome.tabs` | Host-bound (DaydreamX provides tab management) |
| `chrome.runtime.sendMessage` | SharedWorker message backbone |
| `chrome.webRequest` | BareMux network middleware |
| Content script isolation | 4-layer proxy membrane sandbox |

## Specification structure

The spec is organized into 7 documents:

1. **[System Architecture](../spec/architecture/)** — The 6-layer stack, design principles, threading model, and data flow diagrams.

2. **[Message Passing](../spec/message-passing/)** — The SharedWorker-based message backbone, including `sendMessage`, `connect`, long-lived ports, mesh relay fallback, and crash recovery.

3. **[Execution Contexts](../spec/execution-contexts/)** — How background pages, content scripts, dedicated workers, and extension pages are emulated.

4. **[API Binding](../spec/api-binding/)** — The handler registry that maps host application functions into `chrome.*` APIs, including the fail-safe contract and graceful degradation.

5. **[API Implementation](../spec/api-implementation/)** — Per-namespace implementation details for all 4 tiers of Chrome APIs, from `chrome.runtime` to `chrome.tts`.

6. **[Proxy Integration](../spec/proxy-integration/)** — How Helium integrates with Reflux (content injection) and BareMux (network interception), including the bootstrap script, DNR evaluation, and cookie jar.

7. **[Manifest & CRX Loader](../spec/manifest-parser/)** — CRX3 unpacking, manifest parsing, permission resolution, virtual filesystem, and the atomic staging-then-swap install mechanism.
