# API Binding System

This document describes how the host application (DaydreamX or any other proxy browser) maps its own functions into Helium's `chrome.*` API surface.

## Motivation

Helium does not reimplement browser functionality. Instead, it acts as a translation layer: when an extension calls `chrome.tabs.create({url: "https://example.com"})`, Helium needs to actually create a tab in the host application. The binding system is the mechanism by which the host application tells Helium "when an extension wants to create a tab, call this function."

This decouples Helium from any specific browser UI and makes it reusable across different proxy browser projects.

## Core Concepts

### Handlers

A **handler** is a function registered by the host application to implement a specific Chrome API method. When an extension calls that API method, Helium invokes the registered handler instead of the stub that throws "not implemented."

### Handler Registry

The **handler registry** is a map from API method paths (like `"tabs.create"`) to handler functions. There is one global registry shared across all extensions.

### Handler Signature Contract

Each Chrome API method has an expected input/output contract. The handler must accept the same parameters the Chrome API method documents and return the expected result type. Helium handles callback/Promise wrapping -- the handler always works with async/await.

## API Design

### Registering Handlers

```typescript
import { Helium } from 'helium';

const helium = new Helium();

// Register a single handler
helium.bind('tabs.create', async (createProperties: chrome.tabs.CreateProperties) => {
  // Host app creates a tab using its own logic
  const tab = await myBrowser.tabs.create({
    url: createProperties.url,
    active: createProperties.active ?? true,
    index: createProperties.index,
    pinned: createProperties.pinned ?? false,
  });

  // Return a chrome.tabs.Tab-shaped object
  return {
    id: tab.id,
    index: tab.index,
    windowId: tab.windowId,
    active: tab.active,
    pinned: tab.pinned,
    url: tab.url,
    title: tab.title,
    favIconUrl: tab.favIconUrl,
    status: tab.loading ? 'loading' : 'complete',
    incognito: false,
    highlighted: tab.active,
  };
});

// Register multiple handlers at once
helium.bindAll({
  'tabs.create': async (props) => { /* ... */ },
  'tabs.remove': async (tabIds) => { /* ... */ },
  'tabs.update': async (tabId, updateProps) => { /* ... */ },
  'tabs.query': async (queryInfo) => { /* ... */ },
  'windows.create': async (createData) => { /* ... */ },
  'windows.remove': async (windowId) => { /* ... */ },
});
```

### Handler Invocation Flow

```
Extension calls chrome.tabs.create({url: "https://example.com"})
  │
  ├── Is this a content script context?
  │   YES → Serialize call, send to background via SharedWorker
  │          Background context processes it (below)
  │   NO  → Continue
  │
  ├── Look up handler for "tabs.create" in Handler Registry
  │   NOT FOUND → Use default fallback handler (see Graceful Degradation below)
  │               Fire helium.onBindingMissing('tabs.create')
  │   FOUND     → Continue
  │
  ├── Permission check: does extension have "tabs" permission?
  │   NO  → throw Error("Permission denied: tabs")
  │   YES → Continue
  │
  ├── Invoke handler with (createProperties)
  │   │
  │   ├── Handler is async → await result
  │   └── Handler throws   → propagate error to extension via chrome.runtime.lastError
  │
  ├── Validate return value shape (optional, development mode only)
  │
  └── Return result to extension
      ├── If extension used callback style: callback(result)
      └── If extension used promise style: resolve(result)
```

## Graceful Degradation (Fail-Safe Contract)

Helium defines **default fallback handlers** for all Tier 1 host-bound methods. If the host application does not register a handler, extensions receive a reasonable default response instead of crashing with "not implemented." This ensures that:

1. Extensions degrade gracefully when the host's implementation is incomplete
2. Host developers can incrementally bind methods without breaking extensions
3. The system is resilient to host bugs or missing bindings

### BindingCapabilities Registry

The host declares which methods it actually implements. Helium exposes this as a queryable registry:

```typescript
// Host declares its capabilities during initialization:
helium.declareCapabilities({
  'tabs.create': true,
  'tabs.query': true,
  'tabs.remove': true,
  'windows.getAll': false,     // Explicitly not implemented
  // Omitted methods are assumed unimplemented
});

// Extensions or host code can query capabilities:
const caps = helium.getCapabilities();
// Returns: { 'tabs.create': 'host', 'tabs.query': 'host', 'tabs.remove': 'host',
//            'windows.getAll': 'default', 'bookmarks.create': 'default', ... }
```

### Default Fallback Handlers

Every Tier 1 method has a registered default handler. These defaults are overridden when the host calls `helium.bind()`:

```typescript
const DEFAULT_FALLBACKS: Record<string, (...args: any[]) => any> = {
  // --- Tabs ---
  'tabs.create': async () => {
    throw new HeliumNotImplementedError(
      'chrome.tabs.create',
      'The host application has not implemented tab creation.'
    );
  },
  'tabs.query': async () => [],                       // Empty tab list
  'tabs.get': async (tabId: number) => ({
    id: tabId, index: 0, windowId: 1, active: false,
    pinned: false, highlighted: false, incognito: false,
    status: 'complete', discarded: false, autoDiscardable: true, groupId: -1,
  }),
  'tabs.remove': async () => {},                      // No-op
  'tabs.update': async (tabId, props) => ({ id: tabId, ...props }),
  'tabs.reload': async () => {},                      // No-op
  'tabs.getCurrent': async () => undefined,

  // --- Windows ---
  'windows.getAll': async () => [{
    id: 1, focused: true, top: 0, left: 0, width: 1920, height: 1080,
    tabs: [], incognito: false, type: 'normal', state: 'maximized',
    alwaysOnTop: false,
  }],
  'windows.getCurrent': async () => ({
    id: 1, focused: true, type: 'normal', state: 'maximized',
  }),
  'windows.getLastFocused': async () => ({
    id: 1, focused: true, type: 'normal', state: 'maximized',
  }),
  'windows.create': async () => {
    throw new HeliumNotImplementedError(
      'chrome.windows.create',
      'The host application has not implemented window creation.'
    );
  },
  'windows.remove': async () => {},                   // No-op

  // --- Action (toolbar) ---
  'action.setIcon': async () => {},                   // Store internally, warn
  'action.setBadgeText': async () => {},              // Store internally, warn
  'action.setBadgeBackgroundColor': async () => {},
  'action.setBadgeTextColor': async () => {},
  'action.setTitle': async () => {},
  'action.setPopup': async () => {},
  'action.openPopup': async () => {
    console.warn('[Helium] action.openPopup called but host has not bound it');
  },
  'action.enable': async () => {},
  'action.disable': async () => {},

  // --- Bookmarks / History / Downloads / etc. ---
  'bookmarks.getTree': async () => [],
  'bookmarks.search': async () => [],
  'history.search': async () => [],
  'downloads.download': async () => {
    throw new HeliumNotImplementedError(
      'chrome.downloads.download',
      'The host application has not implemented downloads.'
    );
  },
};

class HeliumNotImplementedError extends Error {
  constructor(method: string, detail: string) {
    super(`${method} is not implemented. ${detail}`);
    this.name = 'HeliumNotImplementedError';
  }
}
```

### onBindingMissing Diagnostic Event

When an extension calls a method with no host-registered handler (and the default fallback is used), Helium fires a diagnostic event:

```typescript
helium.onBindingMissing.addListener((event: {
  method: string;            // e.g. 'tabs.create'
  extensionId: string;       // Which extension tried to call it
  fallbackUsed: boolean;     // Whether a default fallback was used
  timestamp: number;
}) => {
  console.warn(`[Helium] Extension ${event.extensionId} called unbound method: ${event.method}`);
  // Host can use this to discover which bindings extensions need
});
```

### Degradation Behavior Summary

| Method Category | Default Behavior | Rationale |
|----------------|-----------------|-----------|
| **Query methods** (`tabs.query`, `bookmarks.search`, etc.) | Return `[]` (empty) | Extensions handle empty results gracefully |
| **Get methods** (`tabs.get`, `windows.getCurrent`) | Return synthetic placeholder object | Prevents null-reference crashes |
| **Mutating methods** (`tabs.remove`, `action.setIcon`) | No-op (silently succeed) | Extensions assume success, host can implement later |
| **Critical creation methods** (`tabs.create`, `windows.create`) | Throw `HeliumNotImplementedError` | Extensions **must** know creation failed; silent no-op would cause UX bugs |
| **Action state setters** (`setBadgeText`, `setTitle`) | Store state internally | Value is preserved and returned by corresponding getters; host renders when it binds |

### Callback / Promise Duality

Real Chrome APIs support both callback and Promise styles:

```javascript
// Callback style (MV2 and MV3)
chrome.tabs.create({url: "https://example.com"}, function(tab) {
  console.log(tab.id);
});

// Promise style (MV3 only, or MV2 with polyfill)
const tab = await chrome.tabs.create({url: "https://example.com"});
console.log(tab.id);
```

Helium handles this duality automatically. The generated stub methods detect whether the last argument is a function (callback style) and wrap accordingly:

```typescript
// Inside the generated ChromeTabs class (after binding system is wired up):
create(...args: any[]): any {
  const { params, callback } = extractCallbackArg(args, 'tabs.create');

  // Handler lookup includes default fallbacks from Graceful Degradation.
  // The _registry is pre-populated with DEFAULT_FALLBACKS entries, which
  // are overridden when the host calls helium.bind().  There is always a
  // handler present — it may be the host's implementation or the default.
  const handler = this._registry.get('tabs.create')!;

  const promise = handler(...params);

  if (callback) {
    promise.then(
      (result) => callback(result),
      (error) => {
        chrome.runtime.lastError = { message: error.message };
        callback(undefined);
      }
    );
  }

  return promise;
}
```

## Handler Categories

### Category 1: Host-Bound (Requires DaydreamX Integration)

These methods **must** be implemented by the host application because they control browser UI or state that Helium cannot manage independently.

| Namespace | Methods | DaydreamX Source |
|-----------|---------|------------------|
| `tabs` | `create`, `remove`, `update`, `query`, `get`, `getCurrent`, `move`, `reload`, `duplicate`, `highlight`, `goBack`, `goForward`, `group`, `ungroup`, `discard`, `captureVisibleTab`, `detectLanguage` | `TabLifecycle`, `TabManipulation`, `TabPageClient` |
| `windows` | `create`, `remove`, `update`, `get`, `getAll`, `getCurrent`, `getLastFocused` | Window management in DaydreamX |
| `bookmarks` | `create`, `remove`, `update`, `get`, `getTree`, `search`, `move`, `getChildren`, `getRecent`, `getSubTree` | Bookmark manager in DaydreamX |
| `history` | `search`, `getVisits`, `addUrl`, `deleteUrl`, `deleteRange`, `deleteAll` | `TabHistoryIntegration` |
| `downloads` | `download`, `pause`, `resume`, `cancel`, `open`, `show`, `search`, `erase`, `getFileIcon`, `removeFile`, `acceptDanger` | Download manager in DaydreamX |
| `sessions` | `getRecentlyClosed`, `restore`, `getDevices` | Session manager in DaydreamX |
| `contextMenus` | `create`, `update`, `remove`, `removeAll` | Context menu UI in DaydreamX |
| `notifications` | `create`, `update`, `clear`, `getAll`, `getPermissionLevel` | Notification UI in DaydreamX |
| `action` / `browserAction` | `setIcon`, `setBadgeText`, `setTitle`, `setPopup`, `openPopup`, `enable`, `disable`, `getBadgeText`, `getTitle`, `getPopup`, `isEnabled` | Extension toolbar in DaydreamX |

### Category 2: Self-Contained (No Host Binding Needed)

These APIs are fully implemented within Helium itself, using browser primitives (IndexedDB, timers, etc.):

| Namespace | Implementation Strategy |
|-----------|----------------------|
| `storage` | `StorageArea` base class backed by IndexedDB |
| `alarms` | `setTimeout`/`setInterval` + IndexedDB for persistence |
| `i18n` | Message lookup from `_locales/` in extension virtual filesystem |
| `runtime` (most methods) | Manifest access, URL generation, messaging via Layer 3 |
| `permissions` | Permission state tracked in-memory against manifest declarations |
| `declarativeContent` | `DeclarativeEvent` base class with page state matching |

### Category 3: Network-Bound (Requires BareMux Integration)

These APIs hook into the network request/response pipeline via the modified BareMux worker:

| Namespace | Integration Point |
|-----------|------------------|
| `webRequest` | BareMux worker request/response middleware |
| `declarativeNetRequest` | BareMux worker request middleware (rule evaluation) |
| `cookies` | BareMux worker cookie interceptor (Set-Cookie/Cookie headers) + IndexedDB store |

### Category 3b: Injection-Bound (Requires Reflux Integration)

These APIs hook into Reflux's content injection pipeline:

| Namespace | Integration Point |
|-----------|------------------|
| `webNavigation` | BareMux (request-level) + host app callbacks + content script bootstrap (DOM events) |
| `scripting` | Reflux injection plugin (content script registration) + SharedWorker (dynamic injection) |

### Category 4: Hybrid (Partial Host Binding + Partial Self-Contained)

| Namespace | Host-Bound Parts | Self-Contained Parts |
|-----------|-----------------|---------------------|
| `runtime` | `reload` (host restarts extension), `openOptionsPage` (host opens tab) | `getManifest`, `getURL`, `id`, `sendMessage`, `connect`, `onInstalled`, `onMessage`, `onConnect` |
| `tabs` | All CRUD + navigation | `sendMessage`, `connect` (messaging is Layer 3) |
| `management` | `setEnabled`, `uninstall` (host manages extension lifecycle) | `getAll`, `get`, `getSelf`, `getPermissionWarnings` (reads from ExtensionRegistry) |
| `webNavigation` | Navigation commit/error callbacks (host emits) | DOM lifecycle events (from content script bootstrap), history state changes |

## DaydreamX Integration Contract

The host application must implement the following interface to fully power Helium's Tier 1 + Tier 2 APIs:

```typescript
interface HeliumHostBindings {
  // Tab management
  'tabs.create': (props: TabCreateProperties) => Promise<TabInfo>;
  'tabs.remove': (tabIds: number | number[]) => Promise<void>;
  'tabs.update': (tabId: number, props: TabUpdateProperties) => Promise<TabInfo>;
  'tabs.query': (query: TabQueryInfo) => Promise<TabInfo[]>;
  'tabs.get': (tabId: number) => Promise<TabInfo>;
  'tabs.getCurrent': () => Promise<TabInfo | undefined>;
  'tabs.move': (tabIds: number | number[], props: {index: number, windowId?: number}) => Promise<TabInfo | TabInfo[]>;
  'tabs.reload': (tabId?: number, reloadProps?: {bypassCache?: boolean}) => Promise<void>;
  'tabs.duplicate': (tabId: number) => Promise<TabInfo>;
  'tabs.goBack': (tabId?: number) => Promise<void>;
  'tabs.goForward': (tabId?: number) => Promise<void>;
  'tabs.group': (options: {tabIds: number | number[], groupId?: number, createProperties?: {windowId?: number}}) => Promise<number>;
  'tabs.ungroup': (tabIds: number | number[]) => Promise<void>;
  'tabs.highlight': (highlightInfo: {tabs: number | number[], windowId?: number}) => Promise<WindowInfo>;
  'tabs.discard': (tabId?: number) => Promise<TabInfo | undefined>;
  'tabs.captureVisibleTab': (windowId?: number, options?: {format?: string, quality?: number}) => Promise<string>;
  'tabs.detectLanguage': (tabId?: number) => Promise<string>;

  // Window management
  'windows.create': (createData?: WindowCreateData) => Promise<WindowInfo>;
  'windows.remove': (windowId: number) => Promise<void>;
  'windows.update': (windowId: number, updateInfo: WindowUpdateInfo) => Promise<WindowInfo>;
  'windows.get': (windowId: number, getInfo?: {populate?: boolean}) => Promise<WindowInfo>;
  'windows.getAll': (getInfo?: {populate?: boolean, windowTypes?: string[]}) => Promise<WindowInfo[]>;
  'windows.getCurrent': (getInfo?: {populate?: boolean}) => Promise<WindowInfo>;
  'windows.getLastFocused': (getInfo?: {populate?: boolean}) => Promise<WindowInfo>;

  // Action / BrowserAction
  'action.setIcon': (details: {tabId?: number, imageData?: any, path?: string | object}) => Promise<void>;
  'action.setBadgeText': (details: {text: string, tabId?: number}) => Promise<void>;
  'action.setBadgeBackgroundColor': (details: {color: string | number[], tabId?: number}) => Promise<void>;
  'action.setBadgeTextColor': (details: {color: string | number[], tabId?: number}) => Promise<void>;
  'action.setTitle': (details: {title: string, tabId?: number}) => Promise<void>;
  'action.setPopup': (details: {popup: string, tabId?: number}) => Promise<void>;
  'action.openPopup': (options?: {windowId?: number}) => Promise<void>;
  'action.enable': (tabId?: number) => Promise<void>;
  'action.disable': (tabId?: number) => Promise<void>;
  'action.getBadgeText': (details: {tabId?: number}) => Promise<string>;
  'action.getBadgeBackgroundColor': (details: {tabId?: number}) => Promise<number[]>;
  'action.getBadgeTextColor': (details: {tabId?: number}) => Promise<number[]>;
  'action.getTitle': (details: {tabId?: number}) => Promise<string>;
  'action.getPopup': (details: {tabId?: number}) => Promise<string>;
  'action.isEnabled': (tabId?: number) => Promise<boolean>;
  'action.getUserSettings': () => Promise<{isOnToolbar: boolean}>;

  // Bookmarks
  'bookmarks.get': (idOrList: string | string[]) => Promise<BookmarkTreeNode[]>;
  'bookmarks.getTree': () => Promise<BookmarkTreeNode[]>;
  'bookmarks.getChildren': (id: string) => Promise<BookmarkTreeNode[]>;
  'bookmarks.getRecent': (numberOfItems: number) => Promise<BookmarkTreeNode[]>;
  'bookmarks.getSubTree': (id: string) => Promise<BookmarkTreeNode[]>;
  'bookmarks.search': (query: string | {query?: string, url?: string, title?: string}) => Promise<BookmarkTreeNode[]>;
  'bookmarks.create': (bookmark: {parentId?: string, index?: number, title?: string, url?: string}) => Promise<BookmarkTreeNode>;
  'bookmarks.update': (id: string, changes: {title?: string, url?: string}) => Promise<BookmarkTreeNode>;
  'bookmarks.move': (id: string, destination: {parentId?: string, index?: number}) => Promise<BookmarkTreeNode>;
  'bookmarks.remove': (id: string) => Promise<void>;
  'bookmarks.removeTree': (id: string) => Promise<void>;

  // History
  'history.search': (query: {text: string, startTime?: number, endTime?: number, maxResults?: number}) => Promise<HistoryItem[]>;
  'history.getVisits': (details: {url: string}) => Promise<VisitItem[]>;
  'history.addUrl': (details: {url: string, title?: string, visitTime?: number}) => Promise<void>;
  'history.deleteUrl': (details: {url: string}) => Promise<void>;
  'history.deleteRange': (range: {startTime: number, endTime: number}) => Promise<void>;
  'history.deleteAll': () => Promise<void>;

  // Context Menus
  'contextMenus.create': (createProperties: ContextMenuCreateProperties) => number | string;
  'contextMenus.update': (id: number | string, updateProperties: ContextMenuUpdateProperties) => Promise<void>;
  'contextMenus.remove': (menuItemId: number | string) => Promise<void>;
  'contextMenus.removeAll': () => Promise<void>;

  // Notifications
  'notifications.create': (notificationId: string | undefined, options: NotificationOptions) => Promise<string>;
  'notifications.update': (notificationId: string, options: NotificationOptions) => Promise<boolean>;
  'notifications.clear': (notificationId: string) => Promise<boolean>;
  'notifications.getAll': () => Promise<Record<string, boolean>>;
  'notifications.getPermissionLevel': () => Promise<string>;

  // Downloads
  'downloads.download': (options: DownloadOptions) => Promise<number>;
  'downloads.pause': (downloadId: number) => Promise<void>;
  'downloads.resume': (downloadId: number) => Promise<void>;
  'downloads.cancel': (downloadId: number) => Promise<void>;
  'downloads.search': (query: DownloadQuery) => Promise<DownloadItem[]>;
  'downloads.open': (downloadId: number) => Promise<void>;

  // Sessions
  'sessions.getRecentlyClosed': (filter?: {maxResults?: number}) => Promise<Session[]>;
  'sessions.restore': (sessionId?: string) => Promise<Session>;
}
```

## Event Emission

The binding system also works in reverse -- the host application needs to **emit events** when things happen in the browser:

```typescript
// DaydreamX emits events when browser state changes:

// When a new tab is created (e.g., user clicks "New Tab"):
helium.emit('tabs.onCreated', tabInfo);

// When a tab is activated:
helium.emit('tabs.onActivated', { tabId: 123, windowId: 1 });

// When a tab's URL changes:
helium.emit('tabs.onUpdated', tabId, { url: newUrl, status: 'loading' }, tabInfo);

// When a tab is closed:
helium.emit('tabs.onRemoved', tabId, { windowId: 1, isWindowClosing: false });

// When a bookmark is created:
helium.emit('bookmarks.onCreated', bookmarkId, bookmarkNode);

// When navigation completes in a tab:
helium.emit('webNavigation.onCompleted', {
  tabId: 123,
  url: "https://example.com",
  frameId: 0,
  timeStamp: Date.now(),
});
```

**Event routing**: When `helium.emit(...)` is called, the SharedWorker broadcasts the event to all extension contexts that have registered listeners for it (and have the required permissions).

## Permission Enforcement

Before invoking any handler, Helium checks the calling extension's permissions:

```typescript
const PERMISSION_MAP: Record<string, string[]> = {
  'tabs.create':        ['tabs'],
  'tabs.query':         ['tabs'],         // URL/title fields redacted without permission
  'tabs.captureVisibleTab': ['activeTab', 'tabs', '<all_urls>'],
  'bookmarks.create':   ['bookmarks'],
  'bookmarks.remove':   ['bookmarks'],
  'history.search':     ['history'],
  'cookies.get':        ['cookies'],      // + host permission for the cookie's domain
  'downloads.download': ['downloads'],
  'notifications.create': ['notifications'],
  'contextMenus.create': ['contextMenus'],
  'webRequest.onBeforeRequest.addListener': ['webRequest'],  // + host permissions
  'webNavigation.onCompleted.addListener': ['webNavigation'],
  // ...
};
```

**Note**: Some `chrome.tabs` methods work without the `tabs` permission but return limited information (no `url`, `title`, or `favIconUrl` fields). Helium replicates this behavior by stripping sensitive fields from the response when the permission is missing.

## Error Handling

### chrome.runtime.lastError

Chrome extensions use `chrome.runtime.lastError` to detect errors in callback-style calls:

```javascript
chrome.tabs.create({url: "invalid"}, function(tab) {
  if (chrome.runtime.lastError) {
    console.error(chrome.runtime.lastError.message);
    return;
  }
  // success
});
```

Helium sets `chrome.runtime.lastError` before invoking the callback when the handler throws or rejects, and clears it afterward. For Promise-style calls, errors propagate as rejections.

### Unbound Method Errors

If an extension calls a method with no registered handler, the behavior depends on configuration:

- **Strict mode** (default): throws `Error("chrome.tabs.create is not implemented")`
- **Permissive mode**: logs a warning and returns `undefined` (useful for extensions that feature-detect by catching errors)

## Registration Timing

Handlers must be registered **before** any extension contexts are created. The recommended initialization order:

```typescript
// 1. Create Helium instance
const helium = new Helium();

// 2. Register all host bindings
helium.bindAll({ /* ... */ });

// 3. Initialize the message passing backbone
await helium.startMessageRouter();

// 4. Load installed extensions (creates execution contexts)
await helium.loadExtensions();

// 5. Start emitting events from the host application
helium.emit('runtime.onStartup');
```
