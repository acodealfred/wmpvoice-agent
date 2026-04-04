import { useEffect, useRef, useState, useCallback } from "react";

export interface EmotionResult {
  emotion: string;
  confidence: number;
  allEmotions?: { type: string; confidence: number }[];
}

interface UseVideoCaptureProps {
  onEmotionDetected?: (emotion: EmotionResult) => void;
  analyzeInterval?: number;
}

export function useVideoCapture({ onEmotionDetected, analyzeInterval = 3000 }: UseVideoCaptureProps = {}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [currentEmotion, setCurrentEmotion] = useState<EmotionResult | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const streamRef = useRef<MediaStream | null>(null);
  const intervalRef = useRef<number | null>(null);

  const startVideo = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ 
        video: { width: 640, height: 480, facingMode: "user" } 
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
        setIsStreaming(true);
      }
    } catch (error) {
      console.error("Error starting video:", error);
    }
  }, []);

  const stopVideo = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setIsStreaming(false);
    setCurrentEmotion(null);
  }, []);

  const captureFrame = useCallback((): string | null => {
    if (!videoRef.current || !canvasRef.current) return null;
    
    const video = videoRef.current;
    const canvas = canvasRef.current;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    
    ctx.drawImage(video, 0, 0);
    return canvas.toDataURL("image/jpeg", 0.8);
  }, []);

  const analyzeFrame = useCallback(async () => {
    if (!isAnalyzing || !captureFrame()) return;
    
    const imageData = captureFrame();
    if (!imageData) return;
    
    try {
      const response = await fetch("/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: imageData })
      });
      
      if (response.ok) {
        const result: EmotionResult = await response.json();
        setCurrentEmotion(result);
        onEmotionDetected?.(result);
      }
    } catch (error) {
      console.error("Error analyzing frame:", error);
    }
  }, [captureFrame, isAnalyzing, onEmotionDetected]);

  const startAnalysis = useCallback(() => {
    setIsAnalyzing(true);
  }, []);

  const stopAnalysis = useCallback(() => {
    setIsAnalyzing(false);
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (isAnalyzing && isStreaming) {
      intervalRef.current = window.setInterval(analyzeFrame, analyzeInterval);
    }
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [isAnalyzing, isStreaming, analyzeFrame, analyzeInterval]);

  useEffect(() => {
    return () => {
      stopVideo();
    };
  }, [stopVideo]);

  return {
    videoRef,
    canvasRef,
    isStreaming,
    currentEmotion,
    isAnalyzing,
    startVideo,
    stopVideo,
    startAnalysis,
    stopAnalysis,
    analyzeFrame
  };
}
