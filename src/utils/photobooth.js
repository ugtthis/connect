import { athena as Athena } from '@commaai/api';
import { asyncSleep } from '.';

const VIDEO_STREAM_NAME = 'camera';
// Literal must match openpilot ``webrtcd.STREAM_PURPOSE_PHOTOBOOTH`` (Athena forwards the same string).
const PHOTOBOOTH_STREAM_PURPOSE = 'photobooth';
const PHOTOBOOTH_COUNTDOWN_EVENT_TYPE = 'photoboothCountdownStart';
const PHOTOBOOTH_COUNTDOWN_SOUND_REQUEST = 'photoboothCountdownStart';

export class PhotoboothConnection {
  constructor(callbacks) {
    this.pc = null;
    this.dc = null;
    this.callbacks = callbacks;
  }

  async connectDirect(address) {
    this.directAddress = address;
    return this.connect(null);
  }

  async connect(dongleId) {
    this.cleanup();
    this.callbacks.onConnectionState('connecting');
    const t0 = performance.now();
    const log = (msg) => console.log(`[photobooth +${(performance.now() - t0).toFixed(0)}ms] ${msg}`);

    try {
      this.pc = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
        iceTransportPolicy: 'all',
        bundlePolicy: 'max-bundle',
        rtcpMuxPolicy: 'require',
        encodedInsertableStreams: true,
      });

      this.pc.addEventListener('track', (evt) => {
        if (evt.track.kind === 'video') {
          if (evt.receiver) {
            if ('playoutDelayHint' in evt.receiver) {
              evt.receiver.playoutDelayHint = 0;
            }
            if ('jitterBufferTarget' in evt.receiver) {
              evt.receiver.jitterBufferTarget = 0;
            }
          }
          const stream = new MediaStream([evt.track]);
          this.callbacks.onVideoTrack(VIDEO_STREAM_NAME, stream);
        }
      });

      this.pc.addEventListener('connectionstatechange', () => {
        if (!this.pc) return;
        const state = this.pc.connectionState;
        if (state === 'connected') {
          this.callbacks.onStatusMessage?.('Receiving video...');
          this.callbacks.onConnectionState('connected');
        } else if (state === 'failed' || state === 'closed') this.callbacks.onConnectionState('failed');
      });

      const codecs = RTCRtpReceiver.getCapabilities('video')?.codecs || [];
      const h264Codecs = codecs.filter((c) => c.mimeType === 'video/H264');
      const transceiver = this.pc.addTransceiver('video', { direction: 'recvonly' });
      if (h264Codecs.length > 0) {
        transceiver.setCodecPreferences(h264Codecs);
      }
      this.dc = this.pc.createDataChannel('data', { ordered: true });
      this.dc.onopen = () => {};
      this.dc.onclose = () => {};
      this.dc.onmessage = (evt) => {
        try {
          const msg = JSON.parse(typeof evt.data === 'string' ? evt.data : new TextDecoder().decode(evt.data));
          if (msg.type === 'connectionReplaced') this.callbacks.onConnectionReplaced?.(msg.data);
        } catch (e) {
          console.warn('photobooth: ignoring malformed data-channel message', e);
        }
      };

      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      this.callbacks.onStatusMessage?.('Preparing connection...');

      await Promise.race([
        new Promise((resolve) => {
          if (this.pc.iceGatheringState === 'complete') return resolve();
          let onCandidate; let onComplete;
          onCandidate = (evt) => {
            if (evt.candidate) {
              this.callbacks.onStatusMessage?.('Finding network path...');
              this.pc.removeEventListener('icecandidate', onCandidate);
              this.pc.removeEventListener('icegatheringstatechange', onComplete);
              resolve();
            }
          };
          onComplete = () => {
            if (this.pc.iceGatheringState === 'complete') {
              this.pc.removeEventListener('icecandidate', onCandidate);
              this.pc.removeEventListener('icegatheringstatechange', onComplete);
              resolve();
            }
          };
          this.pc.addEventListener('icecandidate', onCandidate);
          this.pc.addEventListener('icegatheringstatechange', onComplete);
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('ICE gathering timed out')), 5000)),
      ]);

      await asyncSleep(250);
      const sdp = this.pc.localDescription.sdp.replace(
        /(m=(audio|video) .*\r?\n)([\s\S]*?)(?=m=|$)/g,
        (block) => (block.includes('a=rtcp-mux') ? block : block.replace(/(m=(?:audio|video) [^\n]*\n)/, '$1a=rtcp-mux\r\n')),
      );
      this.callbacks.onStatusMessage?.('Reaching device...');

      let answerSdp;
      if (dongleId) {
        const payload = {
          method: 'startPhotoboothStream',
          params: { sdp, purpose: PHOTOBOOTH_STREAM_PURPOSE },
          jsonrpc: '2.0',
          id: 0,
        };
        const resp = await Athena.postJsonRpcPayload(dongleId, payload);
        if (!resp?.result || resp.error) {
          throw new Error(resp?.error?.message || 'Could not start photobooth stream. Is the device offroad and online?');
        }
        this.callbacks.onStatusMessage?.('Device responded');
        answerSdp = resp.result.sdp;
      } else if (this.directAddress) {
        const streamUrl = `http://${this.directAddress}:5001/stream`;
        log(`direct POST ${streamUrl}`);
        let resp;
        try {
          resp = await fetch(streamUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sdp,
              cameras: ['driver'],
              bridge_services_in: ['soundRequest'],
              bridge_services_out: [],
              purpose: PHOTOBOOTH_STREAM_PURPOSE,
            }),
          });
        } catch (e) {
          console.warn('[photobooth] direct fetch failed', streamUrl, e);
          throw new Error('Could not reach device.');
        }
        if (!resp.ok) {
          const errBody = await resp.text().catch(() => '');
          console.warn('[photobooth] direct /stream non-OK', resp.status, streamUrl, errBody.slice(0, 300));
          throw new Error(`Device experienced an error (${resp.status})`);
        }
        this.callbacks.onStatusMessage?.('Device responded');
        const result = await resp.json();
        answerSdp = result.sdp;
      } else {
        throw new Error('No dongle id or direct address for photobooth.');
      }

      await this.pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
      this.callbacks.onStatusMessage?.('Establishing connection...');
    } catch (err) {
      log(err);
      this.cleanup();
      this.callbacks.onConnectionState('failed');
      throw err;
    }
  }

  _sendDc(type, data) {
    if (this.dc?.readyState === 'open') {
      this.dc.send(JSON.stringify({ type, data }));
      return true;
    }
    return false;
  }

  async playSound(sound) {
    if (!this._sendDc('soundRequest', { sound })) {
      throw new Error('Photobooth sound requires an active connection.');
    }
  }

  async startCountdown(seconds = 3, sound = 'countdown') {
    const secs = Math.min(10, Math.max(1, Number(seconds) || 3));
    if (!this._sendDc(PHOTOBOOTH_COUNTDOWN_EVENT_TYPE, { seconds: secs })) {
      throw new Error('Photobooth countdown requires an active connection.');
    }
    if (!this._sendDc('soundRequest', { sound: PHOTOBOOTH_COUNTDOWN_SOUND_REQUEST })) {
      throw new Error('Photobooth countdown requires an active connection.');
    }
    if (typeof sound === 'string' && sound.length > 0) {
      await this.playSound(sound);
    }
  }

  disconnect() {
    this.cleanup();
    this.callbacks.onConnectionState('disconnected');
  }

  cleanup() {
    if (this.dc) {
      this.dc.close();
      this.dc = null;
    }
    if (this.pc) {
      if (this.pc.getTransceivers) {
        this.pc.getTransceivers().forEach((t) => {
          if (t.stop) t.stop();
        });
      }
      this.pc.close();
      this.pc = null;
    }
  }
}
