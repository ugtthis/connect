import React from 'react';

const PhotoGrid = ({ photos }) => (
  <div className="grid grid-cols-2 gap-2 p-2 w-full max-w-lg mx-auto">
    {[0, 1, 2, 3].map((i) => (
      <div
        key={i}
        className="aspect-video bg-white/5 rounded-lg overflow-hidden flex items-center justify-center border border-white/10"
      >
        {photos[i] ? (
          <img src={photos[i]} alt="" className="w-full h-full object-cover" />
        ) : (
          <span className="text-white/30 text-sm">{i + 1}</span>
        )}
      </div>
    ))}
  </div>
);

export default PhotoGrid;
