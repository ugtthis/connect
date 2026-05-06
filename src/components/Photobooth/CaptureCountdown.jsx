import React, { useEffect, useState } from 'react';

/** Shows 3, 2, 1 over `durationSec` total (one second per tick by default). */
const CaptureCountdown = ({ active, epoch, onDone }) => {
  const [n, setN] = useState(3);

  useEffect(() => {
    if (!active) {
      setN(3);
      return undefined;
    }
    setN(3);
    let cur = 3;
    const id = setInterval(() => {
      cur -= 1;
      if (cur <= 0) {
        clearInterval(id);
        onDone();
        return;
      }
      setN(cur);
    }, 1000);
    return () => clearInterval(id);
  }, [active, epoch, onDone]);

  if (!active) return null;

  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center pointer-events-none bg-black/40">
      <div className="text-7xl font-bold text-white drop-shadow-lg tabular-nums">
        {n}
      </div>
    </div>
  );
};

export default CaptureCountdown;
