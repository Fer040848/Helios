// Helios USB DAC over WebUSB. Port of HeliosDac::HeliosDacUsbDevice (sdk/cpp/HeliosDac.cpp).
//
// Interface 0, alternate setting 1. Control commands are 2-byte interrupt transfers on EP 0x06 (OUT); replies are
// 32-byte interrupt transfers on EP 0x83 (IN). Frames go to bulk EP 0x02 as 7 bytes per point
// (12-bit x/y packed in 3 bytes, then r, g, b, i) followed by pps (LE16), point count (LE16) and flags.

export const HELIOS_FILTER = { vendorId: 0x1209, productId: 0xe500 };
const EP_BULK_OUT = 2, EP_INT_OUT = 6, EP_INT_IN = 3;
const CMD_STOP = 0x01, CMD_SHUTTER = 0x02, CMD_STATUS = 0x03, CMD_FIRMWARE = 0x04, CMD_NAME = 0x05, CMD_SDK_VERSION = 0x07;
const SDK_VERSION = 11;
export const FLAGS_SINGLE_MODE = 2;
export const USB_MAX_POINTS = 0xfff;
const USB_MAX_PPS = 0xffff;
const REPLY_TIMEOUT_MS = 250;
const STATUS_BUDGET_MS = 100;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const unit = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Pack (x, y, r, g, b) float points into the Helios USB frame format. */
export function packFrame(points, pps, flags = FLAGS_SINGLE_MODE) {
  let n = Math.min(points.length, USB_MAX_POINTS);
  pps = Math.max(7, Math.min(USB_MAX_PPS, Math.round(pps)));
  // Firmware quirk handled by the SDK: transfers of (64k + 45) points are shortened by one, pps rescaled.
  if ((n - 45) % 64 === 0) {
    pps = Math.round((pps * (n - 1)) / n);
    n -= 1;
  }
  const buf = new Uint8Array(n * 7 + 5);
  let o = 0;
  for (let i = 0; i < n; i++) {
    const [x, y, r, g, b] = points[i];
    const xi = Math.round(unit((x + 1) / 2) * 0xfff), yi = Math.round(unit((y + 1) / 2) * 0xfff);
    const r8 = Math.round(unit(r) * 255), g8 = Math.round(unit(g) * 255), b8 = Math.round(unit(b) * 255);
    buf[o++] = xi >> 4;
    buf[o++] = ((xi & 0x0f) << 4) | (yi >> 8);
    buf[o++] = yi & 0xff;
    buf[o++] = r8;
    buf[o++] = g8;
    buf[o++] = b8;
    buf[o++] = r8 || g8 || b8 ? 255 : 0;
  }
  buf[o++] = pps & 0xff;
  buf[o++] = pps >> 8;
  buf[o++] = n & 0xff;
  buf[o++] = n >> 8;
  buf[o++] = flags;
  return buf;
}

export class HeliosUsbDac {
  constructor(device, index) {
    this.device = device;
    this.index = index;
    this.name = `Helios USB ${index + 1}`;
    this.kind = "usb";
    this.broken = false;
    this._chain = Promise.resolve();
  }

  /** Serialise every transfer: a frame, a status poll and a blackout never interleave on the wire. */
  run(fn) {
    const next = this._chain.then(fn, fn);
    this._chain = next.catch(() => {});
    return next;
  }

  async _send(bytes) {
    const res = await this.device.transferOut(EP_INT_OUT, new Uint8Array(bytes));
    if (res.status !== "ok") throw new Error(`USB control ${bytes[0]}: ${res.status}`);
  }

  async _reply(expect) {
    for (let tries = 0; tries < 3; tries++) {
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("El DAC no responde")), REPLY_TIMEOUT_MS);
      });
      try {
        const res = await Promise.race([this.device.transferIn(EP_INT_IN, 32), timeout]);
        const data = new Uint8Array(res.data.buffer, res.data.byteOffset, res.data.byteLength);
        if (data[0] === expect) return data;
      } catch (err) {
        this.broken = true; // a reply we stopped waiting for would desync every later one: give up on this device
        throw err;
      } finally {
        clearTimeout(timer);
      }
    }
    throw new Error("Respuesta inesperada del DAC");
  }

  open() {
    return this.run(async () => {
      const d = this.device;
      if (!d.opened) await d.open();
      if (d.configuration === null) await d.selectConfiguration(1);
      await d.claimInterface(0);
      await d.selectAlternateInterface(0, 1);
      await this._send([CMD_FIRMWARE, 0]);
      const fw = await this._reply(0x84);
      this.firmware = fw[1] | (fw[2] << 8) | (fw[3] << 16) | (fw[4] << 24);
      await this._send([CMD_SDK_VERSION, SDK_VERSION]);
      try {
        await this._send([CMD_NAME, 0]);
        const raw = (await this._reply(0x85)).slice(1, 31);
        const end = raw.indexOf(0);
        const name = new TextDecoder().decode(end >= 0 ? raw.slice(0, end) : raw).trim();
        if (name) this.name = name;
      } catch (err) {
        if (this.broken) throw err;
      }
    });
  }

  /** Wait (bounded) for a free buffer, then send the frame; a still-busy DAC drops this frame. */
  write(points, pps) {
    return this.run(async () => {
      const deadline = performance.now() + STATUS_BUDGET_MS;
      for (;;) {
        await this._send([CMD_STATUS, 0]);
        const status = await this._reply(0x83);
        if (status[1] !== 0) break;
        if (performance.now() >= deadline) return false;
        await sleep(1);
      }
      const res = await this.device.transferOut(EP_BULK_OUT, packFrame(points, pps));
      if (res.status !== "ok") throw new Error(`USB frame: ${res.status}`);
      return true;
    });
  }

  stop() {
    return this.run(() => this._send([CMD_STOP, 0]));
  }

  shutter(open) {
    return this.run(() => this._send([CMD_SHUTTER, open ? 1 : 0]));
  }

  close() {
    return this.run(async () => {
      try {
        await this.device.close();
      } catch {
        /* already gone */
      }
    });
  }
}
