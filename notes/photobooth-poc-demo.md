# Photobooth POC – manual scan demo

## Dev Connect

1. On your laptop, from `connect/`: `pnpm start:host`
2. Note the **Network** URL (e.g. `http://192.168.4.22:3000`).

## Device (comma four / mici)

1. Device **offroad**, on the **same Wi‑Fi** as the phone.
2. Set Connect origin if needed: param `PhotoboothConnectHost` or env `CONNECT_HOST` to your laptop’s Network URL (no trailing slash).
3. Open **Photobooth QR** from device settings. This sets `PhotoboothStreamActive` while the QR is visible so `webrtcd` can accept direct `POST /stream`.

## Phone

1. Use the **default camera app** (not Connect’s Add Device scanner).
2. Scan the QR → browser opens `?body=<device-lan-ip>&photobooth=1` on dev Connect.
3. Photobooth should connect over LAN. If it fails, open desktop **DevTools → Console** and look for `[photobooth] direct POST http://…:5001/stream` and any `direct fetch failed` / `non-OK` lines.

## Teardown

- Closing the Photobooth QR screen on the device clears `PhotoboothStreamActive`. Going onroad also clears it via params metadata.
