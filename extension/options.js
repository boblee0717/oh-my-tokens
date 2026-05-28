const ALL_PROVIDERS = ["claude-code", "codex", "deepseek", "cursor"];

async function restore() {
  let s = {};
  try {
    s = await chrome.storage.local.get(["deepseekApiKey", "enabledProviders"]);
  } catch {}
  document.getElementById("deepseekKey").value = s.deepseekApiKey || "";
  const enabled = Array.isArray(s.enabledProviders) ? s.enabledProviders : ALL_PROVIDERS;
  for (const cb of document.querySelectorAll("[data-provider]")) {
    cb.checked = enabled.includes(cb.dataset.provider);
  }
}

document.getElementById("save").addEventListener("click", async () => {
  const deepseekApiKey = document.getElementById("deepseekKey").value.trim();
  const enabledProviders = [...document.querySelectorAll("[data-provider]:checked")].map(
    (cb) => cb.dataset.provider,
  );
  try {
    await chrome.storage.local.set({ deepseekApiKey, enabledProviders });
    const saved = document.getElementById("saved");
    saved.classList.remove("hidden");
    setTimeout(() => saved.classList.add("hidden"), 1500);
  } catch {}
});

restore();
