const ids = ["autoMerge", "caseSensitive", "includeUnnamed", "fastMerge", "keepCollapsed"];
const els = Object.fromEntries(ids.map(id => [id, document.getElementById(id)]));

async function load() {
  const st = await chrome.runtime.sendMessage({ type: "GET_SETTINGS" });
  const s = st?.settings || {};
  for (const id of ids) els[id].checked = !!s[id];
}
async function save() {
  const settings = {};
  for (const id of ids) settings[id] = !!els[id].checked;
  await chrome.runtime.sendMessage({ type: "SET_SETTINGS", settings });
  const status = document.getElementById("status");
  status.textContent = "Saved.";
  setTimeout(() => status.textContent = "", 1200);
}

document.getElementById("save").addEventListener("click", save);
document.addEventListener("DOMContentLoaded", load);
