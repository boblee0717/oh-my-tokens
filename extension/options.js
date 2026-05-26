// The only user-facing setting is the optional DeepSeek key. The native host name
// is fixed (matches install-macos.sh) and the time window is remembered by the popup
// toggle, so neither needs an options field.

async function restore() {
  let s = {};
  try {
    s = await chrome.storage.local.get(["deepseekApiKey"]);
  } catch {}
  document.getElementById("deepseekKey").value = s.deepseekApiKey || "";
}

document.getElementById("save").addEventListener("click", async () => {
  const deepseekApiKey = document.getElementById("deepseekKey").value.trim();
  try {
    await chrome.storage.local.set({ deepseekApiKey });
    const saved = document.getElementById("saved");
    saved.classList.remove("hidden");
    setTimeout(() => saved.classList.add("hidden"), 1500);
  } catch {}
});

restore();
