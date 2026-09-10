import { createServer } from "node:http";
import { parentPort, workerData } from "node:worker_threads";
import { WebSocketServer } from "ws";

const counts = new Int32Array(workerData.counts);
const server = createServer((request, response) => {
  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk) => { body += chunk; });
  request.on("end", () => {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const timer = generate(JSON.parse(body).model, (event) => response.write(`data: ${JSON.stringify(event)}\n\n`), () => response.end());
    response.on("close", () => clearInterval(timer));
  });
});
const sockets = new WebSocketServer({ server });
sockets.on("connection", (socket) => {
  socket.on("message", (data) => {
    const message = JSON.parse(String(data));
    if (message.type !== "response.create") {
      return;
    }
    const timer = generate(message.model, (event) => socket.send(JSON.stringify(event)), () => socket.close());
    socket.on("close", () => clearInterval(timer));
  });
});

/**
 * @param {string} model
 * @param {(event: object) => void} send
 * @param {() => void} close
 */
function generate(model, send, close) {
  Atomics.add(counts, 0, 1);
  send({ type: "response.created", response: { id: "response-local" } });
  let index = 0;
  const timer = setInterval(() => {
    if (model === "silent") {
      return;
    }
    if (workerData.events) {
      if (index < workerData.events.length) {
        const event = workerData.events[index++];
        send(event);
        if (event.type === "response.completed") {
          Atomics.store(counts, 2, 1);
        }
      } else {
        clearInterval(timer);
        if (!workerData.keepOpen) {
          close();
        }
      }
      return;
    }
    if (index === 30) {
      send({ type: "response.completed", response: { id: "response-local", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 30, total_tokens: 31 } } });
      Atomics.store(counts, 2, 1);
      clearInterval(timer);
      close();
      return;
    }
    send({ type: "response.output_text.delta", sequence_number: index, item_id: "message-local", output_index: 0, content_index: 0, delta: `${index}:${"x".repeat(80_000)}` });
    Atomics.add(counts, 1, 1);
    index += 1;
  }, workerData.interval ?? 25);
  return timer;
}

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (address && typeof address === "object") {
    parentPort?.postMessage(`http://127.0.0.1:${address.port}`);
  }
});