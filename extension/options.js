const DEFAULT_HOST_NAME = "com.ohmytokens.host";
const VALID_WINDOWS = ["today", "7d", "30d"];

async function restore() {
  let s = {};
  try {
    s = await chrome.storage.local.get(["hostName", "window"]);
  } catch {}
  document.getElementById("hostName").value = s.hostName || DEFAULT_HOST_NAME;
  document.getElementById("defaultWindow").value = s.window || "7d";
}

document.getElementById("save").addEventListener("click", async () => {
  const hostName = document.getElementById("hostName").value.trim() || DEFAULT_HOST_NAME;
  let window = document.getElementById("defaultWindow").value.trim() || "7d";
  if (!VALID_WINDOWS.includes(window)) window = "7d";
  try {
    await chrome.storage.local.set({ hostName, window });
    const saved = document.getElementById("saved");
    saved.classList.remove("hidden");
    setTimeout(() => saved.classList.add("hidden"), 1500);
  } catch {}
});

restore();
