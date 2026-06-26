export function updateBannerModel(update) {
  if (!update || update.status === "current") {
    return { visible: false, canUpdate: false, title: "", detail: "" };
  }
  if (update.status === "available") {
    const refs = update.localRef && update.remoteRef ? ` (${update.localRef} -> ${update.remoteRef})` : "";
    return {
      visible: true,
      canUpdate: update.canApply !== false,
      title: "Update available",
      detail: `${update.message || "A newer version is available."}${refs}`,
      tone: "info",
    };
  }
  if (update.status === "applied") {
    return {
      visible: true,
      canUpdate: false,
      title: "Update installed",
      detail: "Reloading the extension. If it does not reopen, reload it from chrome://extensions.",
      tone: "success",
    };
  }
  if (update.status === "applying") {
    return {
      visible: true,
      canUpdate: false,
      title: "Updating oh-my-tokens",
      detail: "Fetching the latest code and reinstalling local components...",
      tone: "info",
    };
  }
  if (update.status === "dirty" || update.status === "checking_failed" || update.status === "apply_failed" || update.status === "not_git_repo") {
    return {
      visible: true,
      canUpdate: false,
      title: "Update check needs attention",
      detail: update.message || "Update check failed.",
      tone: "warn",
    };
  }
  return { visible: false, canUpdate: false, title: "", detail: "" };
}
