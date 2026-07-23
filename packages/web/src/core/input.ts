import type { ClientMessage } from "@speedcrcpy/shared";

/** Android keycodes for physical special keys (printable text goes via IME path). */
const SPECIAL_KEYCODES: Record<string, number> = {
  Enter: 66,
  NumpadEnter: 66,
  Backspace: 67,
  Delete: 112,
  Tab: 61,
  Escape: 111,
  ArrowUp: 19,
  ArrowDown: 20,
  ArrowLeft: 21,
  ArrowRight: 22,
  Home: 122,
  End: 123,
  PageUp: 92,
  PageDown: 93,
};

export interface InputTarget {
  send(message: ClientMessage): void;
}

/** The canvas bitmap dims = the video frame generation currently on screen. */
function videoDims(element: HTMLElement): { vw: number; vh: number } {
  const canvas = element as HTMLCanvasElement;
  return { vw: canvas.width ?? 0, vh: canvas.height ?? 0 };
}

/**
 * Unified pointer/wheel/keyboard capture on the video element.
 * - Pointer Events cover mouse and touch; multi-touch passes through so
 *   pinch/rotate gestures work on touch-screen viewers.
 * - Coordinates are normalized to 0..1 of the canvas box (the canvas box
 *   always equals the rendered video since canvas keeps its aspect ratio).
 * - Move events are coalesced per animation frame.
 * - Right button maps to Android BACK.
 */
export function attachInput(element: HTMLElement, target: InputTarget): () => void {
  // Browser pointerId -> stable small slot id (Android pointer id).
  const pointerSlots = new Map<number, number>();
  const pendingMoves = new Map<number, ClientMessage>();
  let rafId: number | undefined;

  function allocSlot(pointerId: number, isMouse: boolean): number {
    if (isMouse) return -1;
    let slot = 0;
    const used = new Set(pointerSlots.values());
    while (used.has(slot)) slot++;
    pointerSlots.set(pointerId, slot);
    return slot;
  }

  /**
   * Normalize against the RENDERED video content, not the element box:
   * with `object-fit: contain`, letterbox bars appear inside the box whenever
   * its aspect ratio drifts from the video's — coordinates must ignore them.
   */
  function normalized(event: PointerEvent | WheelEvent): { x: number; y: number } {
    const rect = element.getBoundingClientRect();
    const { vw, vh } = videoDims(element);
    let { left, top, width, height } = rect;
    if (vw > 0 && vh > 0 && width > 0 && height > 0) {
      const boxRatio = width / height;
      const videoRatio = vw / vh;
      if (boxRatio > videoRatio) {
        const contentWidth = height * videoRatio;
        left += (width - contentWidth) / 2;
        width = contentWidth;
      } else if (boxRatio < videoRatio) {
        const contentHeight = width / videoRatio;
        top += (height - contentHeight) / 2;
        height = contentHeight;
      }
    }
    return {
      x: Math.min(1, Math.max(0, (event.clientX - left) / width)),
      y: Math.min(1, Math.max(0, (event.clientY - top) / height)),
    };
  }

  function flushMoves(): void {
    rafId = undefined;
    for (const message of pendingMoves.values()) target.send(message);
    pendingMoves.clear();
  }

  function onPointerDown(event: PointerEvent): void {
    if (event.button === 2) {
      target.send({ type: "navigate", key: "back" });
      return;
    }
    // Touch pointers are implicitly captured; explicit capture only helps
    // mouse drags leaving the element. Some mobile browsers throw
    // NotFoundError here — never let that kill the input handler.
    try {
      element.setPointerCapture(event.pointerId);
    } catch {
      // Ignore — input works without explicit capture.
    }
    const isMouse = event.pointerType === "mouse";
    const slot = allocSlot(event.pointerId, isMouse);
    const { x, y } = normalized(event);
    target.send({ type: "touch", action: "down", pointerId: slot, x, y, pressure: event.pressure || 1, ...videoDims(element) });
    event.preventDefault();
  }

  function onPointerMove(event: PointerEvent): void {
    const isMouse = event.pointerType === "mouse";
    if (isMouse && event.buttons === 0) return;
    const slot = isMouse ? -1 : pointerSlots.get(event.pointerId);
    if (slot === undefined) return;
    const { x, y } = normalized(event);
    pendingMoves.set(slot, { type: "touch", action: "move", pointerId: slot, x, y, pressure: event.pressure || 1, ...videoDims(element) });
    rafId ??= requestAnimationFrame(flushMoves);
    event.preventDefault();
  }

  function onPointerEnd(event: PointerEvent): void {
    if (event.button === 2) return;
    const isMouse = event.pointerType === "mouse";
    const slot = isMouse ? -1 : pointerSlots.get(event.pointerId);
    if (slot === undefined) return;
    if (!isMouse) pointerSlots.delete(event.pointerId);
    pendingMoves.delete(slot);
    const { x, y } = normalized(event);
    const action = event.type === "pointercancel" ? "cancel" : "up";
    target.send({ type: "touch", action, pointerId: slot, x, y, pressure: 0, ...videoDims(element) });
    event.preventDefault();
  }

  function onWheel(event: WheelEvent): void {
    const { x, y } = normalized(event);
    // Android scroll values are -1..1 per message; one wheel notch = one tick.
    const dx = Math.max(-1, Math.min(1, -event.deltaX / 100));
    const dy = Math.max(-1, Math.min(1, -event.deltaY / 100));
    if (dx !== 0 || dy !== 0) target.send({ type: "scroll", x, y, dx, dy, ...videoDims(element) });
    event.preventDefault();
  }

  function onContextMenu(event: Event): void {
    event.preventDefault();
  }

  function onKey(event: KeyboardEvent): void {
    if (event.isComposing) return;
    const keycode = SPECIAL_KEYCODES[event.code];
    if (keycode === undefined) return;
    // Printable characters flow through the hidden IME input instead.
    if (event.type === "keydown" && event.key.length === 1 && !event.ctrlKey && !event.metaKey) return;
    target.send({
      type: "key",
      action: event.type === "keydown" ? "down" : "up",
      keycode,
      metaState: 0,
      repeat: event.repeat ? 1 : 0,
    });
    event.preventDefault();
  }

  element.addEventListener("pointerdown", onPointerDown);
  element.addEventListener("pointermove", onPointerMove);
  element.addEventListener("pointerup", onPointerEnd);
  element.addEventListener("pointercancel", onPointerEnd);
  element.addEventListener("wheel", onWheel, { passive: false });
  element.addEventListener("contextmenu", onContextMenu);
  window.addEventListener("keydown", onKey);
  window.addEventListener("keyup", onKey);

  return () => {
    if (rafId !== undefined) cancelAnimationFrame(rafId);
    element.removeEventListener("pointerdown", onPointerDown);
    element.removeEventListener("pointermove", onPointerMove);
    element.removeEventListener("pointerup", onPointerEnd);
    element.removeEventListener("pointercancel", onPointerEnd);
    element.removeEventListener("wheel", onWheel);
    element.removeEventListener("contextmenu", onContextMenu);
    window.removeEventListener("keydown", onKey);
    window.removeEventListener("keyup", onKey);
  };
}
