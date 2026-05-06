import React, { useState, useEffect, useRef, useCallback } from 'react';
import { connect } from 'react-redux';
import Obstruction from 'obstruction';
import { IconButton, Typography, Button } from '@material-ui/core';
import { athena as Athena } from '@commaai/api';

import { ArrowBackBold } from '../../icons';
import { deviceNamePretty } from '../../utils';
import { PhotoboothConnection } from '../../utils/photobooth';
import PhotoboothVideo from './PhotoboothVideo';
import CaptureCountdown from './CaptureCountdown';
import PhotoGrid from './PhotoGrid';
import PhotoActions from './PhotoActions';

const progressMap = {
  'Preparing connection...': 10,
  'Finding network path...': 20,
  'Reaching device...': 30,
  'Device responded': 85,
  'Establishing connection...': 92,
  'Receiving video...': 97,
};

/** Built-in sound keys accepted by openpilot soundd via webrtcd → soundRequest. */
export const PHOTOBOOTH_SHUTTER_SOUND = 'engage';

async function postStopPhotobooth(dongleId) {
  if (!dongleId) return;
  try {
    await Athena.postJsonRpcPayload(dongleId, {
      method: 'stopPhotoboothStream',
      params: {},
      jsonrpc: '2.0',
      id: 0,
    });
  } catch (e) {
    console.warn('stopPhotoboothStream', e);
  }
}

function captureFromVideo(video) {
  if (!video || !video.videoWidth) return null;
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);
  return canvas.toDataURL('image/png');
}

function capturePreviewPlaceholder(index) {
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 360;
  const ctx = canvas.getContext('2d');
  const hue = (index * 70) % 360;
  ctx.fillStyle = `hsl(${hue}, 40%, 30%)`;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = 'white';
  ctx.font = '48px sans-serif';
  ctx.fillText(`Preview ${index + 1}`, 80, 200);
  return canvas.toDataURL('image/png');
}

const Photobooth = ({
  dongleId, device, directAddress, onClose, previewUi = false,
}) => {
  const [phase, setPhase] = useState('idle');
  const [connectionState, setConnectionState] = useState('disconnected');
  const [statusMessage, setStatusMessage] = useState(null);
  const [connectProgress, setConnectProgress] = useState(0);
  const [error, setError] = useState(null);
  const [photos, setPhotos] = useState([]);
  const [countdownActive, setCountdownActive] = useState(false);
  const [countdownEpoch, setCountdownEpoch] = useState(0);

  const videoRef = useRef(null);
  const streamsRef = useRef({});
  const connectionRef = useRef(null);
  const shotRef = useRef(0);
  const phaseRef = useRef('idle');
  const previewFromUrl = new URLSearchParams(window.location.search).get('previewPhotobooth') === '1';
  const previewMode = previewUi || previewFromUrl;

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  useEffect(() => {
    const conn = new PhotoboothConnection({
      onConnectionState: (state) => {
        setConnectionState(state);
        if (state !== 'connecting') {
          setStatusMessage(null);
          setConnectProgress(0);
        }
      },
      onStatusMessage: (msg) => {
        setStatusMessage(msg);
        setConnectProgress(progressMap[msg] || 0);
      },
      onConnectionReplaced: (data) => {
        setError(data || 'Connection replaced');
        setConnectionState('failed');
        conn.cleanup();
      },
      onVideoTrack: (_cameraName, stream) => {
        streamsRef.current.camera = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }
      },
    });
    connectionRef.current = conn;
    const onBeforeUnload = () => {
      conn.cleanup();
      if (!directAddress) {
        postStopPhotobooth(dongleId);
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      conn.cleanup();
      if (!directAddress) {
        postStopPhotobooth(dongleId);
      }
    };
  }, [dongleId, directAddress]);

  const runChecksAndConnect = useCallback(async () => {
    if (previewMode) {
      setPhase('ready');
      setConnectionState('connected');
      return;
    }
    setError(null);

    if (directAddress) {
      setPhase('connecting');
      try {
        const conn = connectionRef.current;
        await conn.connectDirect(directAddress);
        setPhase('waiting_video');
      } catch (err) {
        setError(err.message);
        setPhase('failed');
        setConnectionState('failed');
      }
      return;
    }

    setPhase('checking');
    try {
      const payload = {
        method: 'getPhotoboothState',
        params: {},
        jsonrpc: '2.0',
        id: 0,
      };
      const resp = await Athena.postJsonRpcPayload(dongleId, payload);
      if (resp.error) {
        throw new Error(resp.error.message || 'Could not read photobooth state');
      }
      const st = resp.result || {};
      if (!st.ready) {
        const reason = st.reason === 'device_onroad'
          ? 'Photobooth works when parked/offroad.'
          : (st.reason === 'unsupported_device'
            ? 'This device does not support Photobooth.'
            : 'Photobooth is not available.');
        throw new Error(reason);
      }
      setPhase('connecting');
      const conn = connectionRef.current;
      await conn.connect(dongleId);
      setPhase('waiting_video');
    } catch (err) {
      setError(err.message);
      setPhase('failed');
      setConnectionState('failed');
    }
  }, [dongleId, directAddress, previewMode]);

  useEffect(() => {
    if (previewMode) {
      setPhase('ready');
      setConnectionState('connected');
      return undefined;
    }
    runChecksAndConnect();
    return undefined;
  }, [previewMode, runChecksAndConnect]);

  useEffect(() => {
    if (previewMode || phase !== 'waiting_video') return undefined;
    const v = videoRef.current;
    if (!v) return undefined;
    const tick = () => {
      if (v.videoWidth > 0 && connectionState === 'connected') {
        setPhase('ready');
      }
    };
    const id = setInterval(tick, 200);
    tick();
    return () => clearInterval(id);
  }, [phase, connectionState, previewMode]);

  const handleClose = useCallback(() => {
    connectionRef.current?.disconnect();
    if (!directAddress) {
      postStopPhotobooth(dongleId);
    }
    onClose?.();
  }, [dongleId, onClose, directAddress]);

  const handleTestSound = useCallback(async () => {
    if (previewMode) return;
    try {
      await connectionRef.current?.playSound(PHOTOBOOTH_SHUTTER_SOUND);
    } catch (e) {
      console.warn('playSound', e);
      setError(e.message);
    }
  }, [previewMode]);

  const startSyncedCountdown = useCallback(async () => {
    if (!previewMode) {
      await connectionRef.current?.startCountdown(3, null);
    }
    setCountdownEpoch((e) => e + 1);
    setCountdownActive(true);
  }, [previewMode]);

  const beginCaptureLoop = useCallback(async () => {
    setPhotos([]);
    shotRef.current = 0;
    setPhase('capturing');
    try {
      await startSyncedCountdown();
    } catch (e) {
      setError(e.message);
      setPhase('failed');
    }
  }, [startSyncedCountdown]);

  const fireShot = useCallback(async () => {
    const idx = shotRef.current;
    try {
      if (previewMode) {
        const url = capturePreviewPlaceholder(idx);
        setPhotos((p) => {
          const next = [...p];
          next[idx] = url;
          return next;
        });
      } else {
        const url = captureFromVideo(videoRef.current);
        if (!url) throw new Error('Video not ready for capture.');
        setPhotos((p) => {
          const next = [...p];
          next[idx] = url;
          return next;
        });
        try {
          await connectionRef.current?.playSound(PHOTOBOOTH_SHUTTER_SOUND);
        } catch (e) {
          console.warn('playSound', e);
        }
      }

      if (idx >= 3) {
        setPhase('complete');
        return;
      }
      shotRef.current = idx + 1;
      await startSyncedCountdown();
    } catch (e) {
      setError(e.message);
      setPhase('failed');
    }
  }, [previewMode, startSyncedCountdown]);

  const onCountdownDone = useCallback(() => {
    setCountdownActive(false);
    if (phaseRef.current === 'capturing') {
      void fireShot();
    }
  }, [fireShot]);

  const deviceName = directAddress || (device ? deviceNamePretty(device) : 'Photobooth');

  const videoProps = {
    videoRef,
    connectionState: previewMode ? 'connected' : connectionState,
    error,
    statusMessage,
    connectProgress,
    onConnect: runChecksAndConnect,
  };

  return (
    <div className="fixed inset-0 z-[1300] bg-[#030404] flex flex-col">
      <div className="flex items-center px-3 py-2 bg-[#151819] border-b border-white/10 min-h-[48px] z-10">
        <IconButton className="text-white p-2" onClick={handleClose}>
          <ArrowBackBold style={{ fontSize: 20 }} />
        </IconButton>
        <Typography className="text-base font-medium ml-2 flex-1">{deviceName}</Typography>
        {previewMode && (
          <div className="rounded-[20px] px-3 py-1 text-xs font-medium text-sky-100 bg-sky-500/25 border border-sky-300/30">
            Preview mode
          </div>
        )}
      </div>

      <div className="relative flex-1 flex flex-col overflow-hidden">
        <div className="relative flex-1 min-h-0 flex items-center justify-center bg-[#030404]">
          <PhotoboothVideo {...videoProps} />
          <CaptureCountdown active={countdownActive} epoch={countdownEpoch} onDone={onCountdownDone} />
        </div>

        {phase === 'ready' && (
          <div className="p-4 flex justify-center gap-3 border-t border-white/10">
            <Button variant="contained" className="bg-white text-gray-900" onClick={() => void beginCaptureLoop()}>
              Start 4 photos
            </Button>
            {!previewMode && (
              <Button variant="outlined" className="text-white border-white/40" onClick={() => void handleTestSound()}>
                Test sound
              </Button>
            )}
          </div>
        )}

        {phase === 'complete' && (
          <>
            <PhotoGrid photos={photos} />
            <PhotoActions
              onRetake={() => {
                setPhotos([]);
                setPhase('ready');
                shotRef.current = 0;
              }}
              onClose={handleClose}
            />
          </>
        )}

        {phase === 'checking' && (
          <div className="text-center text-white/60 text-sm py-2">Checking device…</div>
        )}
      </div>
    </div>
  );
};

const stateToProps = Obstruction({
  dongleId: 'dongleId',
  device: 'device',
});

export default connect(stateToProps)(Photobooth);
