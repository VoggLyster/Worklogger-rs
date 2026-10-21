// Platform detection, kept free of imports so any module can use it without creating an import cycle.
export const isMac =
  typeof navigator !== "undefined" &&
  (/Mac|iPhone|iPad|iPod/i.test(navigator.platform || "") || /Mac OS X/i.test(navigator.userAgent || ""));
