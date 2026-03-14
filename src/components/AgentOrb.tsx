import React, { useEffect, useState } from 'react';

export type AgentStatusType = 'disconnected' | 'connected' | 'speaking' | 'thinking';

interface AgentOrbProps {
  status: AgentStatusType;
}

export const AgentOrb: React.FC<AgentOrbProps> = ({ status }) => {
  const [layers, setLayers] = useState([
    { scale: 1, opacity: 0.3, borderRadius: '50% 50% 50% 50% / 50% 50% 50% 50%', rotation: 0, x: 0, y: 0 },
    { scale: 0.8, opacity: 0.5, borderRadius: '50% 50% 50% 50% / 50% 50% 50% 50%', rotation: 0, x: 0, y: 0 },
    { scale: 0.5, opacity: 0.8, borderRadius: '50% 50% 50% 50% / 50% 50% 50% 50%', rotation: 0, x: 0, y: 0 },
  ]);

  useEffect(() => {
    if (status === 'disconnected') return;
    
    // Generates a random organic border radius to avoid perfect circles
    const getRandomRadius = (variance: number) => {
      const g = () => Math.floor(50 + (Math.random() * variance * 2 - variance));
      return `${g()}% ${g()}% ${g()}% ${g()}% / ${g()}% ${g()}% ${g()}% ${g()}%`;
    };

    const interval = setInterval(() => {
      setLayers((prev) => prev.map((layer, i) => {
        const offsetMultiplier = i === 0 ? 1 : i === 1 ? 0.6 : 0.3;
        
        if (status === 'speaking') {
          // More movement, stretching, organic shape changes and rotation when speaking
          return {
            scale: 0.8 + Math.random() * 0.5 - (i * 0.1),
            opacity: 0.5 + Math.random() * 0.4,
            borderRadius: getRandomRadius(35),
            rotation: layer.rotation + (Math.random() * 60 - 30),
            x: (Math.random() * 24 - 12) * offsetMultiplier,
            y: (Math.random() * 24 - 12) * offsetMultiplier,
          };
        } else if (status === 'thinking') {
          // Asymmetric slow morphs while thinking
          return {
            scale: 0.9 + Math.random() * 0.3 - (i * 0.1),
            opacity: 0.4 + Math.random() * 0.3,
            borderRadius: getRandomRadius(40),
            rotation: layer.rotation + (Math.random() * 30 - 15),
            x: (Math.random() * 12 - 6) * offsetMultiplier,
            y: (Math.random() * 12 - 6) * offsetMultiplier,
          };
        } else {
          // Gentle organic morphing for idle connected state
          return {
            scale: 0.9 + Math.random() * 0.15 - (i * 0.1),
            opacity: 0.3 + Math.random() * 0.2,
            borderRadius: getRandomRadius(25),
            rotation: layer.rotation + (Math.random() * 15 - 7.5),
            x: (Math.random() * 8 - 4) * offsetMultiplier,
            y: (Math.random() * 8 - 4) * offsetMultiplier,
          };
        }
      }));
    }, status === 'speaking' ? 400 : status === 'thinking' ? 1200 : 2000);

    return () => clearInterval(interval);
  }, [status]);

  let baseColor = 'bg-zinc-400';
  let containerScale = 'scale-50 opacity-0';

  switch (status) {
    case 'disconnected':
      baseColor = 'bg-zinc-300';
      containerScale = 'scale-50 opacity-0';
      break;
    case 'connected':
      baseColor = 'bg-sky-400';
      containerScale = 'scale-100 opacity-70';
      break;
    case 'speaking':
      baseColor = 'bg-teal-400';
      containerScale = 'scale-105 opacity-90';
      break;
    case 'thinking':
      baseColor = 'bg-indigo-400';
      containerScale = 'scale-95 opacity-80';
      break;
  }

  const transitionDuration = status === 'speaking' ? 'duration-[400ms]' : status === 'thinking' ? 'duration-[1200ms]' : 'duration-[2000ms]';

  return (
    <div className={`relative flex items-center justify-center w-32 h-32 transition-all duration-1000 ${containerScale}`} title={`Agent Status: ${status}`}>
      {/* Soft decaying organic layers */}
      <div 
        className={`absolute w-24 h-24 blur-[20px] transition-all ease-in-out ${baseColor} ${transitionDuration}`}
        style={{ 
          transform: `translate(${layers[0].x}px, ${layers[0].y}px) scale(${layers[0].scale}) rotate(${layers[0].rotation}deg)`, 
          opacity: layers[0].opacity,
          borderRadius: layers[0].borderRadius
        }}
      />
      <div 
        className={`absolute w-16 h-16 blur-xl transition-all ease-in-out ${baseColor} ${transitionDuration}`}
        style={{ 
          transform: `translate(${layers[1].x}px, ${layers[1].y}px) scale(${layers[1].scale}) rotate(${layers[1].rotation}deg)`, 
          opacity: layers[1].opacity,
          borderRadius: layers[1].borderRadius
        }}
      />
      <div 
        className={`absolute w-8 h-8 blur-lg transition-all ease-in-out ${baseColor} ${transitionDuration}`}
        style={{ 
          transform: `translate(${layers[2].x}px, ${layers[2].y}px) scale(${layers[2].scale}) rotate(${layers[2].rotation}deg)`, 
          opacity: layers[2].opacity,
          borderRadius: layers[2].borderRadius
        }}
      />
      
      {/* Core resting dot */}
      <div className={`absolute w-3 h-3 blur-[2px] transition-colors duration-1000 ${baseColor} opacity-90`} style={{ borderRadius: '50%' }} />
    </div>
  );
};
