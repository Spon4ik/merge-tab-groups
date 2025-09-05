const $groups = document.getElementById("groups");
const $refresh = document.getElementById("refresh");
const $mergeDup = document.getElementById("merge-duplicates");
const $mergeSel = document.getElementById("merge-selected");
const $targetTitle = document.getElementById("targetTitle");

async function listGroups() {
  const res = await chrome.runtime.sendMessage({ type: "LIST_GROUPS", scope: "currentWindow" });
  if (!res?.ok) {
    $groups.innerHTML = `<div class="muted">Failed to list groups: ${res?.error || "unknown error"}</div>`;
    return;
  }
  const groups = res.groups.sort((a, b) => (a.title || "").localeCompare(b.title || ""));
  $groups.innerHTML = groups.length
    ? groups.map(g => {
        const name = (g.title || "").trim() || "(unnamed)";
        const color = g.color || "grey";
        return `
          <label class="group-item">
            <span>
              <input type="checkbox" value="${g.id}" />
              <span class="title">${name}</span>
              <span class="muted">— ${g.tabCount} tabs</span>
            </span>
            <span class="muted small">${color}</span>
          </label>
        `;
      }).join("")
    : `<div class="muted">No tab groups in this window.</div>`;
}

$refresh.addEventListener("click", listGroups);

$mergeDup.addEventListener("click", async () => {
  const st = await chrome.runtime.sendMessage({ type: "GET_SETTINGS" });
  const res = await chrome.runtime.sendMessage({
    type: "MERGE_DUPLICATES",
    scope: "currentWindow",
    caseSensitive: !!st?.settings?.caseSensitive,
    includeUnnamed: !!st?.settings?.includeUnnamed
  });
  if (res?.ok) {
    await listGroups();
  } else {
    alert("Failed: " + (res?.error || "unknown"));
  }
});

$mergeSel.addEventListener("click", async () => {
  const boxes = Array.from($groups.querySelectorAll('input[type="checkbox"]'));
  const selected = boxes.filter(b => b.checked).map(b => Number(b.value));
  const title = $targetTitle.value.trim();
  const res = await chrome.runtime.sendMessage({ type: "MERGE_SELECTED", groupIds: selected, targetTitle: title || undefined });
  if (res?.ok) {
    $targetTitle.value = "";
    await listGroups();
  } else {
    alert("Failed: " + (res?.error || "unknown"));
  }
});

document.addEventListener("DOMContentLoaded", listGroups);
