import { openUrl } from "@tauri-apps/plugin-opener";
import { inTauri } from "./api";

/** Open a URL in the default browser (never inside the app's own webview). */
export function openExternal(url: string): void {
  if (!/^https?:\/\//.test(url)) return;
  if (inTauri) void openUrl(url);
  else window.open(url, "_blank", "noopener");
}
