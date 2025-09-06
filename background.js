// Minimal MV3 service worker logic for merging groups.

const DEFAULTS = {
  autoMerge: false,          // when true, dedupe groups by name on changes
  caseSensitive: false,      // title matching
  includeUnnamed: false,     // whether to merge groups with empty titles
  fastMerge: true,           // discard tabs to avoid loading while merging
  keepCollapsed: true,       // keep final merged group collapsed
  scope: "currentWindow"     // "currentWindow" | "allWindows" (MVP uses currentWindow)
};

// Initialize defaults on install
chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.sync.get(Object.keys(DEFAULTS));
  const toSet = {};
  for (const [k, v] of Object.entries(DEFAULTS)) if (stored[k] === undefined) toSet[k] = v;
  if (Object.keys(toSet).length) await chrome.storage.sync.set(toSet);
});

// Simple debounce per window for auto-merge
const debounceTimers = new Map();
function debounceByWindow(windowId, fn, delay = 400) {
  const key = String(windowId);
  const prev = debounceTimers.get(key);
  if (prev) clearTimeout(prev);
  const t = setTimeout(fn, delay);
  debounceTimers.set(key, t);
}

// Track duplicate targets per window: { windowId -> Map<titleKey, {target:number, others:number[]}> }
const duplicateTargets = new Map();

// Track attached listeners to avoid duplicates across settings reloads
let autoHandlerRef = null;
let tabCreatedHandlerRef = null;
let tabUpdatedHandlerRef = null;
let tabGroupHandlersAttached = false;

function normalizeTitle(title, caseSensitive) {
  const t = (title ?? "").trim();
  return caseSensitive ? t : t.toLowerCase();
}

async function listGroups(scope = "currentWindow", windowId) {
  if (typeof windowId === 'number') {
    return await chrome.tabGroups.query({ windowId });
  }
  if (scope === "currentWindow") {
    const current = await chrome.windows.getCurrent();
    return await chrome.tabGroups.query({ windowId: current.id });
  }
  return await chrome.tabGroups.query({});
}

async function listTabsInGroup(groupId) {
  return await chrome.tabs.query({ groupId });
}

async function safeDiscardTabs(tabIds) {
  // Best-effort discard; ignore failures (e.g., active tab or already discarded)
  await Promise.allSettled(tabIds.map(id => chrome.tabs.discard(id)));
}

async function discardNonActiveTabsInGroup(groupId) {
  try {
    const tabs = await listTabsInGroup(groupId);
    const ids = tabs.filter(t => !t.active).map(t => t.id);
    if (ids.length) await safeDiscardTabs(ids);
  } catch {}
}

async function mergeGroupSet(targetGroupId, otherGroupIds, { fastMerge = true } = {}) {
  // Move all tabs from each other group into the target group.
  for (const gid of otherGroupIds) {
    if (gid === targetGroupId) continue;
    const tabs = await listTabsInGroup(gid);
    const tabIds = tabs.map(t => t.id);
    if (fastMerge && tabIds.length) {
      const notActive = tabs.filter(t => !t.active).map(t => t.id);
      if (notActive.length) await safeDiscardTabs(notActive);
    }
    if (tabIds.length) {
      try { await chrome.tabs.group({ tabIds, groupId: targetGroupId }); } catch {}
    }
    // When a group loses all its tabs, the group disappears automatically.
  }
}

async function drainGroupToTarget(targetGroupId, sourceGroupId, { fastMerge = true } = {}) {
  if (targetGroupId === sourceGroupId) return;
  const tabs = await listTabsInGroup(sourceGroupId);
  if (!tabs.length) return;
  if (fastMerge) {
    const notActive = tabs.filter(t => !t.active).map(t => t.id);
    if (notActive.length) await safeDiscardTabs(notActive);
  }
  try { await chrome.tabs.group({ tabIds: tabs.map(t => t.id), groupId: targetGroupId }); } catch {}
}

async function recomputeAndDrainDuplicates(windowId, { caseSensitive, includeUnnamed, fastMerge, keepCollapsed }) {
  const groups = await listGroups("currentWindow", windowId);
  const buckets = new Map();
  for (const g of groups) {
    const key = normalizeTitle(g.title, caseSensitive);
    if (!includeUnnamed && key === "") continue;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(g);
  }
  const index = new Map();
  for (const [key, bucket] of buckets.entries()) {
    if (bucket.length < 2) continue;
    // Pick a stable target early: smallest id (avoids waiting for tab counts)
    bucket.sort((a, b) => a.id - b.id);
    const target = bucket[0];
    const others = bucket.slice(1);
    index.set(key, { target: target.id, others: others.map(g => g.id) });
    // Drain what exists now; safe to call repeatedly as more tabs appear
    for (const src of others) {
      await drainGroupToTarget(target.id, src.id, { fastMerge });
    }
    // Keep collapsed and preserve title as-is
    await chrome.tabGroups.update(target.id, { title: target.title, collapsed: !!keepCollapsed });
  }
  duplicateTargets.set(windowId, index);
}

async function mergeDuplicatesByName({ scope = "currentWindow", windowId = undefined, caseSensitive = false, includeUnnamed = false, fastMerge = true, keepCollapsed = true }) {
  const groups = await listGroups(scope, windowId);
  // Partition by normalized title per window
  const byWindow = new Map();
  for (const g of groups) {
    if (!byWindow.has(g.windowId)) byWindow.set(g.windowId, []);
    byWindow.get(g.windowId).push(g);
  }

  const results = [];

  for (const [windowId, windowGroups] of byWindow.entries()) {
    // Build buckets by normalized title
    const buckets = new Map();
    for (const g of windowGroups) {
      const key = normalizeTitle(g.title, caseSensitive);
      if (!includeUnnamed && key === "") continue;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(g);
    }

    for (const [key, bucket] of buckets.entries()) {
      if (bucket.length < 2) continue; // nothing to merge
      // Choose a target: keep the largest-by-tab-count group to minimize moves
      const counts = await Promise.all(bucket.map(async g => {
        const tabs = await listTabsInGroup(g.id);
        return { group: g, count: tabs.length };
      }));
      counts.sort((a, b) => b.count - a.count);
      const target = counts[0].group;
      const others = counts.slice(1).map(c => c.group);

      // Pre-discard in target to prevent eager loading
      if (fastMerge) {
        try { await discardNonActiveTabsInGroup(target.id); } catch {}
      }
      // Move tabs
      await mergeGroupSet(target.id, others.map(g => g.id), { fastMerge });

      // Normalize the title across the merged group to the most common non-empty title
      const titles = bucket.map(g => (g.title ?? "").trim()).filter(Boolean);
      const titleToSet = titles.length
        ? titles.sort((a, b) =>
            titles.filter(t => t === b).length - titles.filter(t => t === a).length
          )[0]
        : target.title;

      // Set the final title (no-op if already equal)
      await chrome.tabGroups.update(target.id, { title: titleToSet, collapsed: !!keepCollapsed });

      results.push({ windowId, title: titleToSet, mergedInto: target.id, mergedCount: bucket.length - 1 });
    }
  }

  return results;
}

async function mergeSelectedGroups({ targetTitle, groupIds }) {
  if (!Array.isArray(groupIds) || groupIds.length < 2) {
    return { ok: false, error: "Select at least two groups." };
  }

  // All selected groups must belong to the same window for a single target group
  const details = await Promise.all(groupIds.map(id => chrome.tabGroups.get(id)));
  const byWindow = new Map();
  for (const g of details) {
    if (!byWindow.has(g.windowId)) byWindow.set(g.windowId, []);
    byWindow.get(g.windowId).push(g);
  }
  if (byWindow.size > 1) {
    return { ok: false, error: "For now, merge groups from one window at a time." };
  }
  const windowGroups = byWindow.values().next().value;

  // Pick the target group: largest-by-tabs to minimize moves
  const withCounts = await Promise.all(windowGroups.map(async g => {
    const tabs = await listTabsInGroup(g.id);
    return { group: g, count: tabs.length };
  }));
  withCounts.sort((a, b) => b.count - a.count);
  const target = withCounts[0].group;
  const others = withCounts.slice(1).map(x => x.group);

  // Set title first (so user sees it right away)
  const finalTitle = (targetTitle ?? target.title ?? "").trim();
  const { keepCollapsed = true, fastMerge = true } = await chrome.storage.sync.get(["keepCollapsed", "fastMerge"]);
  await chrome.tabGroups.update(target.id, { title: finalTitle, collapsed: !!keepCollapsed });

  // Move all other group tabs into target
  if (fastMerge) {
    try { await discardNonActiveTabsInGroup(target.id); } catch {}
  }
  await mergeGroupSet(target.id, others.map(g => g.id), { fastMerge: !!fastMerge });

  return { ok: true, targetGroupId: target.id, finalTitle, mergedCount: others.length };
}

// (Bookmarks handling removed: Saved Tab Groups are not exposed via extension APIs.)

// Message router for popup
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === "LIST_GROUPS") {
        const { scope = "currentWindow" } = msg;
        const groups = await listGroups(scope);
        // decorate with tab counts
        const enriched = await Promise.all(groups.map(async g => {
          const tabs = await listTabsInGroup(g.id);
          return { ...g, tabCount: tabs.length };
        }));
        sendResponse({ ok: true, groups: enriched });
      } else if (msg.type === "MERGE_DUPLICATES") {
        const { scope = "currentWindow" } = msg;
        const st = await chrome.storage.sync.get(Object.keys(DEFAULTS));
        const caseSensitive = msg.caseSensitive ?? !!st.caseSensitive;
        const includeUnnamed = msg.includeUnnamed ?? !!st.includeUnnamed;
        const fastMerge = msg.fastMerge ?? !!st.fastMerge;
        const keepCollapsed = msg.keepCollapsed ?? !!st.keepCollapsed;
        const resTabs = await mergeDuplicatesByName({ scope, caseSensitive, includeUnnamed, fastMerge, keepCollapsed });
        sendResponse({ ok: true, results: { tabGroups: resTabs } });
      } else if (msg.type === "MERGE_SELECTED") {
        const res = await mergeSelectedGroups({ targetTitle: msg.targetTitle, groupIds: msg.groupIds });
        sendResponse(res);
      } else if (msg.type === "GET_SETTINGS") {
        const st = await chrome.storage.sync.get(Object.keys(DEFAULTS));
        sendResponse({ ok: true, settings: { ...DEFAULTS, ...st } });
      } else if (msg.type === "SET_SETTINGS") {
        await chrome.storage.sync.set(msg.settings || {});
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, error: "Unknown message type." });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
  })();
  // Return true to keep the message channel open for async responses
  return true;
});

// Keyboard shortcut: merge duplicates in current window
chrome.commands.onCommand.addListener(async (cmd) => {
  if (cmd === "merge_same_names_current_window") {
    const { caseSensitive, includeUnnamed, fastMerge, keepCollapsed } = await chrome.storage.sync.get(["caseSensitive", "includeUnnamed", "fastMerge", "keepCollapsed"]);
    await mergeDuplicatesByName({ scope: "currentWindow", caseSensitive: !!caseSensitive, includeUnnamed: !!includeUnnamed, fastMerge: !!fastMerge, keepCollapsed: !!keepCollapsed });
  }
});

// Auto-merge: listen to group changes and debounce per window
async function maybeAttachAutoMergeListeners() {
  const { autoMerge, caseSensitive, includeUnnamed, fastMerge, keepCollapsed } = await chrome.storage.sync.get(["autoMerge", "caseSensitive", "includeUnnamed", "fastMerge", "keepCollapsed"]);
  const enabled = !!autoMerge;

  const handler = (windowId) => {
    if (!enabled) return;
    debounceByWindow(windowId, async () => {
      await recomputeAndDrainDuplicates(windowId, { caseSensitive: !!caseSensitive, includeUnnamed: !!includeUnnamed, fastMerge: !!fastMerge, keepCollapsed: !!keepCollapsed });
    });
  };

  // Remove previously attached listeners (if any) to avoid duplicates
  if (tabGroupHandlersAttached && autoHandlerRef) {
    try {
      chrome.tabGroups.onCreated.removeListener(autoHandlerRef.onGroupCreated);
      chrome.tabGroups.onUpdated.removeListener(autoHandlerRef.onGroupUpdated);
      chrome.tabGroups.onMoved.removeListener(autoHandlerRef.onGroupMoved);
      chrome.tabGroups.onRemoved.removeListener(autoHandlerRef.onGroupRemoved);
      chrome.tabs.onUpdated.removeListener(autoHandlerRef.onTabUpdated);
      chrome.tabs.onMoved.removeListener(autoHandlerRef.onTabMoved);
      chrome.tabs.onDetached.removeListener(autoHandlerRef.onTabDetached);
      chrome.tabs.onAttached.removeListener(autoHandlerRef.onTabAttached);
    } catch {}
    tabGroupHandlersAttached = false;
  }

  // Attach fresh listeners using stable refs
  autoHandlerRef = {
    onGroupCreated: (g) => {
      if (enabled) {
        // Merge quickly on creation without waiting
        debounceByWindow(g.windowId, async () => {
          await recomputeAndDrainDuplicates(g.windowId, { caseSensitive: !!caseSensitive, includeUnnamed: !!includeUnnamed, fastMerge: !!fastMerge, keepCollapsed: !!keepCollapsed });
        }, 80);
      }
      if (fastMerge) setTimeout(() => discardNonActiveTabsInGroup(g.id), 80);
    },
    onGroupUpdated: (g) => handler(g.windowId),
    onGroupMoved: (g) => handler(g.windowId),
    onGroupRemoved: (g) => handler(g.windowId),
    onTabUpdated: (_tabId, _info, tab) => { if (tab.groupId >= 0) handler(tab.windowId); },
    onTabMoved: (_tabId, moveInfo) => handler(moveInfo.windowId),
    onTabDetached: (_tabId, detachInfo) => handler(detachInfo.oldWindowId),
    onTabAttached: (_tabId, attachInfo) => handler(attachInfo.newWindowId),
  };

  chrome.tabGroups.onCreated.addListener(autoHandlerRef.onGroupCreated);
  chrome.tabGroups.onUpdated.addListener(autoHandlerRef.onGroupUpdated);
  chrome.tabGroups.onMoved.addListener(autoHandlerRef.onGroupMoved);
  chrome.tabGroups.onRemoved.addListener(autoHandlerRef.onGroupRemoved);
  chrome.tabs.onUpdated.addListener(autoHandlerRef.onTabUpdated);
  chrome.tabs.onMoved.addListener(autoHandlerRef.onTabMoved);
  chrome.tabs.onDetached.addListener(autoHandlerRef.onTabDetached);
  chrome.tabs.onAttached.addListener(autoHandlerRef.onTabAttached);
  tabGroupHandlersAttached = true;

  // Early discard on tab creation and grouping/loads
  if (tabCreatedHandlerRef) {
    try { chrome.tabs.onCreated.removeListener(tabCreatedHandlerRef); } catch {}
    tabCreatedHandlerRef = null;
  }
  if (tabUpdatedHandlerRef) {
    try { chrome.tabs.onUpdated.removeListener(tabUpdatedHandlerRef); } catch {}
    tabUpdatedHandlerRef = null;
  }
  if (fastMerge) {
    tabCreatedHandlerRef = (tab) => {
      if (!tab || tab.active) return;
      if (typeof tab.id === 'number') {
        void chrome.tabs.discard(tab.id).catch(() => {});
      }
      // If tab is in a duplicate group, move it immediately
      if (typeof tab.groupId === 'number' && tab.groupId >= 0 && typeof tab.windowId === 'number') {
        const st = duplicateTargets.get(tab.windowId);
        if (st) {
          chrome.tabGroups.get(tab.groupId).then(g => {
            const key = normalizeTitle(g.title, caseSensitive);
            const e = st.get(key);
            if (e && e.target && e.target !== g.id) {
              if (typeof tab.id === 'number') {
                void chrome.tabs.group({ tabIds: [tab.id], groupId: e.target }).catch(() => {});
              }
            }
          }).catch(() => {});
        }
      }
    };
    tabUpdatedHandlerRef = (tabId, changeInfo, tab) => {
      const joinedGroup = typeof changeInfo.groupId === 'number' && changeInfo.groupId >= 0;
      const startedLoading = changeInfo.status === 'loading';
      if ((joinedGroup || startedLoading) && tab && !tab.active) {
        if (typeof tabId === 'number') {
          void chrome.tabs.discard(tabId).catch(() => {});
        }
        // If this tab is part of a duplicate group, move it now
        if (typeof tab.windowId === 'number' && typeof tab.groupId === 'number' && tab.groupId >= 0) {
          const st = duplicateTargets.get(tab.windowId);
          if (st) {
            chrome.tabGroups.get(tab.groupId).then(g => {
              const key = normalizeTitle(g.title, caseSensitive);
              const e = st.get(key);
              if (e && e.target && e.target !== g.id) {
                void chrome.tabs.group({ tabIds: [tabId], groupId: e.target }).catch(() => {});
              }
            }).catch(() => {});
          }
        }
      }
    };
    chrome.tabs.onCreated.addListener(tabCreatedHandlerRef);
    chrome.tabs.onUpdated.addListener(tabUpdatedHandlerRef);
  }
}
maybeAttachAutoMergeListeners();

// React to settings changes (turn auto-merge on/off without reload)
chrome.storage.onChanged.addListener((_changes, _area) => {
  // Best-effort: re-run attachment (safe to call again)
  maybeAttachAutoMergeListeners();
});
