import React from 'react';
import { Button } from '@material-ui/core';

const PhotoActions = ({ onRetake, onClose }) => (
  <div className="flex gap-3 justify-center p-4">
    <Button variant="contained" className="bg-white text-gray-900" onClick={onRetake}>
      Retake all
    </Button>
    <Button variant="outlined" className="text-white border-white/40" onClick={onClose}>
      Done
    </Button>
  </div>
);

export default PhotoActions;
