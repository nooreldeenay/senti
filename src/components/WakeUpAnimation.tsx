import React, { useEffect, useState } from 'react';

interface WakeUpAnimationProps {
  onComplete?: () => void;
}

export const WakeUpAnimation: React.FC<WakeUpAnimationProps> = ({ onComplete }) => {
  const [isAnimating, setIsAnimating] = useState(true);

  useEffect(() => {
    const timer = setTimeout(() => {
      setIsAnimating(false);
      onComplete?.();
    }, 2800);
    return () => clearTimeout(timer);
  }, [onComplete]);

  if (!isAnimating) return null;

  return (
    <div className="fixed inset-0 z-100 pointer-events-none overflow-hidden animate-vignette">
      {/* Edge Blobs - Sky/Indigo/Teal Palette */}
      <div className="absolute inset-0">
        {/* Top Edge */}
        <div 
          className="absolute top-0 left-1/2 -translate-x-1/2 w-[120vw] h-[40vh] bg-linear-to-b from-sky-400/30 to-transparent blur-[100px] animate-edge"
          style={{ borderRadius: '0 0 50% 50%' }}
        />
        
        {/* Bottom Edge */}
        <div 
          className="absolute bottom-0 left-1/2 -translate-x-1/2 w-[120vw] h-[40vh] bg-linear-to-t from-indigo-400/30 to-transparent blur-[100px] animate-edge"
          style={{ borderRadius: '50% 50% 0 0', animationDelay: '200ms' }}
        />

        {/* Left Edge */}
        <div 
          className="absolute left-0 top-1/2 -translate-y-1/2 h-[120vh] w-[40vw] bg-linear-to-r from-teal-400/30 to-transparent blur-[100px] animate-edge"
          style={{ borderRadius: '0 50% 50% 0', animationDelay: '400ms' }}
        />

        {/* Right Edge */}
        <div 
          className="absolute right-0 top-1/2 -translate-y-1/2 h-[120vh] w-[40vw] bg-linear-to-l from-sky-400/30 to-transparent blur-[100px] animate-edge"
          style={{ borderRadius: '50% 0 0 50%', animationDelay: '600ms' }}
        />
      </div>

      {/* Scattered Organic Lifeforms towards edges */}
      {[...Array(6)].map((_, i) => (
        <div 
          key={i}
          className={`absolute w-[30vw] h-[30vw] blur-[80px] animate-edge ${
            i % 3 === 0 ? 'bg-sky-400/20' : i % 3 === 1 ? 'bg-teal-400/20' : 'bg-indigo-400/20'
          }`}
          style={{ 
            left: i < 3 ? '-10%' : '80%',
            top: `${(i % 3) * 35}%`,
            animationDelay: `${i * 150}ms`,
            borderRadius: '40% 60% 70% 30% / 50% 30% 70% 50%',
            transform: `rotate(${i * 45}deg)`
          }}
        />
      ))}
    </div>
  );
};
