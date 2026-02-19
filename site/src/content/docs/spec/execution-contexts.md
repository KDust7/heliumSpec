---
title: Execution Contexts
description: Background pages, content scripts, workers, and extension pages.
sidebar:
  order: 2
---

This document describes how Helium creates, manages, and isolates the JavaScript environments where extension code runs.

## Overview

Chrome extensions run code in multiple isolated contexts. Helium must emulate each one:

| Context Type | Real Chrome | Helium Emulation | chrome.* Access |
|-------------|-------------|------------------|-----------------|
| MV2 Background Page | Hidden browser page | Hidden `<iframe>` | Full |
| MV3 Service Worker | ServiceWorker | Dedicated `Worker` | Full (no DOM) |
| Content Script | Isolated world in tab | Injected script in proxied page | Limited (`runtime`, `storage`, `i18n`, `extension`) |
| Extension Page (popup) | Browser-managed popup | `<iframe>` in host UI | Full |
| Extension Page (options) | Tab with extension URL | `<iframe>` in host UI | Full |
| Extension Page (sidepanel) | Browser sidebar | `<iframe>` in host UI | Full |
| Extension Page (newtab) | Overridden new tab page | `<iframe>` served from virtual FS | Full |
| Extension Page (devtools) | DevTools panel | `<iframe>` in host UI | Full + `devtools.*` |
| Offscreen Document (MV3) | Hidden document | Hidden `<iframe>` | Limited |

## Context Manager

The `ExecutionContextManager` is responsible for creating and destroying all execution contexts:

```typescript
interface ExecutionContext {
  id: string;                          // Unique context ID
  type: ContextType;
  extensionId: string;
  tabId?: number;                      // For content scripts and tab-based pages
  frameId?: number;                    // For content scripts
  windowId?: number;
  messagePort: MessagePort;            // Connection to SharedWorker
  chromeInstance: Chrome;              // The chrome.* object for this context
  destroy(): void;
}

enum ContextType {
  BACKGROUND = 'BACKGROUND',
  CONTENT_SCRIPT = 'CONTENT_SCRIPT',
  POPUP = 'POPUP',
  OPTIONS = 'OPTIONS',
  SIDE_PANEL = 'SIDE_PANEL',
  NEW_TAB = 'NEW_TAB',
  DEVTOOLS = 'DEVTOOLS',
  OFFSCREEN = 'OFFSCREEN',
  TAB = 'TAB',                         // Extension page loaded in a tab
}
```

## MV2 Background Pages

### How Chrome Does It

Chrome creates a hidden browser page (with full DOM) that runs the extension's background scripts. In MV2 with `"persistent": true`, this page stays alive indefinitely. With `"persistent": false` (event pages), Chrome suspends the page after ~5 seconds of inactivity.

### How Helium Does It

Helium creates a hidden `<iframe>` appended to a management container in the host page:

```typescript
class MV2BackgroundContext {
  private iframe: HTMLIFrameElement;
  private chromeInstance: Chrome;  // from @anthropic/chrome-api-mv2

  async create(extensionId: string, manifest: ParsedManifest): Promise<void> {
    // 1. Create hidden iframe
    this.iframe = document.createElement('iframe');
    this.iframe.style.display = 'none';
    this.iframe.sandbox = 'allow-scripts allow-same-origin';
    this.iframe.setAttribute('data-helium-ext', extensionId);
    this.iframe.setAttribute('data-helium-context', 'background');

    // 2. Determine what to load
    if (manifest.background?.page) {
      // Background page mode: load the HTML file
      this.iframe.src = this.resolveExtensionURL(extensionId, manifest.background.page);
    } else if (manifest.background?.scripts) {
      // Background scripts mode: create a minimal HTML page that loads each script
      const html = this.buildBackgroundHTML(extensionId, manifest.background.scripts);
      this.iframe.srcdoc = html;
    }

    // 3. Inject chrome.* BEFORE extension scripts execute
    if (manifest.background?.page) {
      // For background.page mode: inject via load event
      // (the HTML controls its own script loading)
      this.iframe.addEventListener('load', () => {
        this.injectChromeAPI(extensionId);
      });
    }
    // For background.scripts (srcdoc) mode: chrome.* is prepended
    // as the first <script> tag inside buildBackgroundHTML() below,
    // so it executes BEFORE any extension scripts. Do NOT use the
    // load event — extension scripts would crash accessing chrome.*
    // before load fires.

    // 4. Append to management container
    document.getElementById('helium-contexts')!.appendChild(this.iframe);

    // 5. Connect to SharedWorker
    this.connectToMessageRouter(extensionId, ContextType.BACKGROUND);
  }

  private buildBackgroundHTML(extensionId: string, scripts: string[]): string {
    const scriptTags = scripts
      .map(s => `<script src="${this.resolveExtensionURL(extensionId, s)}"></script>`)
      .join('\n');

    return `<!DOCTYPE html>
<html>
<head>
  <script>
    // Helium runtime bootstrap — MUST execute before extension scripts
    // Creates window.chrome with full MV2 API surface
    ${this.buildInlineRuntimeScript(extensionId)}
  </script>
  ${scriptTags}
</head>
<body></body>
</html>`;
  }

  private injectChromeAPI(extensionId: string): void {
    const win = this.iframe.contentWindow!;

    // Create and configure the MV2 Chrome instance
    this.chromeInstance = new Chrome();
    this.configureChromeInstance(this.chromeInstance, extensionId);

    // Inject as window.chrome
    Object.defineProperty(win, 'chrome', {
      value: this.chromeInstance,
      writable: false,
      configurable: false,
    });
  }

  destroy(): void {
    this.iframe.remove();
    this.disconnectFromMessageRouter();
  }
}
```

### Lifecycle (persistent vs event pages)

**Persistent background page** (`"persistent": true`, the default in MV2):
- Created when the extension is loaded
- Never destroyed until the extension is unloaded/disabled
- Always available for message routing

**Event page** (`"persistent": false`):
- Created on first event that requires it
- Idle timer starts when no pending callbacks, ports, or message channels remain
- Destroyed after 5 seconds of inactivity (matching Chrome)
- Recreated when a new event fires

```typescript
class EventPageLifecycle {
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private activePorts: Set<string> = new Set();
  private pendingCallbacks: number = 0;

  onActivity(): void {
    // Reset idle timer
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  onIdle(): void {
    if (this.activePorts.size > 0 || this.pendingCallbacks > 0) {
      return; // Still active
    }

    this.idleTimer = setTimeout(() => {
      this.suspend();
    }, 5000);
  }

  private suspend(): void {
    // Fire chrome.runtime.onSuspend
    this.chromeInstance.runtime.onSuspend.dispatch();

    // Wait briefly for any cancellation
    setTimeout(() => {
      if (this.activePorts.size === 0 && this.pendingCallbacks === 0) {
        this.destroy();
      } else {
        // Activity resumed during onSuspend, fire onSuspendCanceled
        this.chromeInstance.runtime.onSuspendCanceled.dispatch();
      }
    }, 100);
  }
}
```

## MV3 Background Workers

### How Chrome Does It

Chrome runs the extension's background as a ServiceWorker with an event-driven lifecycle. The worker terminates after 30 seconds of inactivity (or 5 minutes for active work). It restarts on the next event.

### How Helium Does It

Helium uses a **Dedicated Worker** (not a ServiceWorker, since only one SW can control a scope). The event-driven lifecycle is emulated with keepalive tracking:

```typescript
class MV3BackgroundContext {
  private worker: Worker | null = null;
  private extensionId: string;
  private keepaliveTimer: ReturnType<typeof setTimeout> | null = null;
  private activeKeepAlives: Set<string> = new Set();

  async create(extensionId: string, manifest: ParsedManifest): Promise<void> {
    this.extensionId = extensionId;
    await this.spawnWorker(manifest);
  }

  private async spawnWorker(manifest: ParsedManifest): Promise<void> {
    // 1. Build the worker script
    //    We need to prepend the Helium runtime + chrome.* API before
    //    the extension's service_worker code
    const runtimeScript = await this.buildRuntimeScript(this.extensionId);
    const extensionScript = await this.readExtensionFile(
      this.extensionId,
      manifest.background!.service_worker!
    );

    // 2. Combine into a single blob
    const isModule = manifest.background?.type === 'module';
    const combined = `${runtimeScript}\n\n${extensionScript}`;
    const blob = new Blob([combined], { type: 'application/javascript' });
    const blobUrl = URL.createObjectURL(blob);

    // 3. Create the worker
    this.worker = new Worker(blobUrl, {
      type: isModule ? 'module' : 'classic',
      name: `helium-bg-${this.extensionId}`,
    });

    // 4. Set up message handling (bridge to SharedWorker)
    this.worker.onmessage = (e) => this.handleWorkerMessage(e);
    this.worker.onerror = (e) => this.handleWorkerError(e);

    // 5. Connect worker to SharedWorker backbone
    this.connectToMessageRouter();

    // 6. Start idle tracking
    this.resetIdleTimer();

    // 7. Clean up blob URL AFTER worker confirms load
    //    Revoking immediately can cause load failures in some browsers.
    //    Wait for the worker's first message (registration) as confirmation.
    const blobUrlToRevoke = blobUrl;
    const originalOnMessage = this.worker.onmessage;
    this.worker.onmessage = (e) => {
      URL.revokeObjectURL(blobUrlToRevoke);
      this.worker!.onmessage = originalOnMessage;
      originalOnMessage?.call(this.worker, e);
    };
  }

  private buildRuntimeScript(extensionId: string): string {
    // This injects:
    // - The MV3 Chrome class and all API stubs
    // - A self.chrome global
    // - MessagePort setup for SharedWorker communication
    // - Keepalive tracking hooks
    return `
      // ... Helium MV3 runtime code ...
      // Sets up self.chrome with full MV3 API surface
      // Receives a transferred MessagePort from the main thread that
      //   connects directly to the SharedWorker (zero main-thread relay)
      // See "Worker ↔ SharedWorker Direct Communication" above
    `;
  }

  // --- Lifecycle Management ---

  private resetIdleTimer(): void {
    if (this.keepaliveTimer) {
      clearTimeout(this.keepaliveTimer);
    }

    if (this.activeKeepAlives.size > 0) {
      return; // Active work, don't start timer
    }

    this.keepaliveTimer = setTimeout(() => {
      this.terminateWorker();
    }, 30_000); // 30 second idle timeout (Chrome's default)
  }

  addKeepAlive(id: string): void {
    this.activeKeepAlives.add(id);
    if (this.keepaliveTimer) {
      clearTimeout(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }

  removeKeepAlive(id: string): void {
    this.activeKeepAlives.delete(id);
    if (this.activeKeepAlives.size === 0) {
      this.resetIdleTimer();
    }
  }

  private terminateWorker(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
  }

  /**
   * Ensure the worker is alive, respawning if needed.
   * Called before dispatching any event to this extension.
   */
  async ensureAlive(manifest: ParsedManifest): Promise<void> {
    if (!this.worker) {
      await this.spawnWorker(manifest);
    }
  }

  destroy(): void {
    this.terminateWorker();
    this.disconnectFromMessageRouter();
  }
}
```

### Worker ↔ SharedWorker Direct Communication

Dedicated Workers cannot directly call `new SharedWorker()`. Helium solves this with a **`MessagePort` transfer** that establishes a direct, zero-copy communication channel between the Worker and the SharedWorker, bypassing the main thread entirely after initial setup.

**Setup sequence** (one-time, during worker creation):

```
Main Thread                 Dedicated Worker            SharedWorker
     │                           │                          │
     │── (1) Create              │                          │
     │   MessageChannel ─────────│                          │
     │   { port1, port2 }        │                          │
     │                           │                          │
     │── (2) Transfer port1 ────→│                          │
     │   worker.postMessage(     │                          │
     │     {port: port1},        │                          │
     │     [port1]               │                          │
     │   )                       │                          │
     │                           │                          │
     │── (3) Transfer port2 ────────────────────────────────→
     │   sharedWorker.port       │                          │
     │     .postMessage(         │                          │
     │       {port: port2,       │                          │
     │        extId, contextId}, │                          │
     │       [port2]             │                          │
     │     )                     │                          │
     │                           │                          │
     │   Main thread is now      │←── Direct MessagePort ──→│
     │   completely out of       │    (port1 ↔ port2)       │
     │   the loop                │    No main thread relay  │
     │                           │                          │
```

**Implementation**:

```typescript
class MV3BackgroundContext {
  private async connectWorkerToRouter(
    worker: Worker,
    extensionId: string,
    contextId: string
  ): Promise<void> {
    // 1. Create a MessageChannel for direct Worker ↔ SharedWorker communication
    const channel = new MessageChannel();

    // 2. Transfer one port to the Dedicated Worker
    worker.postMessage(
      { type: '__helium_router_port', port: channel.port1 },
      [channel.port1]  // Transfer ownership — port is no longer usable on main thread
    );

    // 3. Transfer the other port to the SharedWorker
    const sharedWorker = new SharedWorker('/helium/router.worker.js');
    sharedWorker.port.postMessage(
      {
        type: '__helium_worker_bridge',
        port: channel.port2,
        extensionId,
        contextId,
        contextType: 'BACKGROUND',
      },
      [channel.port2]  // Transfer ownership
    );

    // Main thread is now completely out of the communication path.
    // The Worker and SharedWorker communicate directly via the transferred ports.
  }
}
```

**Worker-side setup** (inside the built runtime script):

```typescript
// In the Dedicated Worker (runtime script prepended to extension code):
self.addEventListener('message', (event) => {
  if (event.data?.type === '__helium_router_port') {
    const routerPort: MessagePort = event.data.port;
    routerPort.start();

    // All chrome.* messaging now flows through this direct port
    self.__helium_routerPort = routerPort;

    // Register with SharedWorker
    routerPort.postMessage({
      type: '__helium_register',
      contextId: self.__helium_contextId,
      contextType: 'BACKGROUND',
      extensionId: self.__helium_extensionId,
    });
  }
});
```

**SharedWorker-side handling**:

```typescript
// SharedWorker receives the transferred port:
function handleWorkerBridge(data: any): void {
  const port: MessagePort = data.port;
  const { extensionId, contextId, contextType } = data;

  // Register this port as a direct connection to the Worker
  connections.set(contextId, port);

  port.addEventListener('message', (msg) => {
    handleMessage(port, msg.data);
  });
  port.start();

  extensionRegistry.addContext(extensionId, {
    contextId,
    type: contextType,
    port,
  });
}
```

**Key properties**:
- **Zero main-thread involvement** after the one-time port transfer during worker creation
- **No UI jank** — messages between the MV3 background worker and the SharedWorker never touch the main thread
- **Full `MessagePort` semantics** — guaranteed delivery, ordering, and structured clone transfer (including `Transferable` objects like `ArrayBuffer`)
- **No `BroadcastChannel` needed** — the direct port provides all the reliability guarantees that `BroadcastChannel` lacks

## Content Scripts

### Injection Mechanism

Content scripts are injected into proxied web pages via Reflux's `@browser` injection mechanism. When a proxied page's HTML response passes through the Reflux middleware transport, Helium's injection plugin evaluates the URL against all registered content script match patterns and injects matching scripts.

```
Response passes through Reflux middleware transport
  → Helium injection plugin evaluates URL against content script patterns
  → For each matching extension:
    → Determine run_at timing
    → Inject Helium content script bootstrap via @browser
    → Inject extension's content script files via @browser
  → Response returns to proxy SW for rewriting
```

This approach requires no UV/Scramjet-specific hooks or `config.inject` configuration -- Reflux handles all injection at the transport level.

### Injection HTML

Injection is handled by Reflux's `@browser` mechanism. The injected code follows these patterns depending on `run_at`:

For `run_at: "document_start"` (inject before any page scripts):
```html
<!-- Injected via @browser at the very top of <head> -->
<script data-helium-cs="ext-abc123" data-helium-world="ISOLATED">
  // Helium content script bootstrap
  (function() {
    // Set up limited chrome.* API
    const chrome = {
      runtime: { /* messaging only */ },
      storage: { /* full access */ },
      i18n: { /* message lookup */ },
      extension: { /* getURL only */ },
    };

    // Connect to SharedWorker for messaging
    // ...

    // Execute content script in isolated scope
    // ...
  })();
</script>
```

For `run_at: "document_end"`:
```html
<!-- Injected via @browser, wrapped in DOMContentLoaded listener -->
<script data-helium-cs="ext-abc123">
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() { /* execute */ }, {once: true});
  } else {
    /* execute immediately */
  }
</script>
```

For `run_at: "document_idle"`:
```html
<script data-helium-cs="ext-abc123">
  if (document.readyState === 'complete') {
    // Execute immediately
  } else {
    window.addEventListener('load', () => { /* execute */ }, {once: true});
  }
</script>
```

### Isolated World Emulation (Proxy Membrane Sandbox)

Chrome runs content scripts in an "isolated world" -- they share the page's DOM but have a separate JavaScript scope. Page scripts cannot access content script variables and vice versa.

**Threat model**: A malicious web page can tamper with shared prototypes (`Object.prototype`, `Array.prototype`, `Function.prototype`), redefine `Object.defineProperty`, install getter/setter traps on DOM nodes, or monkey-patch `MutationObserver` to intercept extension logic. Simple IIFE wrapping does NOT prevent these attacks.

Helium emulates isolated worlds with a **4-layer defense**:

#### Layer 1: Prototype Snapshot & Freeze

Before any content script executes, the bootstrap captures pristine references to all built-in prototypes and freezes them within the content script's scope. This prevents the page from poisoning prototypes after the snapshot.

```typescript
// Captured at bootstrap time, BEFORE any page scripts run (document_start)
const pristine = {
  ObjectProto: Object.getPrototypeOf({}),
  ArrayProto: Object.getPrototypeOf([]),
  FunctionProto: Object.getPrototypeOf(function() {}),
  defineProperty: Object.defineProperty,
  getOwnPropertyDescriptor: Object.getOwnPropertyDescriptor,
  getPrototypeOf: Object.getPrototypeOf,
  keys: Object.keys,
  assign: Object.assign,
  freeze: Object.freeze,
  create: Object.create,
  hasOwn: Object.hasOwn || ((o, p) => pristine.ObjectProto.hasOwnProperty.call(o, p)),
  // Frozen copies of critical constructors
  Map: Map,
  Set: Set,
  WeakMap: WeakMap,
  WeakRef: WeakRef,
  Promise: Promise,
  Proxy: Proxy,
  Reflect: Reflect,
  JSON: { parse: JSON.parse, stringify: JSON.stringify },
  ArrayFrom: Array.from,
  ArrayIsArray: Array.isArray,
};

// Deep-freeze all captured references
for (const key of Object.keys(pristine)) {
  try { Object.freeze(pristine[key]); } catch {}
}
Object.freeze(pristine);
```

#### Layer 2: Proxy Membrane (DOM Access Isolation)

Content scripts access the page's DOM through an ES6 `Proxy` membrane that intercepts property access. The membrane ensures that:
- DOM reads return real DOM values (content scripts need real DOM access)
- Property writes to `window`, `document`, or DOM nodes are intercepted and validated
- The page cannot discover extension-side references through the DOM
- Prototype chain lookups use the pristine (frozen) prototypes, not page-tampered ones

```typescript
function createMembrane(target: any, pristine: PristineRefs): any {
  const seen = new pristine.WeakMap();

  function wrap(value: any): any {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
      return value; // Primitives pass through unchanged
    }
    if (seen.has(value)) return seen.get(value);

    const proxy = new pristine.Proxy(value, {
      get(target, prop, receiver) {
        // Use pristine Reflect to avoid tampered getters
        const desc = pristine.getOwnPropertyDescriptor(target, prop);
        if (desc && desc.get) {
          // Call the getter with the real target (not the proxy)
          return wrap(desc.get.call(target));
        }
        return wrap(pristine.Reflect.get(target, prop, target));
      },

      set(target, prop, value, receiver) {
        return pristine.Reflect.set(target, prop, value, target);
      },

      defineProperty(target, prop, descriptor) {
        return pristine.defineProperty(target, prop, descriptor);
      },

      getPrototypeOf(target) {
        return pristine.getPrototypeOf(target);
      },

      has(target, prop) {
        return pristine.Reflect.has(target, prop);
      },
    });

    seen.set(value, proxy);
    return proxy;
  }

  return wrap(target);
}
```

#### Layer 3: Secure Global Scope

The content script's execution scope receives frozen copies of critical globals, immunizing extension code from page-side modifications:

```typescript
function createSecureGlobals(pristine: PristineRefs): Record<string, any> {
  return pristine.freeze({
    JSON: pristine.JSON,
    Promise: pristine.Promise,
    Map: pristine.Map,
    Set: pristine.Set,
    WeakMap: pristine.WeakMap,
    WeakRef: pristine.WeakRef,
    Reflect: pristine.Reflect,
    Proxy: pristine.Proxy,
    Array: { from: pristine.ArrayFrom, isArray: pristine.ArrayIsArray },
    Object: {
      keys: pristine.keys,
      assign: pristine.assign,
      freeze: pristine.freeze,
      create: pristine.create,
      defineProperty: pristine.defineProperty,
      getOwnPropertyDescriptor: pristine.getOwnPropertyDescriptor,
      getPrototypeOf: pristine.getPrototypeOf,
    },
  });
}
```

#### Layer 4: Content Script Execution Wrapper

The final wrapper combines all layers to create a hardened execution environment:

```javascript
// Content script isolation wrapper (replaces the old plain IIFE)
(function(chrome, window, document, secureGlobals, undefined) {
  'use strict';

  // Destructure secure globals into the content script's scope
  const { JSON, Promise, Map, Set, WeakMap, Reflect, Object } = secureGlobals;

  ${extensionContentScript}

})(
  heliumCreateChrome('${extensionId}', ${tabId}, ${frameId}),
  createMembrane(window, pristine),
  createMembrane(document, pristine),
  createSecureGlobals(pristine)
);
```

**Key properties**:
- Content script code runs inside a closure — page scripts cannot access `chrome` or any content script variables
- `window` and `document` inside the content script are membrane-wrapped proxies — page-side prototype poisoning is neutralized
- Critical built-ins (`JSON`, `Promise`, `Map`, etc.) are frozen copies — immune to page tampering
- DOM reads and writes work normally (the membrane is transparent for valid DOM operations)

#### Future: ShadowRealm Upgrade Path

`ShadowRealm` (TC39 Stage 3 proposal) provides true JavaScript context isolation — a separate global scope with its own built-in prototypes. When browsers ship `ShadowRealm`, Helium should adopt it as the primary isolation mechanism:

```typescript
// Feature-detect and prefer ShadowRealm when available
function createIsolationScope(): IsolationScope {
  if (typeof ShadowRealm !== 'undefined') {
    return new ShadowRealmIsolation();
  }
  // Fall back to Proxy Membrane approach
  return new ProxyMembraneIsolation();
}
```

`ShadowRealm` would eliminate the need for prototype freezing and proxy membranes entirely, as each content script would have its own fresh set of built-in prototypes by default.

### CSS Injection

Content script CSS files are injected as `<style>` tags:

```html
<style data-helium-css="ext-abc123">
  /* Extension's CSS content */
</style>
```

These are injected at `document_start` regardless of `run_at` (matching Chrome's behavior).

## Extension Pages

### Origin Isolation

All extension page iframes (popup, options, sidepanel) share the host page's origin because they are served from `/helium-ext/<extensionId>/...` under the same domain. This means `localStorage`, `sessionStorage`, `cookies`, and `indexedDB` are shared between extensions and the host — a significant isolation breach.

Helium applies the following mitigations:

#### Namespace-Prefixed Storage Wrappers

Extension page chrome instances wrap the `Storage` and `indexedDB` APIs with namespace prefixes to prevent cross-extension reads:

```typescript
function createIsolatedStorage(extensionId: string): Storage {
  const prefix = `__helium_${extensionId}__:`;

  return new Proxy(localStorage, {
    get(target, prop: string) {
      if (prop === 'getItem') return (key: string) => target.getItem(prefix + key);
      if (prop === 'setItem') return (key: string, value: string) => target.setItem(prefix + key, value);
      if (prop === 'removeItem') return (key: string) => target.removeItem(prefix + key);
      if (prop === 'clear') return () => {
        // Only clear THIS extension's keys
        const keysToRemove: string[] = [];
        for (let i = 0; i < target.length; i++) {
          const key = target.key(i);
          if (key?.startsWith(prefix)) keysToRemove.push(key);
        }
        keysToRemove.forEach(k => target.removeItem(k));
      };
      if (prop === 'key') return (index: number) => {
        // Return keys only for this extension
        let extIndex = 0;
        for (let i = 0; i < target.length; i++) {
          const key = target.key(i);
          if (key?.startsWith(prefix)) {
            if (extIndex === index) return key.slice(prefix.length);
            extIndex++;
          }
        }
        return null;
      };
      if (prop === 'length') {
        let count = 0;
        for (let i = 0; i < target.length; i++) {
          if (target.key(i)?.startsWith(prefix)) count++;
        }
        return count;
      }
      return Reflect.get(target, prop);
    },
  });
}

// IndexedDB isolation: override indexedDB.open() to namespace database names
function createIsolatedIndexedDB(extensionId: string): IDBFactory {
  const originalOpen = indexedDB.open.bind(indexedDB);
  return new Proxy(indexedDB, {
    get(target, prop: string) {
      if (prop === 'open') {
        return (name: string, version?: number) =>
          originalOpen(`helium-page-${extensionId}-${name}`, version);
      }
      return Reflect.get(target, prop);
    },
  });
}
```

#### Sandboxed Iframes

Extension page iframes include the `sandbox` attribute to limit capabilities:

```typescript
// Applied to all extension page iframes (popup, options, sidepanel)
iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups');
```

#### Future: Blob URL Opaque Origins

For true origin isolation, extension pages should be served from unique `blob:` URLs, giving each extension an opaque origin that cannot access any other origin's storage:

```typescript
// Future upgrade: serve extension pages from blob: URLs
async function createIsolatedExtensionPage(
  extensionId: string,
  pagePath: string
): Promise<string> {
  const html = await extensionFS.readFile(extensionId, pagePath);
  const blob = new Blob([html], { type: 'text/html' });
  return URL.createObjectURL(blob);
  // Each blob: URL gets a unique opaque origin —
  // completely isolated localStorage, sessionStorage, IndexedDB, and cookies
}
```

### Popup

```typescript
class PopupContext {
  private iframe: HTMLIFrameElement;

  open(extensionId: string, popupPath: string, anchorElement: HTMLElement): void {
    this.iframe = document.createElement('iframe');
    this.iframe.src = this.resolveExtensionURL(extensionId, popupPath);
    this.iframe.className = 'helium-popup';
    this.iframe.setAttribute('data-helium-ext', extensionId);
    this.iframe.setAttribute('data-helium-context', 'popup');

    // Position near the anchor (extension icon in toolbar)
    this.positionPopup(anchorElement);

    // Inject chrome.* after load
    this.iframe.addEventListener('load', () => {
      this.injectChromeAPI(extensionId, ContextType.POPUP);
    });

    document.body.appendChild(this.iframe);

    // Close on click outside
    document.addEventListener('click', this.handleOutsideClick);
  }

  close(): void {
    if (this.iframe) {
      // Explicitly unregister context from SharedWorker
      // (don't wait for heartbeat eviction — immediate cleanup)
      this.routerPort?.postMessage({
        type: '__helium_unregister',
        contextId: this.contextId,
      });
      this.iframe.remove();
      this.disconnectFromMessageRouter();
    }
    document.removeEventListener('click', this.handleOutsideClick);
  }
}
```

### Options Page

Options pages open as tabs in the host application (or as embedded iframes depending on `options_ui.open_in_tab`):

```typescript
class OptionsPageContext {
  open(extensionId: string, manifest: ParsedManifest): void {
    const optionsPath = manifest.options_ui?.page || manifest.options_page;
    if (!optionsPath) {
      throw new Error('Extension has no options page');
    }

    if (manifest.options_ui?.open_in_tab !== false) {
      // Open in a new tab (default)
      helium.emit('tabs.create', {
        url: this.resolveExtensionURL(extensionId, optionsPath),
      });
    } else {
      // Open as embedded iframe in extensions management page
      this.openEmbedded(extensionId, optionsPath);
    }
  }
}
```

### New Tab Override

When an extension declares `chrome_url_overrides.newtab`, the host application should load the extension's new tab page instead of its default:

```typescript
// In DaydreamX's tab creation logic:
function getNewTabURL(): string {
  const override = helium.getNewTabOverride();
  if (override) {
    return resolveExtensionURL(override.extensionId, override.path);
  }
  return 'about:blank'; // or default new tab
}
```

## Context Registry

The SharedWorker maintains a registry of all active contexts:

```typescript
interface ContextRegistryEntry {
  contextId: string;
  type: ContextType;
  extensionId: string;
  tabId?: number;
  frameId?: number;
  windowId?: number;
  url?: string;
  port: MessagePort;
  createdAt: number;
}

class ContextRegistry {
  private contexts: Map<string, ContextRegistryEntry> = new Map();

  register(entry: ContextRegistryEntry): void { /* ... */ }
  unregister(contextId: string): void { /* ... */ }

  // Queries
  getByExtension(extensionId: string): ContextRegistryEntry[] { /* ... */ }
  getByTab(tabId: number): ContextRegistryEntry[] { /* ... */ }
  getBackground(extensionId: string): ContextRegistryEntry | undefined { /* ... */ }
  getContentScripts(extensionId: string, tabId: number): ContextRegistryEntry[] { /* ... */ }
  getAllContexts(): ContextRegistryEntry[] { /* ... */ }
}
```

## Cleanup and Error Handling

### Context Destruction Order

When an extension is unloaded:

```
1. Fire chrome.runtime.onSuspend to background context
2. Wait 100ms for cleanup
3. Disconnect all MessagePorts
4. Terminate background worker/remove background iframe
5. Remove all content scripts from active tabs (remove injected <script> and <style> tags)
6. Close all open extension pages (popup, options, sidepanel)
7. Unregister all contexts from ContextRegistry
8. Remove alarms
9. Remove context menu items
10. Unregister content scripts from Reflux injection plugin
11. Fire chrome.management.onUninstalled to other extensions
```

### Error Isolation

Errors in one extension context must not affect others:

- Each Worker has its own `onerror` handler that logs but doesn't propagate
- Each iframe's scripts run in an isolated scope
- The SharedWorker catches errors in message handling and drops malformed messages
- If a background worker crashes, Helium can auto-restart it (matching Chrome's behavior for MV3 workers)

### Memory Management

- Terminated workers are fully garbage-collected (Worker.terminate() + null reference)
- Removed iframes are garbage-collected (iframe.remove() + null reference)
- MessagePorts are explicitly closed on context destruction
- Blob URLs created for workers are revoked after worker creation

