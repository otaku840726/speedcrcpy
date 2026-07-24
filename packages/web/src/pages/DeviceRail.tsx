import type { DeviceInfo } from "@speedcrcpy/shared";
import { DeviceThumbnail } from "../core/DeviceThumbnail";

/**
 * Device switcher rail. On wide screens it sits persistently to the left of
 * the mirror; on narrow screens it renders as an overlay opened by an edge
 * handle. Each connected device shows a live thumbnail; clicking one switches
 * the session to it without returning to the device list.
 */
export function DeviceRail({
  devices,
  currentSerial,
  onSwitch,
  mode,
  open,
  onClose,
}: {
  devices: DeviceInfo[];
  currentSerial: string;
  onSwitch: (serial: string) => void;
  mode: "persistent" | "overlay";
  open?: boolean;
  onClose?: () => void;
}) {
  const items = devices.map((device, index) => {
    const isCurrent = device.serial === currentSerial;
    return (
      <div
        key={device.serial}
        className={`rail-item${isCurrent ? " current" : ""}`}
        onClick={() => {
          if (!isCurrent) onSwitch(device.serial);
          onClose?.();
        }}
        title={device.name}
      >
        <span className="rail-badge">{index + 1}</span>
        <DeviceThumbnail serial={device.serial} className="rail-thumb" title={device.name} />
        <span className="rail-name">{device.name}</span>
      </div>
    );
  });

  if (mode === "persistent") {
    return <div className="device-rail">{items}</div>;
  }

  // Overlay: a backdrop plus the sliding rail. Rendered only while open.
  if (!open) return null;
  return (
    <div className="rail-overlay" onClick={onClose}>
      <div className="device-rail overlay" onClick={(e) => e.stopPropagation()}>
        {items}
      </div>
    </div>
  );
}
