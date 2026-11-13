import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'

// A WebSocket server for tests, on 127.0.0.1, written against RFC 6455 because Node has a WebSocket client but no
// server, and the repository takes no dependency for one. Enough for a relay: text frames of any length (clients
// mask them; servers do not), ping, and close. A client that fragments messages is not served.

/** One connected client: send it text, close the connection cleanly, or drop it with no closing handshake. */
export interface Peer {
  readonly send: (text: string) => void
  readonly close: () => void
  readonly drop: () => void
}

/** What a connection does: its texts, and its end. */
export interface PeerHandlers {
  readonly onText: (text: string) => void
  readonly onEnd?: () => void
}

const handshakeGuid = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const encoder = new TextEncoder()
const decoder = new TextDecoder()

const concat = (...parts: ReadonlyArray<Uint8Array>) => {
  const joined = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  parts.reduce((offset, part) => {
    joined.set(part, offset)
    return offset + part.length
  }, 0)
  return joined
}

/** An unmasked final frame (servers never mask) of `opcode` carrying `payload`. */
const frame = (opcode: number, payload: Uint8Array) => {
  const length = payload.length
  if (length < 126) return concat(Uint8Array.of(0x80 | opcode, length), payload)
  if (length < 65_536) return concat(Uint8Array.of(0x80 | opcode, 126, length >> 8, length & 0xff), payload)
  const header = new Uint8Array(10)
  header.set([0x80 | opcode, 127])
  new DataView(header.buffer).setBigUint64(2, BigInt(length))
  return concat(header, payload)
}

/** The first complete frame in `buffer`: its opcode, unmasked payload and length, or nothing until more arrives. */
const parseFrame = (buffer: Uint8Array) => {
  if (buffer.length < 2) return undefined
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  const opcode = (buffer[0] ?? 0) & 0x0f
  const masked = ((buffer[1] ?? 0) & 0x80) !== 0
  const short = (buffer[1] ?? 0) & 0x7f
  const offset = short === 126 ? 4 : short === 127 ? 10 : 2
  if (buffer.length < offset) return undefined
  const length = short === 126 ? view.getUint16(2) : short === 127 ? Number(view.getBigUint64(2)) : short
  const start = offset + (masked ? 4 : 0)
  if (buffer.length < start + length) return undefined
  const mask = buffer.subarray(offset, offset + 4)
  const payload = buffer
    .slice(start, start + length)
    .map((byte, index) => (masked ? byte ^ (mask[index % 4] ?? 0) : byte))
  return { opcode, payload, size: start + length }
}

const accept = (
  request: IncomingMessage,
  socket: Duplex,
  admit: () => boolean,
  connect: (peer: Peer) => PeerHandlers,
) => {
  const key = request.headers['sec-websocket-key']
  if (typeof key !== 'string' || !admit()) return socket.destroy()
  const answer = createHash('sha1').update(`${key}${handshakeGuid}`).digest('base64')
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${answer}\r\n\r\n`,
  )
  const peer: Peer = {
    send: (text) => void socket.write(frame(0x1, encoder.encode(text))),
    close: () => void socket.end(frame(0x8, new Uint8Array(0))),
    drop: () => void socket.destroy(),
  }
  const handlers = connect(peer)
  let pending = new Uint8Array(0)
  socket.on('data', (chunk: Uint8Array) => {
    pending = concat(pending, chunk)
    for (let next = parseFrame(pending); next !== undefined; next = parseFrame(pending)) {
      pending = pending.subarray(next.size)
      if (next.opcode === 0x1) handlers.onText(decoder.decode(next.payload))
      if (next.opcode === 0x8) peer.close()
      if (next.opcode === 0x9) socket.write(frame(0xa, next.payload))
    }
  })
  socket.on('close', () => handlers.onEnd?.())
  socket.on('error', () => socket.destroy())
}

/**
 * A WebSocket server on a free port of 127.0.0.1. `admit` decides whether to complete each handshake (no: the
 * connection is dropped before it opens); `connect` decides how to treat the connection once open.
 */
export const serveWebSockets = async (admit: () => boolean, connect: (peer: Peer) => PeerHandlers) => {
  const sockets = new Set<Duplex>()
  const server = createServer((_, response) => response.writeHead(426).end())
  server.on('upgrade', (request: IncomingMessage, socket: Duplex) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    accept(request, socket, admit, connect)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  // Listening on a TCP port, the server's address is an `AddressInfo`, never a pipe name or null.
  const address = server.address()
  const port = address !== null && typeof address === 'object' ? address.port : 0
  return {
    url: `ws://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => resolve())
      }),
  }
}
