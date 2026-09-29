/**
 * Typed wrapper over MAX Bridge (`window.WebApp`).
 *
 * Only the methods this product uses are declared, and every one of them is feature-detected:
 * `DeviceStorage`, `shareContent`, `downloadFile`, haptics and biometrics are missing in the web
 * client (https://dev.max.ru/docs/webapps/bridge, checked 24.09.2026), while the hackathon
 * requires the main scenario to work in the web client too. So the app asks the bridge and falls
 * back to plain web behaviour instead of assuming a mobile client.
 */

export type Platform = "ios" | "android" | "desktop" | "web";

interface BackButton {
  show?: () => void;
  hide?: () => void;
  onClick?: (callback: () => void) => void;
  offClick?: (callback: () => void) => void;
}

interface HapticFeedback {
  impactOccurred?: (style: string) => void;
  notificationOccurred?: (type: string) => void;
  selectionChanged?: () => void;
}

interface MaxWebApp {
  initData?: string;
  platform?: string;
  version?: string;
  BackButton?: BackButton;
  HapticFeedback?: HapticFeedback;
  openLink?: (url: string) => void;
  openMaxLink?: (url: string) => void;
  downloadFile?: (url: string, fileName: string) => Promise<unknown> | unknown;
  shareMaxContent?: (params: { text?: string; link?: string }) => Promise<unknown> | unknown;
  enableClosingConfirmation?: () => void;
  disableClosingConfirmation?: () => void;
}

declare global {
  // eslint-disable-next-line no-var
  var WebApp: MaxWebApp | undefined;
}

const app = (): MaxWebApp | undefined => (typeof window === "undefined" ? undefined : window.WebApp);

/** True when the page really runs inside a MAX client: outside it the bridge script still loads, with `initData` null. */
export const insideMax = (): boolean => typeof app()?.initData === "string";

export const platform = (): Platform => {
  const value = app()?.platform;
  return value === "ios" || value === "android" || value === "desktop" || value === "web" ? value : "web";
};

export const clientVersion = (): string | undefined => app()?.version;

/** Raw startup data for the server to verify. Undefined outside MAX. */
export const initData = (): string | undefined => app()?.initData;

/** Opens an external page. Outside MAX a normal tab does the same job. */
export function openLink(url: string): void {
  const bridge = app();
  if (bridge?.openLink) bridge.openLink(url);
  else window.open(url, "_blank", "noopener,noreferrer");
}

/**
 * Saves a file. Inside MAX only `downloadFile` works — an `<a download>` is ignored — and in a
 * browser the opposite is true, so both paths stay.
 */
export async function downloadFile(url: string, fileName: string): Promise<void> {
  const bridge = app();
  // The bridge script loads in a plain browser too, where its calls never settle: MAX only.
  if (insideMax() && bridge?.downloadFile) { await bridge.downloadFile(url, fileName); return; }
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
}

/**
 * Forwards a text to a MAX chat the user picks. `shareMaxContent` works in every MAX client,
 * web included, and needs a user's click (https://dev.max.ru/docs/webapps/bridge, checked
 * 29.09.2026). Outside MAX — false, and the caller copies the text instead.
 */
export async function shareInMax(text: string): Promise<boolean> {
  const bridge = app();
  if (!insideMax() || !bridge?.shareMaxContent) return false;
  await bridge.shareMaxContent({ text });
  return true;
}

/** Wires the native back button; returns a cleanup. Does nothing where the button is absent. */
export function onBack(handler: (() => void) | null): () => void {
  const button = app()?.BackButton;
  if (!button?.onClick || !button.show || !button.hide) return () => {};
  if (handler === null) { button.hide(); return () => {}; }
  button.onClick(handler);
  button.show();
  return () => {
    button.offClick?.(handler);
    button.hide?.();
  };
}

/** Optional polish: silently absent on desktop and web. */
export function tap(kind: "select" | "success" | "warning" = "select"): void {
  const haptic = app()?.HapticFeedback;
  if (kind === "select") haptic?.selectionChanged?.();
  else haptic?.notificationOccurred?.(kind);
}

/** Asks MAX to confirm closing while the user has an unfinished answer on screen. */
export function closingConfirmation(enabled: boolean): void {
  const bridge = app();
  if (enabled) bridge?.enableClosingConfirmation?.();
  else bridge?.disableClosingConfirmation?.();
}
