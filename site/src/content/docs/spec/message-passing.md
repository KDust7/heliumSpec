---
title: Message Passing
description: SharedWorker backbone, mesh relay fallback, and crash recovery.
sidebar:
  order: 3
---

This document describes Helium's inter-context communication system: how extension backgrounds, content scripts, popups, and extension pages send messages to each other.

## Architecture Overview

All Helium execution contexts communicate through a central **SharedWorker** that acts as a message router. This mirrors how Chrome's internal IPC works, but using web APIs.

```
┌─────────────────────────────────────────────────────────────────┐
│                        SharedWorker                             │
│                    (helium-message-router)                       │
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────┐   │
│  │ Tab Registry  │  │ Port Manager │  │ Extension Registry │   │
│  │              │  │              │  │                    │   │
│  │ tabId → {    │  │ portId → {   │  │ extId → {         │   │
│  │   contexts,  │  │   sender,    │  │   manifest,       │   │
│  │   url,       │  │   receiver,  │  │   permissions,    │   │
│  │   title,     │  │   name,      │  │   contexts[],     │   │
│  │   windowId   │  │   extId      │  │ }                 │   │
│  │ }            │  │ }            │  │                    │   │
│  └──────────────┘  └──────────────┘  └────────────────────┘   │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                    Message Router                         │  │
│  │                                                          │  │
│  │  Receives messages from any context via MessagePort      │  │
│  │  Routes to target context(s) based on message type       │  │
│  │  Handles sendMessage, connect, port.postMessage          │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                 │
│  Ports:                                                         │
│  ├── [context-bg-ext1]   ← Background Worker for ext1          │
│  ├── [context-cs-tab42]  ← Content Script in tab 42            │
│  ├── [context-popup-ext1] ← Popup for ext1                     │
│  ├── [context-bg-ext2]   ← Background Worker for ext2          │
│  └── ...                                                        │
└─────────────────────────────────────────────────────────────────┘
```

## SharedWorker Implementation

### Initialization

```typescript
// helium-router.worker.ts (SharedWorker script)

const connections: Map<string, MessagePort> = new Map();
const tabRegistry: TabRegistry = new TabRegistry();
const portManager: PortManager = new PortManager();
const extensionRegistry: ExtensionRegistryWorker = new ExtensionRegistryWorker();

self.addEventListener('connect', (event: MessageEvent) => {
  const port = (event as any).ports[0] as MessagePort;

  port.addEventListener('message', (msg: MessageEvent) => {
    handleMessage(port, msg.data);
  });

  port.start();
});
```

### Context Registration Protocol

When a new execution context is created, it connects to the SharedWorker and sends a registration message:

```typescript
// From the context side:
const sharedWorker = new SharedWorker('/helium/router.worker.js');
const port = sharedWorker.port;

port.postMessage({
  type: '__helium_register',
  contextId: 'ctx-abc123',
  contextType: 'BACKGROUND',  // or CONTENT_SCRIPT, POPUP, etc.
  extensionId: 'ext-abc123',
  tabId: undefined,            // set for content scripts and tab-based pages
  frameId: undefined,          // set for content scripts
  windowId: 1,
});
```

```typescript
// SharedWorker handles registration:
function handleRegister(port: MessagePort, data: RegisterMessage): void {
  connections.set(data.contextId, port);

  extensionRegistry.addContext(data.extensionId, {
    contextId: data.contextId,
    type: data.contextType,
    tabId: data.tabId,
    frameId: data.frameId,
    windowId: data.windowId,
    port,
  });

  if (data.tabId !== undefined) {
    tabRegistry.addContext(data.tabId, data);
  }

  // Acknowledge registration
  port.postMessage({
    type: '__helium_registered',
    contextId: data.contextId,
  });
}
```

## Message Types and Routing

### chrome.runtime.sendMessage (one-shot, within extension)

Extension code:
```javascript
chrome.runtime.sendMessage({ action: "getData" }, function(response) {
  console.log(response);
});
```

Wire protocol:
```typescript
// Content script → SharedWorker
{
  type: 'runtime.sendMessage',
  messageId: 'msg-uuid-1234',       // For correlating response
  senderContextId: 'ctx-cs-tab42',
  extensionId: 'ext-abc123',        // Target extension (own extension)
  payload: { action: "getData" },
}

// SharedWorker routes to background context of ext-abc123:
//   1. Look up extensionRegistry.getBackground('ext-abc123')
//   2. Forward message to that context's port

// SharedWorker → Background context
{
  type: 'runtime.onMessage',
  messageId: 'msg-uuid-1234',
  sender: {
    id: 'ext-abc123',
    url: 'https://example.com/page',
    tab: { id: 42, url: 'https://example.com/page', ... },
    frameId: 0,
  },
  payload: { action: "getData" },
}

// Background calls sendResponse (or returns a value):
// Background → SharedWorker
{
  type: 'runtime.sendMessage.response',
  messageId: 'msg-uuid-1234',
  targetContextId: 'ctx-cs-tab42',
  payload: { data: [1, 2, 3] },
  error: null,
}

// SharedWorker → Content script (original sender)
{
  type: 'runtime.sendMessage.response',
  messageId: 'msg-uuid-1234',
  payload: { data: [1, 2, 3] },
}
```

### chrome.runtime.sendMessage (external, cross-extension)

Same flow but the `extensionId` field targets a different extension. The SharedWorker verifies:
1. Target extension exists and is enabled
2. Target extension's `externally_connectable.ids` includes the sender's extension ID (or is `["*"]`)

### chrome.tabs.sendMessage (background → content script)

Extension code:
```javascript
chrome.tabs.sendMessage(42, { action: "highlight" }, function(response) {
  console.log(response);
});
```

Wire protocol:
```typescript
// Background → SharedWorker
{
  type: 'tabs.sendMessage',
  messageId: 'msg-uuid-5678',
  senderContextId: 'ctx-bg-ext1',
  extensionId: 'ext-abc123',       // Sender's extension
  tabId: 42,
  frameId: 0,                      // Optional, defaults to 0 (main frame)
  payload: { action: "highlight" },
}

// SharedWorker routes:
//   1. Look up tabRegistry.getContentScripts('ext-abc123', tabId: 42)
//   2. If frameId specified, filter to that frame
//   3. Forward to matching content script context(s)
```

### chrome.runtime.connect / chrome.tabs.connect (long-lived ports)

Extension code:
```javascript
// Background opens a port to content script
const port = chrome.tabs.connect(42, { name: "myChannel" });
port.onMessage.addListener((msg) => { console.log(msg); });
port.postMessage({ hello: "world" });
```

Wire protocol:
```typescript
// 1. Background → SharedWorker: Port creation request
{
  type: 'port.create',
  portId: 'port-uuid-1234',
  senderContextId: 'ctx-bg-ext1',
  extensionId: 'ext-abc123',
  target: { tabId: 42 },           // or { extensionId: '...' } for runtime.connect
  name: 'myChannel',
}

// 2. SharedWorker creates port entry and forwards to target
//    SharedWorker → Content script in tab 42:
{
  type: 'port.connected',
  portId: 'port-uuid-1234',
  name: 'myChannel',
  sender: {
    id: 'ext-abc123',
    url: 'chrome-extension://ext-abc123/background.js',
  },
}

// 3. Content script's chrome.runtime.onConnect fires
//    Content script gets a Port object backed by this portId

// 4. Messages flow through SharedWorker:
//    Background → SharedWorker → Content script (and vice versa)
{
  type: 'port.message',
  portId: 'port-uuid-1234',
  senderContextId: 'ctx-bg-ext1',
  payload: { hello: "world" },
}

// 5. Port disconnection:
{
  type: 'port.disconnect',
  portId: 'port-uuid-1234',
  senderContextId: 'ctx-bg-ext1',
}
// SharedWorker notifies the other end → onDisconnect fires
```

## Port Manager

The SharedWorker's Port Manager tracks all active long-lived ports:

```typescript
interface PortEntry {
  portId: string;
  name: string;
  extensionId: string;
  senderContextId: string;
  receiverContextId: string;
  createdAt: number;
}

class PortManager {
  private ports: Map<string, PortEntry> = new Map();

  createPort(request: PortCreateRequest): PortEntry {
    const entry: PortEntry = {
      portId: request.portId,
      name: request.name,
      extensionId: request.extensionId,
      senderContextId: request.senderContextId,
      receiverContextId: '', // set when target accepts
      createdAt: Date.now(),
    };
    this.ports.set(request.portId, entry);
    return entry;
  }

  routeMessage(portId: string, senderContextId: string, payload: any): void {
    const entry = this.ports.get(portId);
    if (!entry) {
      throw new Error(`Port ${portId} not found`);
    }

    // Route to the OTHER end of the port
    const targetContextId = senderContextId === entry.senderContextId
      ? entry.receiverContextId
      : entry.senderContextId;

    const targetPort = connections.get(targetContextId);
    if (targetPort) {
      targetPort.postMessage({
        type: 'port.message',
        portId,
        payload,
      });
    }
  }

  disconnectPort(portId: string, initiatorContextId: string): void {
    const entry = this.ports.get(portId);
    if (!entry) return;

    // Notify the other end
    const otherContextId = initiatorContextId === entry.senderContextId
      ? entry.receiverContextId
      : entry.senderContextId;

    const otherPort = connections.get(otherContextId);
    if (otherPort) {
      otherPort.postMessage({
        type: 'port.disconnected',
        portId,
      });
    }

    this.ports.delete(portId);
  }

  // Clean up all ports for a context that is being destroyed
  cleanupContext(contextId: string): void {
    for (const [portId, entry] of this.ports) {
      if (entry.senderContextId === contextId || entry.receiverContextId === contextId) {
        this.disconnectPort(portId, contextId);
      }
    }
  }
}
```

## Tab Registry

The Tab Registry maps tab IDs to metadata and associated contexts:

```typescript
interface TabRegistryEntry {
  tabId: number;
  windowId: number;
  url: string;
  title: string;
  active: boolean;
  contexts: Map<string, ContextRegistryEntry>;  // contextId → context
}

class TabRegistry {
  private tabs: Map<number, TabRegistryEntry> = new Map();
  private nextTabId: number = 1;

  // Called by host application when a tab is created
  registerTab(info: { windowId: number; url: string; title: string; active: boolean }): number {
    const tabId = this.nextTabId++;
    this.tabs.set(tabId, {
      tabId,
      windowId: info.windowId,
      url: info.url,
      title: info.title,
      active: info.active,
      contexts: new Map(),
    });
    return tabId;
  }

  // Called when a content script registers itself
  addContext(tabId: number, context: ContextRegistryEntry): void {
    const tab = this.tabs.get(tabId);
    if (tab) {
      tab.contexts.set(context.contextId, context);
    }
  }

  // Called by host application when tab URL changes
  updateTab(tabId: number, changes: Partial<TabRegistryEntry>): void {
    const tab = this.tabs.get(tabId);
    if (tab) {
      Object.assign(tab, changes);
    }
  }

  // Get all content scripts for a specific extension in a specific tab
  getContentScripts(extensionId: string, tabId: number, frameId?: number): ContextRegistryEntry[] {
    const tab = this.tabs.get(tabId);
    if (!tab) return [];

    return Array.from(tab.contexts.values()).filter(ctx =>
      ctx.extensionId === extensionId &&
      ctx.type === ContextType.CONTENT_SCRIPT &&
      (frameId === undefined || ctx.frameId === frameId)
    );
  }

  // Get tab info for populating chrome.runtime.MessageSender.tab
  getTabInfo(tabId: number): TabInfo | undefined {
    const tab = this.tabs.get(tabId);
    if (!tab) return undefined;

    return {
      id: tab.tabId,
      windowId: tab.windowId,
      url: tab.url,
      title: tab.title,
      active: tab.active,
      // Additional fields populated by host bindings
    };
  }

  removeTab(tabId: number): void {
    const tab = this.tabs.get(tabId);
    if (tab) {
      // Clean up all contexts for this tab
      for (const ctx of tab.contexts.values()) {
        portManager.cleanupContext(ctx.contextId);
        connections.delete(ctx.contextId);
      }
      this.tabs.delete(tabId);
    }
  }
}
```

## Sender Object Construction

The `chrome.runtime.MessageSender` object that listeners receive includes information about who sent the message:

```typescript
interface MessageSender {
  id?: string;           // Extension ID of the sender
  url?: string;          // URL of the sending context
  tab?: TabInfo;         // Tab info (if sent from a content script or tab page)
  frameId?: number;      // Frame ID (if sent from a content script)
  tlsChannelId?: string; // Not supported in Helium
}

function buildSender(contextEntry: ContextRegistryEntry): MessageSender {
  const sender: MessageSender = {
    id: contextEntry.extensionId,
  };

  if (contextEntry.tabId !== undefined) {
    sender.tab = tabRegistry.getTabInfo(contextEntry.tabId);
  }

  if (contextEntry.frameId !== undefined) {
    sender.frameId = contextEntry.frameId;
  }

  // URL depends on context type
  switch (contextEntry.type) {
    case ContextType.BACKGROUND:
      sender.url = `chrome-extension://${contextEntry.extensionId}/_generated_background_page.html`;
      break;
    case ContextType.CONTENT_SCRIPT:
      sender.url = contextEntry.url;  // The page URL where the content script is running
      break;
    case ContextType.POPUP:
      sender.url = `chrome-extension://${contextEntry.extensionId}/popup.html`;
      break;
    default:
      sender.url = contextEntry.url;
  }

  return sender;
}
```

## Client-Side Port Implementation

This is the `Port` object that extension code interacts with:

```typescript
class HeliumPort {
  readonly name: string;
  readonly sender?: MessageSender;
  readonly onMessage: ChromeEvent = new ChromeEvent();
  readonly onDisconnect: ChromeEvent = new ChromeEvent();

  private portId: string;
  private routerPort: MessagePort;  // Connection to SharedWorker
  private disconnected: boolean = false;

  constructor(portId: string, name: string, routerPort: MessagePort, sender?: MessageSender) {
    this.portId = portId;
    this.name = name;
    this.routerPort = routerPort;
    this.sender = sender;
  }

  postMessage(message: any): void {
    if (this.disconnected) {
      throw new Error('Attempting to use a disconnected port object');
    }

    this.routerPort.postMessage({
      type: 'port.message',
      portId: this.portId,
      payload: message,
    });
  }

  disconnect(): void {
    if (this.disconnected) return;
    this.disconnected = true;

    this.routerPort.postMessage({
      type: 'port.disconnect',
      portId: this.portId,
    });

    this.onDisconnect.dispatch(this);
  }

  // Called by the runtime when a port.message arrives for this port
  _handleMessage(payload: any): void {
    this.onMessage.dispatch(payload, this);
  }

  // Called by the runtime when a port.disconnected arrives for this port
  _handleDisconnect(): void {
    this.disconnected = true;
    this.onDisconnect.dispatch(this);
  }
}
```

## sendMessage with sendResponse

The `chrome.runtime.onMessage` listener can respond asynchronously by returning `true` and calling `sendResponse` later:

```javascript
// In background:
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "fetchData") {
    // Return true to indicate async response
    fetch("https://api.example.com/data")
      .then(res => res.json())
      .then(data => sendResponse({ data }));
    return true;  // Keep the message channel open
  }
});
```

Helium handles this by:

1. The `onMessage` dispatch includes a `sendResponse` callback
2. If any listener returns `true`, the message channel stays open (the SharedWorker holds the response route)
3. When `sendResponse` is called, the response is sent back through the SharedWorker
4. If no listener returns `true` and no listener calls `sendResponse` synchronously, the channel closes

```typescript
// In the receiving context's chrome.runtime.onMessage dispatch:
function dispatchOnMessage(
  payload: any,
  sender: MessageSender,
  messageId: string,
  routerPort: MessagePort
): void {
  let responseSent = false;
  let keepOpen = false;
  let responseTimeoutTimer: ReturnType<typeof setTimeout> | null = null;

  const sendResponse = (response: any) => {
    if (responseSent) {
      // Chrome logs a warning when sendResponse is called
      // after the message channel has already been closed or responded to.
      console.warn(
        '[Helium] sendResponse was called after the message port was closed. ' +
        'This typically means sendResponse was called more than once, or ' +
        'after the onMessage listener returned without indicating async intent.'
      );
      return;
    }
    responseSent = true;

    // Clear the async response timeout if one was set
    if (responseTimeoutTimer) {
      clearTimeout(responseTimeoutTimer);
      responseTimeoutTimer = null;
    }

    routerPort.postMessage({
      type: 'runtime.sendMessage.response',
      messageId,
      payload: response,
    });
  };

  // Dispatch to all listeners
  for (const listener of chrome.runtime.onMessage._listeners) {
    try {
      const result = listener(payload, sender, sendResponse);
      if (result === true) {
        keepOpen = true;
      }
      // If result is a Promise (MV3), treat it as async response
      if (result && typeof result.then === 'function') {
        keepOpen = true;
        result.then(
          (response: any) => {
            if (response !== undefined) sendResponse(response);
          },
          (error: any) => {
            if (!responseSent) {
              responseSent = true;
              if (responseTimeoutTimer) {
                clearTimeout(responseTimeoutTimer);
                responseTimeoutTimer = null;
              }
              routerPort.postMessage({
                type: 'runtime.sendMessage.response',
                messageId,
                error: error.message,
              });
            }
          }
        );
      }
    } catch (e) {
      console.error('Error in onMessage listener:', e);
    }
  }

  // If no listener kept the channel open, close it
  if (!keepOpen && !responseSent) {
    sendResponse(undefined);
  }

  // If a listener indicated async response (returned true)
  // but never calls sendResponse, the channel stays open forever.
  // Set a timeout matching Chrome's ~5 minute limit to auto-close.
  if (keepOpen && !responseSent) {
    responseTimeoutTimer = setTimeout(() => {
      if (!responseSent) {
        console.warn(
          `[Helium] Message channel for ${messageId} timed out after 300s ` +
          'without sendResponse being called. Auto-closing with undefined.'
        );
        // Set lastError so the sender knows the response timed out
        routerPort.postMessage({
          type: 'runtime.sendMessage.response',
          messageId,
          payload: undefined,
          error: 'The message port closed before a response was received.',
        });
        responseSent = true;
      }
    }, 300_000); // 5 minutes, matching Chrome's behavior
  }
}
```

## Mesh Relay Fallback (SharedWorker Unavailable)

If `SharedWorker` is unavailable (blocked by browser policy, third-party context restrictions, or mobile WebView), Helium falls back to a **decentralized mesh relay** built on `BroadcastChannel` with guaranteed delivery semantics.

### Design Goals

| Concern | SharedWorker Mode | Mesh Relay Mode |
|---------|-------------------|-----------------|
| Delivery guarantee | Implicit (direct `MessagePort`) | ACK/retry protocol |
| Backpressure | Implicit (port buffering) | Send queue with high-water mark |
| Registry coordination | Centralized in SharedWorker | Leader election (one context owns registries) |
| Duplicate detection | Not needed | Sequence numbers per sender |

### Leader Election

One context is elected as the **relay leader**, responsible for maintaining the in-memory Tab Registry, Port Manager, and Extension Registry — the same data structures the SharedWorker normally holds.

```typescript
class MeshRelay {
  private channel = new BroadcastChannel('helium-mesh');
  private isLeader = false;
  private leaderId: string | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private electionTimeout: ReturnType<typeof setTimeout> | null = null;

  // --- Leader Election (Bully Algorithm) ---

  startElection(): void {
    // Broadcast election bid with this context's priority (lowest contextId wins)
    this.channel.postMessage({
      type: '__mesh_election',
      candidateId: this.contextId,
      timestamp: Date.now(),
    });

    // If no higher-priority candidate responds within 2s, declare self leader
    this.electionTimeout = setTimeout(() => {
      this.becomeLeader();
    }, 2000);
  }

  private becomeLeader(): void {
    this.isLeader = true;
    this.leaderId = this.contextId;

    // Initialize registries (same as SharedWorker would)
    this.tabRegistry = new TabRegistry();
    this.portManager = new PortManager();
    this.extensionRegistry = new ExtensionRegistryWorker();

    // Announce leadership
    this.channel.postMessage({
      type: '__mesh_leader_announce',
      leaderId: this.contextId,
    });

    // Start heartbeat (every 5s)
    this.heartbeatInterval = setInterval(() => {
      this.channel.postMessage({
        type: '__mesh_leader_heartbeat',
        leaderId: this.contextId,
        timestamp: Date.now(),
      });
    }, 5000);
  }

  // If leader heartbeat not received within 10s, trigger new election
  private monitorLeader(): void {
    let lastHeartbeat = Date.now();

    this.channel.addEventListener('message', (event) => {
      if (event.data.type === '__mesh_leader_heartbeat') {
        lastHeartbeat = Date.now();
      }
    });

    setInterval(() => {
      if (!this.isLeader && Date.now() - lastHeartbeat > 10_000) {
        this.startElection();
      }
    }, 5000);
  }
}
```

### ACK/Retry Protocol (Guaranteed Delivery)

Every message sent through the mesh includes a unique `messageUid` and a monotonic `sequenceNumber`. The recipient must ACK within a timeout window, or the sender retries.

```typescript
interface MeshEnvelope {
  messageUid: string;           // UUID for deduplication
  sequenceNumber: number;       // Per-sender monotonic counter
  senderContextId: string;
  targetContextId?: string;     // Omitted for broadcast-to-leader
  payload: any;                 // The actual Helium message
  attempt: number;              // Retry attempt (1-based)
  timestamp: number;
}

class ReliableSender {
  private sequenceCounter = 0;
  private pendingAcks: Map<string, {
    envelope: MeshEnvelope;
    timer: ReturnType<typeof setTimeout>;
    resolve: () => void;
    reject: (err: Error) => void;
  }> = new Map();

  private readonly MAX_RETRIES = 3;
  private readonly BASE_TIMEOUT_MS = 500; // Exponential backoff base

  async send(target: string | undefined, payload: any): Promise<void> {
    const envelope: MeshEnvelope = {
      messageUid: crypto.randomUUID(),
      sequenceNumber: ++this.sequenceCounter,
      senderContextId: this.contextId,
      targetContextId: target,
      payload,
      attempt: 1,
      timestamp: Date.now(),
    };

    return this.sendWithRetry(envelope);
  }

  private sendWithRetry(envelope: MeshEnvelope): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeoutMs = this.BASE_TIMEOUT_MS * Math.pow(2, envelope.attempt - 1);

      const timer = setTimeout(() => {
        this.pendingAcks.delete(envelope.messageUid);

        if (envelope.attempt < this.MAX_RETRIES) {
          // Retry with incremented attempt
          envelope.attempt++;
          this.sendWithRetry(envelope).then(resolve, reject);
        } else {
          reject(new Error(
            `Message ${envelope.messageUid} not ACKed after ${this.MAX_RETRIES} attempts`
          ));
        }
      }, timeoutMs);

      this.pendingAcks.set(envelope.messageUid, { envelope, timer, resolve, reject });
      this.channel.postMessage(envelope);
    });
  }

  handleAck(messageUid: string): void {
    const pending = this.pendingAcks.get(messageUid);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingAcks.delete(messageUid);
      pending.resolve();
    }
  }
}
```

### Backpressure (Send Queue)

Each context maintains a bounded send queue. When the queue exceeds the high-water mark, the sender pauses until ACKs drain the queue below the low-water mark.

```typescript
class BackpressuredSender extends ReliableSender {
  private readonly HIGH_WATER_MARK = 64;   // Pause sending above this
  private readonly LOW_WATER_MARK = 16;    // Resume sending below this
  private paused = false;
  private waitQueue: Array<{ envelope: MeshEnvelope; resolve: () => void; reject: (e: Error) => void }> = [];

  override async send(target: string | undefined, payload: any): Promise<void> {
    if (this.paused) {
      // Queue the message and wait for backpressure to clear
      return new Promise((resolve, reject) => {
        this.waitQueue.push({ envelope: this.buildEnvelope(target, payload), resolve, reject });
      });
    }

    await super.send(target, payload);

    if (this.pendingAcks.size >= this.HIGH_WATER_MARK) {
      this.paused = true;
    }
  }

  override handleAck(messageUid: string): void {
    super.handleAck(messageUid);

    // Check if backpressure can be released
    if (this.paused && this.pendingAcks.size <= this.LOW_WATER_MARK) {
      this.paused = false;
      this.drainWaitQueue();
    }
  }

  private drainWaitQueue(): void {
    while (this.waitQueue.length > 0 && !this.paused) {
      const queued = this.waitQueue.shift()!;
      this.sendWithRetry(queued.envelope).then(queued.resolve, queued.reject);
    }
  }
}
```

### Duplicate Detection

The receiver tracks the last seen sequence number per sender. Messages with a sequence number ≤ the last seen are silently dropped (they are retransmissions of already-processed messages).

```typescript
class DuplicateFilter {
  private lastSeen: Map<string, number> = new Map(); // senderId → last seqNo

  isDuplicate(envelope: MeshEnvelope): boolean {
    const lastSeq = this.lastSeen.get(envelope.senderContextId) ?? 0;
    if (envelope.sequenceNumber <= lastSeq) {
      return true; // Already processed
    }
    this.lastSeen.set(envelope.senderContextId, envelope.sequenceNumber);
    return false;
  }
}
```

### Mode Detection and Switchover

```typescript
function createMessageBackbone(): MessageBackbone {
  try {
    const sw = new SharedWorker('/helium/router.worker.js');
    sw.port.start();
    // If SharedWorker connects successfully, use direct MessagePort routing
    return new SharedWorkerBackbone(sw);
  } catch (e) {
    console.warn('[Helium] SharedWorker unavailable, falling back to mesh relay:', e);
    return new MeshRelayBackbone();
  }
}
```

The `MeshRelayBackbone` implements the same `MessageBackbone` interface as `SharedWorkerBackbone`, so all higher-level code (messaging APIs, port management) works identically regardless of the active transport.

## Tab Registry Crash Recovery

The SharedWorker maintains an in-memory Tab Registry that maps tab IDs to context IDs, URLs, titles, and connection ports. If the SharedWorker crashes or is killed by the browser, this registry is lost. Helium addresses this with a **3-layer recovery mechanism**:

### 1. Periodic IndexedDB Snapshots

The SharedWorker periodically snapshots the tab registry to IndexedDB (every 10 seconds):

```typescript
class PersistentTabRegistry {
  private snapshotTimer: ReturnType<typeof setInterval>;
  private registry: Map<number, TabRegistryEntry> = new Map();
  private dirty = false;

  startPeriodicSnapshot(): void {
    this.snapshotTimer = setInterval(async () => {
      if (!this.dirty) return;

      const snapshot = {
        timestamp: Date.now(),
        entries: Array.from(this.registry.entries()),
      };

      const db = await openDB('helium-system', 1);
      await db.put('tab-registry-snapshots', snapshot, 'latest');

      this.dirty = false;
    }, 10_000); // Every 10 seconds
  }

  set(tabId: number, entry: TabRegistryEntry): void {
    this.registry.set(tabId, entry);
    this.dirty = true;
  }

  delete(tabId: number): void {
    this.registry.delete(tabId);
    this.dirty = true;
  }
}
```

### 2. Re-Registration Protocol

On SharedWorker restart, it loads the last snapshot as a starting point, then broadcasts a re-registration request. All live contexts re-announce themselves:

```typescript
// SharedWorker startup:
async function recoverTabRegistry(): Promise<void> {
  const db = await openDB('helium-system', 1);
  const snapshot = await db.get('tab-registry-snapshots', 'latest');

  if (snapshot) {
    // Load snapshot as initial state
    for (const [tabId, entry] of snapshot.entries) {
      tabRegistry.set(tabId, entry);
    }
    console.log(`[Helium] Recovered ${snapshot.entries.length} tab entries from snapshot`);
  }

  // Broadcast re-registration request to all live contexts
  const reRegChannel = new BroadcastChannel('helium-re-register');
  reRegChannel.postMessage({ type: '__helium_re_register', timestamp: Date.now() });
}

// Content script / extension page side:
const reRegChannel = new BroadcastChannel('helium-re-register');
reRegChannel.onmessage = (event) => {
  if (event.data.type === '__helium_re_register') {
    // Re-announce this context to the new SharedWorker
    routerPort.postMessage({
      type: '__helium_register',
      contextId: myContextId,
      contextType: myContextType,
      extensionId: myExtensionId,
      tabId: myTabId,
      frameId: myFrameId,
      url: location.href,
    });
  }
};
```

### 3. Heartbeat Liveness Detection

Contexts send periodic heartbeats; the SharedWorker evicts contexts that haven't heartbeated within 30 seconds:

```typescript
// Context side: send heartbeat every 15 seconds
setInterval(() => {
  routerPort.postMessage({
    type: '__helium_heartbeat',
    contextId: myContextId,
    timestamp: Date.now(),
  });
}, 15_000);

// SharedWorker side: evict stale contexts
class ContextLivenessMonitor {
  private lastHeartbeat: Map<string, number> = new Map();
  private readonly EVICTION_THRESHOLD_MS = 30_000;

  recordHeartbeat(contextId: string): void {
    this.lastHeartbeat.set(contextId, Date.now());
  }

  startEvictionLoop(): void {
    setInterval(() => {
      const now = Date.now();
      for (const [contextId, lastSeen] of this.lastHeartbeat) {
        if (now - lastSeen > this.EVICTION_THRESHOLD_MS) {
          console.warn(`[Helium] Evicting stale context: ${contextId}`);
          this.lastHeartbeat.delete(contextId);
          tabRegistry.removeByContextId(contextId);
          connections.delete(contextId);
        }
      }
    }, 10_000);
  }
}
```

## Message Flow Diagrams

### runtime.sendMessage (Content Script → Background → Response)

```
Content Script              SharedWorker                Background
     │                          │                          │
     │─── runtime.sendMessage ──→                          │
     │    {msgId, payload}      │                          │
     │                          │─── runtime.onMessage ────→
     │                          │    {msgId, sender,       │
     │                          │     payload}             │
     │                          │                          │
     │                          │     ← sendResponse ──────│
     │                          │       {msgId, response}  │
     │                          │                          │
     │← runtime.sendMessage.    │                          │
     │   response ──────────────│                          │
     │   {msgId, response}      │                          │
```

### runtime.connect (Background → Content Script, bidirectional)

```
Background                  SharedWorker                Content Script
     │                          │                          │
     │─── port.create ─────────→                          │
     │    {portId, name,        │                          │
     │     target: {tabId}}     │                          │
     │                          │─── port.connected ──────→
     │                          │    {portId, name,        │
     │                          │     sender}              │
     │                          │                          │
     │                          │     (onConnect fires,    │
     │                          │      returns Port)       │
     │                          │                          │
     │─── port.message ────────→                          │
     │    {portId, payload}     │─── port.message ────────→
     │                          │    {portId, payload}     │
     │                          │                          │
     │                          │← port.message ───────────│
     │← port.message ──────────│    {portId, payload}     │
     │    {portId, payload}     │                          │
     │                          │                          │
     │─── port.disconnect ─────→                          │
     │    {portId}              │─── port.disconnected ───→
     │                          │    {portId}              │
```

## Host Application Event Emission

The host application (DaydreamX) emits events through the SharedWorker to notify extensions of browser state changes:

```typescript
// DaydreamX → SharedWorker
{
  type: '__helium_host_event',
  event: 'tabs.onCreated',
  data: { id: 5, url: 'about:blank', windowId: 1, active: true, ... },
}

// SharedWorker processes:
//   1. Update tab registry
//   2. For each extension with 'tabs' permission:
//      Forward event to all contexts that have onCreated listeners
```

Events that the host must emit:

| Event | Required Data |
|-------|---------------|
| `tabs.onCreated` | Full TabInfo object |
| `tabs.onRemoved` | `tabId`, `{windowId, isWindowClosing}` |
| `tabs.onUpdated` | `tabId`, `changeInfo`, full TabInfo |
| `tabs.onActivated` | `{tabId, windowId}` |
| `tabs.onMoved` | `tabId`, `{windowId, fromIndex, toIndex}` |
| `tabs.onAttached` | `tabId`, `{newWindowId, newPosition}` |
| `tabs.onDetached` | `tabId`, `{oldWindowId, oldPosition}` |
| `windows.onCreated` | Full WindowInfo object |
| `windows.onRemoved` | `windowId` |
| `windows.onFocusChanged` | `windowId` |
| `bookmarks.onCreated` | `id`, BookmarkTreeNode |
| `bookmarks.onRemoved` | `id`, `{parentId, index, node}` |
| `bookmarks.onChanged` | `id`, `{title, url}` |
| `history.onVisited` | HistoryItem |
| `history.onVisitRemoved` | `{allHistory, urls}` |

