import { Channel, decodeFrame, type DeviceInfo, type EventsMessage } from "@speedcrcpy/shared";
import { useEffect, useState } from "react";

function wsUrl(path: string): string {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}${path}`;
}

/** Live device list via /ws/events, auto-reconnecting. */
export function useDeviceList(): DeviceInfo[] | undefined {
  const [devices, setDevices] = useState<DeviceInfo[] | undefined>(undefined);

  useEffect(() => {
    let ws: WebSocket | undefined;
    let retryTimer: number | undefined;
    let closed = false;

    function connect() {
      ws = new WebSocket(wsUrl("/ws/events"));
      ws.binaryType = "arraybuffer";
      ws.onmessage = (event) => {
        const frame = decodeFrame(new Uint8Array(event.data as ArrayBuffer));
        if (frame.channel !== Channel.JSON) return;
        const message = frame.message as EventsMessage;
        if (message.type === "devices") setDevices(message.devices);
      };
      ws.onclose = () => {
        if (!closed) retryTimer = window.setTimeout(connect, 2000);
      };
    }

    connect();
    return () => {
      closed = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      ws?.close();
    };
  }, []);

  return devices;
}
