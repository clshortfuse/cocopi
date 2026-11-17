import { Buffer } from "node:buffer";
import WebSocket from "ws";

const FRAME_BYTES = 1024 * 1024;

/**
 * @param {globalThis.WebSocket | WebSocket} socket
 * @param {string} message
 * @returns {Promise<void>}
 */
export async function sendWebSocketText(socket, message) {
  // Native WebSocket has no frame controls or write callbacks; production uses ws.
  if (!(socket instanceof WebSocket)) {
    socket.send(message);
    return;
  }
  const bytes = Buffer.from(message);
  for (let offset = 0; offset < Math.max(bytes.length, 1); offset += FRAME_BYTES) {
    if (socket.readyState !== WebSocket.OPEN) {
      throw new Error("Codex WebSocket closed during request upload.");
    }
    const end = Math.min(offset + FRAME_BYTES, bytes.length);
    await /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
      socket.send(bytes.subarray(offset, end), { binary: false, fin: end === bytes.length }, (error) => {
        if (error) reject(error);
        else resolve();
      });
    }));
  }
}
