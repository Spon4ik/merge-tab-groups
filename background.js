// Minimal MV3 service worker logic for merging groups.

const DEFAULTS = {
  autoMerge: false,          // when true, dedupe groups by name on changes
  caseSensitive: false,      // title matching
  includeUnnamed: false,     // whether to merge groups with empty titles
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

function normalizeTitle(title, caseSensitive) {
  const t = (title ?? "").trim();
  return caseSensitive ? t : t.toLowerCase();
}

async function listGroups(scope = "currentWindow") {
  if (scope === "currentWindow") {
    const current = await chrome.windows.getCurrent();
    return await chrome.tabGroups.query({ windowId: current.id });
  }
  return await chrome.tabGroups.query({});
}

async function listTabsInGroup(groupId) {
  return await chrome.tabs.query({ groupId });
}

async function mergeGroupSet(targetGroupId, otherGroupIds) {
  // Move all tabs from each other group into the target group.
  for (const gid of otherGroupIds) {
    if (gid === targetGroupId) continue;
    const tabs = await listTabsInGroup(gid);
    const tabIds = tabs.map(t => t.id);
    if (tabIds.length) {
      await chrome.tabs.group({ tabIds, groupId: targetGroupId });
    }
    // When a group loses all its tabs, the group disappears automatically.
  }
}

async function mergeDuplicatesByName({ scope = "currentWindow", caseSensitive = false, includeUnnamed = false }) {
  const groups = await listGroups(scope);
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

      // Move tabs
      await mergeGroupSet(target.id, others.map(g => g.id));

      // Normalize the title across the merged group to the most common non-empty title
      const titles = bucket.map(g => (g.title ?? "").trim()).filter(Boolean);
      const titleToSet = titles.length
        ? titles.sort((a, b) =>
            titles.filter(t => t === b).length - titles.filter(t => t === a).length
          )[0]
        : target.title;

      // Set the final title (no-op if already equal)
      await chrome.tabGroups.update(target.id, { title: titleToSet });

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
  await chrome.tabGroups.update(target.id, { title: finalTitle });

  // Move all other group tabs into target
  await mergeGroupSet(target.id, others.map(g => g.id));

  return { ok: true, targetGroupId: target.id, finalTitle, mergedCount: others.length };
}

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
        const { scope = "currentWindow", caseSensitive, includeUnnamed } = msg;
        const res = await mergeDuplicatesByName({ scope, caseSensitive, includeUnnamed });
        sendResponse({ ok: true, results: res });
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
    const { caseSensitive, includeUnnamed } = await chrome.storage.sync.get(["caseSensitive", "includeUnnamed"]);
    await mergeDuplicatesByName({ scope: "currentWindow", caseSensitive: !!caseSensitive, includeUnnamed: !!includeUnnamed });
  }
});

// Auto-merge: listen to group changes and debounce per window
async function maybeAttachAutoMergeListeners() {
  const { autoMerge, caseSensitive, includeUnnamed } = await chrome.storage.sync.get(["autoMerge", "caseSensitive", "includeUnnamed"]);
  const enabled = !!autoMerge;

  const handler = (windowId) => {
    if (!enabled) return;
    debounceByWindow(windowId, async () => {
      await mergeDuplicatesByName({ scope: "currentWindow", caseSensitive: !!caseSensitive, includeUnnamed: !!includeUnnamed });
    });
  };

  // Register (idempotent in MV3)
  chrome.tabGroups.onCreated.addListener(g => handler(g.windowId));
  chrome.tabGroups.onUpdated.addListener((g) => handler(g.windowId));
  chrome.tabGroups.onMoved.addListener((g) => handler(g.windowId));
  chrome.tabGroups.onRemoved.addListener((g) => handler(g.windowId));
  chrome.tabs.onUpdated.addListener((_tabId, _info, tab) => { if (tab.groupId >= 0) handler(tab.windowId); });
  chrome.tabs.onMoved.addListener((_tabId, moveInfo) => handler(moveInfo.windowId));
  chrome.tabs.onDetached.addListener((_tabId, detachInfo) => handler(detachInfo.oldWindowId));
  chrome.tabs.onAttached.addListener((_tabId, attachInfo) => handler(attachInfo.newWindowId));
}
maybeAttachAutoMergeListeners();

// React to settings changes (turn auto-merge on/off without reload)
chrome.storage.onChanged.addListener((_changes, _area) => {
  // Best-effort: re-run attachment (safe to call again)
  maybeAttachAutoMergeListeners();
});
